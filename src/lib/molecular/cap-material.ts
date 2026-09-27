// 切层截面封闭（slab cap）：背面渲染 + 平面色填充（可选视深明暗调制）
// 原理：rep 几何均为闭合实体（球/圆柱闭合壳、cartoon 完整 2π 截面环 + 端帽、metaball 封闭面），
// 裁剪后可见的「背面」即剖面内壁——将背面片段替换为平面色即得视觉上的实心封盖
// （PyMOL interior 风格）。透明材质（半透明表面/等值面）不参与，避免改变混合观感。
// 深度明暗：引擎每帧把场景包围盒投影到 NDC，取 z 范围 [uCapZ0, uCapZ1]；
// 封盖色乘 mix(1.06, 0.58, t)（t = 段内归一化深度）→ 近端微亮、远端明显加深，
// 剖面呈现前后层次（对深剖面/四聚体堆叠尤其有效）。
import * as THREE from 'three'

/** 共享 uniforms（所有打过补丁的材质引用同一对象，改值即时全局生效） */
export const capUniforms = {
  uCapOn: { value: 0 },
  uCapColor: { value: new THREE.Color('#ccd2d9') },
  uCapShadeOn: { value: 0 },
  uCapZ0: { value: 0 },
  uCapZ1: { value: 1 },
}

/** 当前封盖生效状态（引擎写入；buildRep 新材质据此决定 side） */
export const capState = { on: false }

/**
 * 给材质打「截面封盖」补丁：
 * - 片段着色器注入：uCapOn 开启且非正面朝向（背面）时输出封盖色
 *   （uCapShadeOn 开启时按 gl_FragCoord.z 在 [uCapZ0, uCapZ1] 段内做明暗调制）
 * - FrontSide 材质（球/棍）在封盖开启时切 DoubleSide（记录 side0 以便还原）
 * - 仅处理不透明的 MeshStandardMaterial（线材质/透明表面/高亮等一律跳过）
 */
export function patchCapMaterial(mat: THREE.Material): void {
  if (mat.userData.capPatched) return
  const std = mat as THREE.MeshStandardMaterial
  if (!std.isMeshStandardMaterial || std.transparent) return
  mat.userData.capPatched = true
  mat.userData.side0 = std.side
  const prev = std.onBeforeCompile
  std.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer)
    shader.uniforms.uCapOn = capUniforms.uCapOn
    shader.uniforms.uCapColor = capUniforms.uCapColor
    shader.uniforms.uCapShadeOn = capUniforms.uCapShadeOn
    shader.uniforms.uCapZ0 = capUniforms.uCapZ0
    shader.uniforms.uCapZ1 = capUniforms.uCapZ1
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        `uniform float uCapOn;
        uniform vec3 uCapColor;
        uniform float uCapShadeOn;
        uniform float uCapZ0;
        uniform float uCapZ1;
        void main() {`,
      )
      .replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>
        if (uCapOn > 0.5 && !gl_FrontFacing) {
          vec3 capCol = uCapColor;
          if (uCapShadeOn > 0.5) {
            float zSpan = max(uCapZ1 - uCapZ0, 1e-5);
            float t = clamp((gl_FragCoord.z - uCapZ0) / zSpan, 0.0, 1.0);
            capCol *= mix(1.06, 0.58, t);
          }
          gl_FragColor.rgb = capCol;
        }`,
      )
  }
}

/** 单个已补丁材质按封盖状态设置 side（FrontSide 材质切换双面；DoubleSide 材质不动） */
function applySide(mat: THREE.Material, on: boolean) {
  if (!mat.userData.capPatched) return
  if (mat.userData.side0 === THREE.DoubleSide) return
  const want = on ? THREE.DoubleSide : THREE.FrontSide
  if (mat.side !== want) {
    mat.side = want
    // side 变化影响 DOUBLE_SIDED 定义（背面法线翻转），需重编译
    mat.needsUpdate = true
  }
}

/** 场景级切换：遍历所有打过补丁的材质（引擎在 applySettings 与 buildRep 调用） */
export function applyCapSides(root: THREE.Object3D, on: boolean): void {
  capState.on = on
  root.traverse(o => {
    const mesh = o as THREE.Mesh
    if (!mesh.material) return
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const m of mats) applySide(m, on)
  })
}

/** 引擎入口：同步 uniform 值 + 切换场景材质 side */
export function syncCapSettings(root: THREE.Object3D, on: boolean, color: string, shading: boolean): void {
  capUniforms.uCapOn.value = on ? 1 : 0
  capUniforms.uCapColor.value.set(color)
  capUniforms.uCapShadeOn.value = on && shading ? 1 : 0
  applyCapSides(root, on)
}
