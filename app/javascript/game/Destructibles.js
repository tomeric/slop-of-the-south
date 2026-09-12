import * as THREE from "three"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"

// Every object a player can flatten, indexed for collisions and kept in step with the server. The tile builders
// register a handle per object (BuildingMeshes, Buildings, Trees, Furniture, Signs): where it stands, how big it is,
// how to hide it. This index puts them in a 25 m grid, answers "what is at (x, z)?" for the car and the weapons, and
// applies the server's verdicts: intact → rubble (a heap of blocks over the footprint) → gone. Whatever the server
// said about a tile that was not loaded yet is remembered and applied when the tile comes in.
const CELL = 25
const STATE = { intact: 0, rubble: 1, gone: 2 }
const RUBBLE = [0x8a847c, 0x9a938a, 0x6f655c, 0x7d6b5a, 0xa39c93]
const rubbleMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true })
rubbleMat.__shared = true
const block = new THREE.BoxGeometry(1, 1, 1)
const EMPTY = []

export class Destructibles {
  constructor(effects) {
    this.effects = effects
    this.heightAt = () => 0
    this.objects = new Map()      // key → object (every key of a sign pole points at the same object)
    this.cells = new Map()        // grid cell → [object]
    this.state = new Map()        // key → { hp, max, state } as the server last said
    this.frame = 0
  }

  // a tile came in: its handles become indexed objects, with any state the server already reported
  indexTile(tile) {
    for (const [key, h] of tile.objects) {
      const obj = { ...h, key, tile, hp: h.max, state: 0, rubble: null, shade: 1, mark: 0 }
      if (obj.rings) {
        obj.minX = obj.minZ = Infinity; obj.maxX = obj.maxZ = -Infinity
        for (const ring of obj.rings) for (let i = 0; i + 1 < ring.length; i += 2) {
          obj.minX = Math.min(obj.minX, ring[i]); obj.maxX = Math.max(obj.maxX, ring[i])
          obj.minZ = Math.min(obj.minZ, ring[i + 1]); obj.maxZ = Math.max(obj.maxZ, ring[i + 1])
        }
      } else { obj.minX = obj.x - obj.r; obj.maxX = obj.x + obj.r; obj.minZ = obj.z - obj.r; obj.maxZ = obj.z + obj.r }
      for (const k of obj.keys ?? [key]) this.objects.set(k, obj)
      this.eachCell(obj.minX, obj.maxX, obj.minZ, obj.maxZ, (c) => { if (!this.cells.has(c)) this.cells.set(c, []); this.cells.get(c).push(obj) })
      for (const k of obj.keys ?? [key]) { const st = this.state.get(k); if (st) this.transition(obj, st.hp, st.max, STATE[st.state], true) }
    }
  }

  dropTile(tile) {
    for (const [key, h] of tile.objects) {
      const obj = this.objects.get(key)
      if (!obj) continue
      for (const k of obj.keys ?? [key]) this.objects.delete(k)
      this.eachCell(obj.minX, obj.maxX, obj.minZ, obj.maxZ, (c) => { const list = this.cells.get(c); if (list) this.cells.set(c, list.filter((o) => o !== obj)) })
    }
  }

  eachCell(minX, maxX, minZ, maxZ, fn) {
    for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++)
      for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz++) fn((cx + 1e5) * 262144 + (cz + 1e5))
  }

  // every standing object within r of (x, z), once each
  near(x, z, r, fn) {
    const seen = ++this.frame
    this.eachCell(x - r, x + r, z - r, z + r, (c) => {
      for (const obj of this.cells.get(c) ?? EMPTY) {
        if (obj.mark === seen || obj.state === 2) continue
        obj.mark = seen
        if (distTo(x, z, obj) <= r) fn(obj)
      }
    })
  }

  // the standing object under (x, z), with the way out: { obj, nx, nz, depth } or null
  hitPoint(x, z, pad) {
    for (const obj of this.cells.get((Math.floor(x / CELL) + 1e5) * 262144 + (Math.floor(z / CELL) + 1e5)) ?? EMPTY) {
      if (obj.state === 2 || x < obj.minX - pad || x > obj.maxX + pad || z < obj.minZ - pad || z > obj.maxZ + pad) continue
      if (obj.rings) {
        const inside = obj.rings.some((ring) => pointInPolygon(x, z, ring))
        const e = nearestEdge(x, z, obj.rings)
        if (!inside && e.d > pad) continue
        const len = e.d || 1, sx = (e.px - x) / len, sz = (e.pz - z) / len
        return inside ? { obj, nx: sx, nz: sz, depth: e.d + pad } : { obj, nx: -sx, nz: -sz, depth: pad - e.d }
      }
      const d = Math.hypot(x - obj.x, z - obj.z)
      if (d > obj.r + pad) continue
      const len = d || 1
      return { obj, nx: (x - obj.x) / len, nz: (z - obj.z) / len, depth: obj.r + pad - d }
    }
    return null
  }

  // ---- the server's word ---------------------------------------------------------------------------------------

  apply(key, hp, max, state) {
    this.state.set(key, { hp, max, state })
    const obj = this.objects.get(key)
    if (obj) this.transition(obj, hp, max, STATE[state], false)
  }

  applyAll(list) { for (const o of list) if (o.hp !== null && o.hp !== undefined) this.apply(o.key, o.hp, o.max, o.state) }

  resetRound() { this.state.clear() }

  // the round was lost here: everything within r goes, without a word to the server
  cosmeticWipe(x, z, r) {
    this.near(x, z, r, (obj) => this.transition(obj, 0, obj.max, 2, true))
  }

  transition(obj, hp, max, s, silent) {
    if (s > obj.state) {
      if (obj.state === 0) {
        obj.remove()
        obj.detail?.remove()                             // the plinth, sills and door game/Facades.js hung on it
        if (s === 1) {
          obj.rubble = makeRubble(obj, this.heightAt)
          obj.tile.group.add(obj.rubble)
          if (!silent) this.effects?.collapse(obj, this.groundOf(obj))
        }
      }
      if (s === 2) {
        if (obj.rubble) { obj.tile.group.remove(obj.rubble); obj.rubble.geometry.dispose(); obj.rubble = null }
        if (!silent) this.effects?.dust(obj.x, this.groundOf(obj) + 1, obj.z, obj.rings ? Math.max(obj.maxX - obj.minX, obj.maxZ - obj.minZ) / 2 : 2)
      }
      obj.state = s
    } else if (s === obj.state && s === 0 && hp < obj.hp && obj.tint) {
      const shade = 0.55 + 0.45 * hp / (max || obj.max)
      obj.tint(shade / obj.shade)
      obj.shade = shade
    }
    obj.hp = hp
    if (max) obj.max = max
  }

  groundOf(obj) { return this.heightAt((obj.minX + obj.maxX) / 2, (obj.minZ + obj.maxZ) / 2) }
}

// ---- rubble ---------------------------------------------------------------------------------------------------

// a heap of grey and brown blocks scattered over the footprint, more for a bigger building
function makeRubble(obj, heightAt) {
  const rings = obj.rings ?? [[obj.x - 1, obj.z - 1, obj.x + 1, obj.z - 1, obj.x + 1, obj.z + 1, obj.x - 1, obj.z + 1]]
  const n = THREE.MathUtils.clamp(Math.round(area(rings) / 12), 4, 30)
  const geos = [], color = new THREE.Color()
  let tries = 0
  while (geos.length < n && tries++ < n * 4) {
    const x = obj.minX + Math.random() * (obj.maxX - obj.minX), z = obj.minZ + Math.random() * (obj.maxZ - obj.minZ)
    if (!rings.some((ring) => pointInPolygon(x, z, ring))) continue
    const w = 0.8 + Math.random() * 1.4, h = 0.5 + Math.random() * 1.0, d = 0.8 + Math.random() * 1.4
    const g = block.clone().scale(w, h, d).rotateY(Math.random() * Math.PI).translate(x, heightAt(x, z) + h / 2 - 0.1, z)
    color.setHex(RUBBLE[Math.floor(Math.random() * RUBBLE.length)]).multiplyScalar(0.85 + Math.random() * 0.3)
    const cols = new Float32Array(g.attributes.position.count * 3)
    for (let i = 0; i < cols.length; i += 3) { cols[i] = color.r; cols[i + 1] = color.g; cols[i + 2] = color.b }
    g.setAttribute("color", new THREE.BufferAttribute(cols, 3))
    geos.push(g)
  }
  const merged = mergeGeometries(geos, false)
  geos.forEach((g) => g.dispose())
  return new THREE.Mesh(merged, rubbleMat)
}

// ---- helpers for the builders ---------------------------------------------------------------------------------

export function pointKey(prefix, x, z) { return `${prefix}:${Math.round(x * 10)},${Math.round(z * 10)}` }

// pull every vertex of the range onto its first one: zero-area triangles, uploaded as one range
export function collapseRange(attr, start, count) {
  const a = attr.array, x = a[start * 3], y = a[start * 3 + 1], z = a[start * 3 + 2]
  for (let i = start; i < start + count; i++) { a[i * 3] = x; a[i * 3 + 1] = y; a[i * 3 + 2] = z }
  attr.addUpdateRange(start * 3, count * 3)
  attr.needsUpdate = true
}

export function scaleRange(attr, start, count, k) {
  const a = attr.array
  for (let i = start * 3; i < (start + count) * 3; i++) a[i] *= k
  attr.addUpdateRange(start * 3, count * 3)
  attr.needsUpdate = true
}

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0)
export function hideInstance(mesh, i) {
  mesh.setMatrixAt(i, ZERO)
  mesh.instanceMatrix.addUpdateRange(i * 16, 16)
  mesh.instanceMatrix.needsUpdate = true
}

// rings are flat [x, z, x, z, ...]
export function pointInPolygon(x, z, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i], zi = ring[i + 1], xj = ring[j], zj = ring[j + 1]
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

// closest point on any ring edge: { d, px, pz }
export function nearestEdge(x, z, rings) {
  let best = { d: Infinity, px: x, pz: z }
  for (const ring of rings) for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const ax = ring[j], az = ring[j + 1], dx = ring[i] - ax, dz = ring[i + 1] - az
    const len2 = dx * dx + dz * dz || 1
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2))
    const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(px - x, pz - z)
    if (d < best.d) best = { d, px, pz }
  }
  return best
}

export function distTo(x, z, obj) {
  if (!obj.rings) return Math.max(0, Math.hypot(x - obj.x, z - obj.z) - obj.r)
  return obj.rings.some((ring) => pointInPolygon(x, z, ring)) ? 0 : nearestEdge(x, z, obj.rings).d
}

export function area(rings) {
  let a = 0
  for (const ring of rings) for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) a += ring[j] * ring[i + 1] - ring[i] * ring[j + 1]
  return Math.abs(a) / 2
}

// convex hull (monotone chain) of flat [x, z, ...] points, as a flat ring
export function hullXZ(flat) {
  const pts = []
  for (let i = 0; i + 1 < flat.length; i += 2) pts.push([flat[i], flat[i + 1]])
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (pts.length < 3) return pts.flat()
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower = [], upper = []
  for (const p of pts) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop(); lower.push(p) }
  for (const p of pts.reverse()) { while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop(); upper.push(p) }
  return lower.slice(0, -1).concat(upper.slice(0, -1)).flat()
}

export const buildingHp = (rings) => THREE.MathUtils.clamp(Math.round(60 + 1.2 * area(rings)), 80, 800)
