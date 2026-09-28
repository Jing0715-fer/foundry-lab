// 文本精灵（标签、测量值）
import * as THREE from 'three'

const textureCache = new Map<string, { tex: THREE.CanvasTexture; w: number; h: number }>()

function makeTexture(text: string, opts: { color?: string; outline?: string; fontSize?: number }) {
  const key = `${text}|${opts.color ?? ''}|${opts.outline ?? ''}|${opts.fontSize ?? 40}`
  const cached = textureCache.get(key)
  if (cached) return cached
  const fontSize = opts.fontSize ?? 40
  const pad = fontSize * 0.35
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const font = `600 ${fontSize}px "Geist", system-ui, -apple-system, sans-serif`
  ctx.font = font
  const metrics = ctx.measureText(text)
  const w = Math.ceil(metrics.width + pad * 2)
  const h = Math.ceil(fontSize + pad * 2)
  canvas.width = w
  canvas.height = h
  const ctx2 = canvas.getContext('2d')!
  ctx2.font = font
  ctx2.textAlign = 'center'
  ctx2.textBaseline = 'middle'
  if (opts.outline) {
    ctx2.lineWidth = fontSize * 0.16
    ctx2.strokeStyle = opts.outline
    ctx2.strokeText(text, w / 2, h / 2)
  }
  ctx2.fillStyle = opts.color ?? '#ffffff'
  ctx2.fillText(text, w / 2, h / 2)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  const rec = { tex, w, h }
  textureCache.set(key, rec)
  return rec
}

export function makeTextSprite(
  text: string,
  worldHeight: number,
  opts: { color?: string; outline?: string; fontSize?: number } = {},
): THREE.Sprite {
  const { tex, w, h } = makeTexture(text, opts)
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set((worldHeight * w) / h, worldHeight, 1)
  sprite.renderOrder = 20
  return sprite
}

export function disposeSprite(sprite: THREE.Sprite) {
  const mat = sprite.material as THREE.SpriteMaterial
  // 纹理有缓存，不单独 dispose
  mat.dispose()
}
