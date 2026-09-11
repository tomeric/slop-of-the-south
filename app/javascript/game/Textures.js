import * as THREE from "three"
import { mulberry32 } from "game/Tuning"

// Procedural canvas textures, drawn once and tiled at their real size. `texture(metresPerTile, draw)` sets the
// repeat to 1 / metresPerTile, so any geometry whose UV is in metres wears the pattern at the right scale with no
// unwrapping: a wall, a road and a roof all use the same map without knowing anything about each other.
// Everything is drawn from a seeded generator, so a texture is the same on every machine and between reloads.
// Nothing here touches the renderer, so a module may build its maps at import time.
const ANISOTROPY = 4                                  // the house setting; matches Cover.js, Roads.js and Signs.js

export function canvas(size, draw) {
  const c = document.createElement("canvas")
  c.width = c.height = size
  draw(c.getContext("2d"), size)
  return c
}

export function texture(metresPerTile, draw, size = 512) {
  const map = new THREE.CanvasTexture(canvas(size, draw))
  map.wrapS = map.wrapT = THREE.RepeatWrapping
  map.repeat.set(1 / metresPerTile, 1 / metresPerTile)
  map.colorSpace = THREE.SRGBColorSpace
  map.anisotropy = ANISOTROPY
  map.__shared = true
  return map
}

// a drawing repeated at the eight wrapped positions as well, so whatever it puts near an edge comes back on the
// other side and the tile has no seam
export function wrapped(ctx, size, fn) {
  for (const dx of [-size, 0, size]) for (const dy of [-size, 0, size]) {
    ctx.save(); ctx.translate(dx, dy); fn(); ctx.restore()
  }
}

export const grey = (v, a = 1) => `rgba(${v | 0},${v | 0},${v | 0},${a})`
export const rng = (seed) => mulberry32(seed)

// a flat ground of `base` grey with `count` blocks of noise scattered over it
export function speckle(ctx, size, base, spread, count, blob, rnd) {
  ctx.fillStyle = grey(base)
  ctx.fillRect(0, 0, size, size)
  grain(ctx, size, base, spread, count, blob, rnd)
}

// the same without the ground: the fine layer that goes on top of anything
export function grain(ctx, size, base, spread, count, blob, rnd, alpha = 0.6) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = grey(base + (rnd() - 0.5) * spread, alpha)
    const r = blob * (0.5 + rnd())
    wrapped(ctx, size, () => ctx.fillRect(rnd() * size, rnd() * size, r, r))
  }
}

// random walks: the hairline cracks in asphalt and paving
export function cracks(ctx, size, count, shade, rnd) {
  ctx.strokeStyle = grey(shade, 0.7)
  for (let i = 0; i < count; i++) {
    let x = rnd() * size, y = rnd() * size, angle = rnd() * Math.PI * 2
    ctx.lineWidth = 1 + rnd() * 1.5
    const steps = Array.from({ length: 10 }, () => { angle += (rnd() - 0.5) * 1.4; x += Math.cos(angle) * 12; y += Math.sin(angle) * 12; return [x, y] })
    wrapped(ctx, size, () => { ctx.beginPath(); ctx.moveTo(steps[0][0], steps[0][1]); for (const [px, py] of steps) ctx.lineTo(px, py); ctx.stroke() })
  }
}

// grass seen from above: short curved strokes, light on dark
export function blades(ctx, size, count, rnd) {
  for (let i = 0; i < count; i++) {
    const x = rnd() * size, y = rnd() * size, h = 5 + rnd() * 12, lean = (rnd() - 0.5) * 6
    ctx.strokeStyle = grey(140 + rnd() * 115, 0.85)
    ctx.lineWidth = 1 + rnd() * 1.2
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.quadraticCurveTo(x + lean / 2, y - h / 2, x + lean, y - h)
    ctx.stroke()
  }
}

// A running bond: `rows` courses of `cols` bricks, every other course shifted half a brick. Both counts divide the
// canvas exactly and the row offset repeats every two courses, so the tile wraps. Each brick gets its own colour
// from the palette, a lit top edge, a shaded bottom one and a few dark specks.
export function bricks(ctx, size, { mortar, palette, rows = 32, cols = 10, rnd }) {
  ctx.fillStyle = mortar
  ctx.fillRect(0, 0, size, size)
  grain(ctx, size, 175, 50, Math.round(size * 10), 3, rnd, 0.35)
  const w = size / cols, h = size / rows, joint = Math.max(1.5, size / 340)
  for (let row = 0; row < rows; row++) for (let col = -1; col <= cols; col++) {
    const x = col * w + (row % 2) * w / 2 + joint, y = row * h + joint
    const bw = w - joint * 2, bh = h - joint * 2
    ctx.fillStyle = palette[Math.floor(rnd() * palette.length)]
    ctx.fillRect(x, y, bw, bh)
    ctx.fillStyle = `rgba(255,255,255,${0.06 + rnd() * 0.12})`
    ctx.fillRect(x, y, bw, Math.max(1, bh * 0.12))
    ctx.fillStyle = `rgba(0,0,0,${0.15 + rnd() * 0.2})`
    ctx.fillRect(x, y + bh - Math.max(1, bh * 0.14), bw, Math.max(1, bh * 0.12))
    for (let k = 0; k < 5; k++) { ctx.fillStyle = `rgba(0,0,0,${rnd() * 0.25})`; ctx.fillRect(x + rnd() * bw * 0.9, y + rnd() * bh * 0.7, 2 + rnd() * 3, 2) }
  }
}
