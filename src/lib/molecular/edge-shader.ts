// 出版级轮廓线（描边）后处理：三信号边缘检测 + 色调映射上屏
// ① 剪影（几何↔背景边界，mask Sobel，满强度）——论文图描边的主要来源
// ② 内部遮挡（几何↔几何的显著深度落差，高阈值弱化）——保留前后层叠暗示
// ③ 亮度边界（配色区域分界，最弱）——链着色等区域轮廓补充
// 本 pass 为 composer 末位（唯一直接上屏）：输入为线性场景色（RenderPass→rt1 / GTAO→rt2），
// 在 shader 内完成 ACES 色调映射 + sRGB 编码（吸收原 OutputPass 职责）——由此 RenderPass 之后
// 任何 pass 都不再写回 rt1，rt1.depthTexture 的场景深度全程保持完好（旧架构中 fsQuad 写入
// 挂载 depth-stencil 纹理的 rt1 会触发 GL 反馈环/INVALID_OPERATION，静默破坏颜色与深度）。
// 背景像素此时还原为用户设定色（ACES 只应作用于几何体，与直接渲染路径的 glClear 行为对齐）；
// 线色/背景色以原始 sRGB 分量传入。
import * as THREE from 'three'

/** hex（#rrggbb）→ 原始 sRGB 分量（不做 working-space 转换；着色器直接输出上屏） */
export function srgbComponents(hex: string): THREE.Vector3 {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  const v = m ? parseInt(m[1], 16) : 0xffffff
  return new THREE.Vector3(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255)
}

export const EdgeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    /** 采样步长（像素）：1=细线 3=粗线 */
    uThickness: { value: 1.5 },
    /** 内部遮挡相对深度梯度阈值（越小内部线越多） */
    uInteriorThresh: { value: 0.08 },
    /** 亮度梯度阈值（伽马空间） */
    uColorThresh: { value: 0.4 },
    /** 轮廓线开关（关闭时仅做色调映射+背景还原的直通） */
    uOutlineOn: { value: 1 },
    /** 线条不透明度倍率 */
    uStrength: { value: 1 },
    /** 线色（原始 sRGB 分量） */
    uEdgeColor: { value: srgbComponents('#1f2933') },
    /** 用户背景色（原始 sRGB 分量；背景像素还原用） */
    uBgColor: { value: srgbComponents('#ffffff') },
    /** 曝光（与 renderer.toneMappingExposure 同步） */
    uExposure: { value: 1.05 },
    uNear: { value: 0.5 },
    uFar: { value: 8000 },
    uIsOrtho: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2 uResolution;
    uniform float uThickness;
    uniform float uInteriorThresh;
    uniform float uColorThresh;
    uniform float uOutlineOn;
    uniform float uStrength;
    uniform vec3 uEdgeColor;
    uniform vec3 uBgColor;
    uniform float uExposure;
    uniform float uNear;
    uniform float uFar;
    uniform float uIsOrtho;
    varying vec2 vUv;

    /** ACES Filmic（three.js OutputShader 同款曲线）——几何体色调映射 */
    vec3 acesToneMap(vec3 color) {
      color *= uExposure;
      return clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0.0, 1.0);
    }

    /** sRGB 编码（线性 → 显示空间） */
    vec3 srgbEncode(vec3 c) {
      return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
    }

    /** 完整显示变换：ACES + sRGB（背景还原前对几何体应用） */
    vec3 displayTransform(vec3 linearColor) {
      return srgbEncode(acesToneMap(linearColor));
    }

    /** 线性化深度（透视：逆投影；正交：本就线性） */
    float getDepth(vec2 uv) {
      float d = texture2D(tDepth, uv).x;
      if (uIsOrtho > 0.5) return d;
      float z = d * 2.0 - 1.0;
      return (2.0 * uNear * uFar) / (uNear + uFar - z * (uFar - uNear));
    }

    /** 背景 mask（原始深度 ≥0.9995 视为空） */
    float isBg(vec2 uv) {
      return step(0.9995, texture2D(tDepth, uv).x);
    }

    /** 感知亮度（伽马近似：线性 luma 提到显示域，与阈值标定一致） */
    float getLuma(vec2 uv) {
      vec3 c = texture2D(tDiffuse, uv).rgb;
      return pow(max(dot(c, vec3(0.299, 0.587, 0.114)), 0.0), 1.0 / 2.2);
    }

    void main() {
      // 背景/几何体分离：几何体走完整显示变换（ACES+sRGB），背景像素还原为用户设定色
      // （直接渲染路径的 glClear 不经色调映射，两条路径背景行为保持一致）。
      // 【双重判定】仅当「深度=背景 且 颜色≈背景色」才还原：透明叠加层（密度图等值面/选择高亮/
      // 氢键与接触标记）不写深度但贡献颜色——旧版纯深度判定把它们整体还原成背景色（视觉上凭空消失），
      // 而亮度边缘检测又在它们的色彩边界上留下描边 → 导出图出现「空心鬼环」（用户反馈的小圆球伪影）。
      // 颜色比对在 linear 域进行（rt1 存线性色；uBgColor 为 sRGB 分量，pow 2.2 近似解码），
      // 阔值 0.012（≈白底 3 个 sRGB 色阶）——足够紧以保留叠加层，足够松以覆盖清屏色的精确等值。
      vec4 base = texture2D(tDiffuse, vUv);
      float bgC = isBg(vUv);
      vec3 bgLin = pow(uBgColor, vec3(2.2));
      float colorIsBg = all(lessThanEqual(abs(base.rgb - bgLin), vec3(0.012))) ? 1.0 : 0.0;
      float restore = bgC * colorIsBg;
      vec3 col = mix(displayTransform(base.rgb), uBgColor, restore);

      if (uOutlineOn < 0.5) {
        gl_FragColor = vec4(col, base.a);
        return;
      }

      vec2 texel = vec2(uThickness) / uResolution;
      // 3×3 邻域采样点
      vec2 p00 = vUv + vec2(-texel.x, -texel.y);
      vec2 p10 = vUv + vec2(0.0, -texel.y);
      vec2 p20 = vUv + vec2(texel.x, -texel.y);
      vec2 p01 = vUv + vec2(-texel.x, 0.0);
      vec2 p21 = vUv + vec2(texel.x, 0.0);
      vec2 p02 = vUv + vec2(-texel.x, texel.y);
      vec2 p12 = vUv + vec2(0.0, texel.y);
      vec2 p22 = vUv + vec2(texel.x, texel.y);

      // ① 剪影：几何↔背景边界的 mask Sobel（sobel 值域 0..4 → 归一化 0..1）
      float bgx = (isBg(p20) + 2.0 * isBg(p21) + isBg(p22)) - (isBg(p00) + 2.0 * isBg(p01) + isBg(p02));
      float bgy = (isBg(p02) + 2.0 * isBg(p12) + isBg(p22)) - (isBg(p00) + 2.0 * isBg(p10) + isBg(p20));
      float silhouette = clamp(length(vec2(bgx, bgy)) / 4.0, 0.0, 1.0);

      // ② 内部遮挡：几何间深度落差（相对中心距离，透视补偿）
      float dC = getDepth(vUv);
      float dx = (getDepth(p20) + 2.0 * getDepth(p21) + getDepth(p22)) - (getDepth(p00) + 2.0 * getDepth(p01) + getDepth(p02));
      float dy = (getDepth(p02) + 2.0 * getDepth(p12) + getDepth(p22)) - (getDepth(p00) + 2.0 * getDepth(p10) + getDepth(p20));
      float dg = length(vec2(dx, dy)) / max(dC, 1e-4);
      float interior = smoothstep(uInteriorThresh, uInteriorThresh * 2.0, dg);

      // ③ 亮度边界（配色区域分界，伽马域）
      float lx = (getLuma(p20) + 2.0 * getLuma(p21) + getLuma(p22)) - (getLuma(p00) + 2.0 * getLuma(p01) + getLuma(p02));
      float ly = (getLuma(p02) + 2.0 * getLuma(p12) + getLuma(p22)) - (getLuma(p00) + 2.0 * getLuma(p10) + getLuma(p20));
      float lg = length(vec2(lx, ly));
      float colorEdge = smoothstep(uColorThresh, uColorThresh * 2.0, lg);

      // 合成：剪影满强度 · 内部遮挡 70% · 颜色边界 50%
      float a = clamp(max(max(silhouette, interior * 0.7), colorEdge * 0.5) * uStrength, 0.0, 1.0);

      gl_FragColor = vec4(mix(col, uEdgeColor, a), base.a);
    }
  `,
}
