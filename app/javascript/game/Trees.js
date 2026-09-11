import * as THREE from "three"
import { pointKey, hideInstance } from "game/Destructibles"
import { TUNING as T } from "game/Tuning"

// Procedural low-poly trees: trunk, recursive branches and leaf clusters at the tips. A handful of variants per
// kind is generated once from fixed seeds; every tree picks its variant, rotation, width and tint from a hash of
// its position, so the same tree always stands in the same place looking the same. Tiles draw one InstancedMesh
// per variant. Tile entries: [x, z, kind, height] with kind 0 street/park tree, 1 broadleaf wood, 2 conifer. With
// `reg` every tree registers a destructible handle keyed by its position; a felled tree is a zero-scale instance.
// front faces only: leaf clusters and trunks are closed shapes, and the 8k trees around the player are the biggest
// triangle budget in the scene, so drawing their back faces too would double it
const material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 })
material.__shared = true

const VARIANTS = { 0: 6, 1: 4, 2: 3, 3: 3 }
const BARK = { 0: 0x5b4634, 1: 0x4e3d30, 2: 0x4a3226, 3: 0x5a4331 }
const LEAVES = {
  0: [0x5d8f45, 0x6a9a4a, 0x7fa64f, 0x8fa943, 0x578a3e],
  1: [0x3f6f33, 0x477a3b, 0x4f8541, 0x386428],
  2: [0x2f5a35, 0x2a5030, 0x34633a],
  3: [0x6c9a46, 0x76a24c, 0x81a952]                              // hoogstam fruit trees
}
const ICO = new THREE.IcosahedronGeometry(1, 0).attributes.position   // 20-face leaf cluster template
const HSL = { h: 0, s: 0, l: 0 }
const WHITE = new THREE.Color(0xffffff)

const geometries = {}
for (const kind of [0, 1, 2, 3]) geometries[kind] = Array.from({ length: VARIANTS[kind] }, (_, i) => buildVariant(kind, 1000 * (kind + 1) + 7 * i))

export function buildTrees(trees, heightAt, reg) {
  if (!trees?.length) return null
  const groups = new Map()
  for (const t of trees) {
    const kind = t[2] ?? 1
    const variant = Math.floor(rand(t[0], t[1]) * VARIANTS[kind])
    const key = kind * 10 + variant
    if (!groups.has(key)) groups.set(key, { geo: geometries[kind][variant], list: [], kind })
    groups.get(key).list.push(t)
  }
  const group = new THREE.Group()
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0)
  const color = new THREE.Color()
  for (const { geo, list, kind } of groups.values()) {
    const mesh = new THREE.InstancedMesh(geo, material, list.length)
    list.forEach(([x, z, , h], i) => {
      const spin = rand(z, x), width = (kind === 3 ? 1.35 : 1) * (0.85 + 0.3 * rand(x + 1, z))
      q.setFromAxisAngle(up, spin * Math.PI * 2)
      s.set(h * width, h, h * width)                           // geometry is 1 unit tall
      mesh.setMatrixAt(i, m.compose(p.set(x, heightAt(x, z) - 0.15, z), q, s))
      // Brightness alone leaves a wood looking like one tree stamped a thousand times; a little hue is what breaks
      // it up. The instance colour multiplies the leaf colour already in the vertices, so this is a pale tint around
      // white, nudged towards the kind's own hue — a conifer stand does not drift off towards meadow green.
      const J = T.trees.jitter
      color.setHex(LEAVES[kind][0]).getHSL(HSL)
      mesh.setColorAt(i, color.setHSL(HSL.h + (rand(x, z + 1) - 0.5) * J.hue, J.sat, 0.5)
        .lerp(WHITE, J.pale).multiplyScalar(J.level + (rand(x, z + 2) - 0.5) * J.light))
      reg?.(pointKey("t", x, z), { kind: "t", x, z, r: THREE.MathUtils.clamp(0.08 * h, 0.3, 1), h, max: 30, remove: () => hideInstance(mesh, i) })
    })
    mesh.instanceMatrix.needsUpdate = true
    mesh.instanceColor.needsUpdate = true
    group.add(mesh)
  }
  return group
}

// ---------------------------------------------------------------------------------------------------------------
// variant generation (deterministic per seed); geometry is scaled so the tree is exactly 1 unit tall

function buildVariant(kind, seed) {
  const rnd = mulberry32(seed)
  const out = { pos: [], col: [] }
  const bark = new THREE.Color(BARK[kind])
  const leaf = new THREE.Color(LEAVES[kind][Math.floor(rnd() * LEAVES[kind].length)])
  if (kind === 2) conifer(out, rnd, bark, leaf)
  else if (kind === 3) branch(out, rnd, new THREE.Vector3(), new THREE.Vector3(0, 1, 0), 0.42, 0.05, 0, 2, 0.2, bark, leaf)   // short trunk, broad crown
  // two levels of branching for every kind: three levels made a street tree ~750 triangles (≈6 M for the trees in view)
  else branch(out, rnd, new THREE.Vector3(), new THREE.Vector3(0, 1, 0), kind === 0 ? 0.36 : 0.3, 0.035, 0, 2, kind === 0 ? 0.16 : 0.17, bark, leaf)

  let maxY = 0
  for (let i = 1; i < out.pos.length; i += 3) maxY = Math.max(maxY, out.pos[i])
  const k = 1 / maxY
  for (let i = 0; i < out.pos.length; i++) out.pos[i] *= k

  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position", new THREE.Float32BufferAttribute(out.pos, 3))
  geo.setAttribute("color", new THREE.Float32BufferAttribute(out.col, 3))
  geo.computeVertexNormals()           // non-indexed → flat shading
  geo.__shared = true                  // reused by every tile: never dispose with a tile
  return geo
}

// broadleaf: tapered branch, then 2–3 children tilted outward; leaf clusters on the tips and inside the crown
function branch(out, rnd, origin, dir, len, radius, depth, maxDepth, leafSize, bark, leaf) {
  const end = origin.clone().addScaledVector(dir, len)
  cylinder(out, origin, end, radius, radius * (depth === maxDepth ? 0.35 : 0.65), 5, bark)
  if (depth === maxDepth) { cluster(out, rnd, end, leafSize * (0.8 + rnd() * 0.5), leaf); return }
  const n = 2 + (rnd() < 0.6 ? 1 : 0)
  const az0 = rnd() * Math.PI * 2
  for (let i = 0; i < n; i++) {
    const d = tilted(dir, az0 + i * 2 * Math.PI / n + (rnd() - 0.5) * 0.8, 0.45 + rnd() * 0.45)
    branch(out, rnd, end, d, len * (0.62 + rnd() * 0.15), radius * 0.62, depth + 1, maxDepth, leafSize, bark, leaf)
  }
  if (depth >= 1) cluster(out, rnd, end, leafSize * 0.75, leaf)
}

// conifer: full-height trunk with 4–5 stacked, slightly irregular cones
function conifer(out, rnd, bark, leaf) {
  cylinder(out, new THREE.Vector3(), new THREE.Vector3(0, 0.95, 0), 0.03, 0.006, 5, bark)
  const tiers = 4 + Math.floor(rnd() * 2)
  for (let t = 0; t < tiers; t++) {
    const y = 0.16 + t * 0.78 / tiers
    const r = 0.24 * (1 - t / (tiers + 0.6)) * (0.9 + rnd() * 0.2)
    cone(out, new THREE.Vector3((rnd() - 0.5) * 0.03, y, (rnd() - 0.5) * 0.03), r, 0.3 - t * 0.02, 7, leaf.clone().multiplyScalar(0.92 + rnd() * 0.16))
  }
}

function tilted(dir, azimuth, tilt) {
  const u = new THREE.Vector3(1, 0, 0)
  if (Math.abs(dir.x) > 0.9) u.set(0, 0, 1)
  u.cross(dir).normalize()
  const v = new THREE.Vector3().crossVectors(dir, u)
  return new THREE.Vector3().addScaledVector(dir, Math.cos(tilt))
    .addScaledVector(u, Math.cos(azimuth) * Math.sin(tilt)).addScaledVector(v, Math.sin(azimuth) * Math.sin(tilt))
    .add(new THREE.Vector3(0, 0.12, 0)).normalize()                 // branches reach upward a little
}

function cylinder(out, a, b, ra, rb, segs, color) {
  const axis = b.clone().sub(a).normalize()
  const u = new THREE.Vector3(1, 0, 0)
  if (Math.abs(axis.x) > 0.9) u.set(0, 0, 1)
  u.cross(axis).normalize()
  const v = new THREE.Vector3().crossVectors(axis, u)
  const ring = (c, r, i) => { const t = i / segs * Math.PI * 2; return c.clone().addScaledVector(u, Math.cos(t) * r).addScaledVector(v, Math.sin(t) * r) }
  for (let i = 0; i < segs; i++) {
    const a0 = ring(a, ra, i), a1 = ring(a, ra, i + 1), b0 = ring(b, rb, i), b1 = ring(b, rb, i + 1)
    tri(out, a0, b0, b1, color); tri(out, a0, b1, a1, color)
  }
}

function cone(out, base, r, h, segs, color) {
  const apex = base.clone(); apex.y += h
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs * Math.PI * 2, t1 = (i + 1) / segs * Math.PI * 2
    const p0 = new THREE.Vector3(base.x + Math.cos(t0) * r, base.y, base.z + Math.sin(t0) * r)
    const p1 = new THREE.Vector3(base.x + Math.cos(t1) * r, base.y, base.z + Math.sin(t1) * r)
    tri(out, p0, p1, apex, color); tri(out, p0, apex, p1, color.clone().multiplyScalar(0.8))   // underside darker
  }
}

// leaf cluster: a randomly rotated, slightly squashed icosahedron
function cluster(out, rnd, center, size, color) {
  const rot = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rnd() * 3, rnd() * 3, rnd() * 3))
  const c = color.clone().multiplyScalar(0.9 + rnd() * 0.2)
  const p = new THREE.Vector3()
  for (let i = 0; i < ICO.count; i++) {
    p.fromBufferAttribute(ICO, i).multiply(new THREE.Vector3(size, size * 0.8, size)).applyMatrix4(rot).add(center)
    out.pos.push(p.x, p.y, p.z); out.col.push(c.r, c.g, c.b)
  }
}

function tri(out, a, b, c, color) {
  out.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
  out.col.push(color.r, color.g, color.b, color.r, color.g, color.b, color.r, color.g, color.b)
}

function mulberry32(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

// stable pseudo-random in [0,1) from a position
function rand(a, b) {
  const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453
  return x - Math.floor(x)
}
