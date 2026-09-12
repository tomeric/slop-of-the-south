import * as THREE from "three"
import { collapseRange, scaleRange, hullXZ, buildingHp } from "game/Destructibles"
import { buildingMaterial } from "game/BuildingTextures"
import { TUNING as T } from "game/Tuning"

// 3D BAG LoD2.2 buildings: faces (roof planes and walls) triangulated here with earcut and merged per material into
// one flat-shaded, vertex-coloured mesh each per tile. Tile format per building: { id, roof, o: [x, y, z],
// f: [[label, outer, hole, ...], ...] } where rings are flat centimetre offsets [dx, dy, dz, ...] from o. Label 1 =
// roof, 2 = wall. `fp` holds the ground outline as flat [x, z, ...] rings in game units. With `reg` every building
// registers a destructible handle: the vertex ranges it owns in each merged geometry, collapsed when it falls.
//
// The texture comes from the face's own plane. Earcut already needs a 2D basis per face, and that basis is exactly
// the one a bricklayer would use: u = up × n runs horizontally along a wall and up the slope of a roof, v is world
// up on a wall. So the UV is a subtraction and a divide, with no unwrapping and no extra geometry.
//
// Walls wide and tall enough get the facade cell, which holds one window in one bay by one storey. The number of
// bays comes from the face's own width and the number of storeys from the building's wall height, both rounded to
// whole numbers, so window rows line up around every corner, the eave never cuts a row in half and every outside
// corner keeps a pier of brick. Everything narrower — the jogs, the dormer cheeks, the 44 % of faces under two
// metres — falls through to plain brick, which is what those are.
const WALLS = [0xd9c4a5, 0xcdb597, 0xb99c7a, 0xa8836a, 0xe3d6c3, 0xc9c1b4, 0x9c7b66, 0xdccbb6]  // brick, plaster, dark brick
const PITCHED = [0x8e5a4a, 0x7a4f48, 0x64605f, 0x9c6350, 0x565152, 0xa8705a]                   // tiles: terracotta to anthracite
const FLAT = [0x8f8c86, 0x9d9a93, 0x7e7c78]                                                     // bitumen / gravel
const POOL3 = [], POOL2 = []                                                                      // scratch vectors reused per face
const X_AXIS = new THREE.Vector3(1, 0, 0)

// The grid every consumer has to agree on: the facade texture paints one window per bay per storey, game/Facades.js
// hangs a sill under each of them, and the structure generator punches the hole. Derive it in one place or the three
// drift and a sill ends up under a brick pier. `n` is what BAG counted (tile field `n`, b3_bouwlagen); without it we
// fall back to the wall height, which is what every tile built before that field existed carries.
// The colour the shell gave this building. game/Structure.js needs it so a house that swaps from painted to built
// keeps the brick it had; the per-face jitter stays with the shell, since a piece is not a face.
export function buildingPalette(id, roof) {
  const h = hash(id), flat = roof === "horizontal"
  return { h, flat, wall: WALLS[h % WALLS.length], roof: flat ? FLAT[h % FLAT.length] : PITCHED[(h >> 3) % PITCHED.length] }
}

export const bayCount = (width) => Math.max(1, Math.round(width / T.buildings.bay))
export const storeyCount = (wallH, n) => (n > 0 ? n : Math.max(1, Math.round(wallH / T.buildings.storey)))

export function buildBuildingMeshes(meshes, reg) {
  if (!meshes?.length) return null
  const buckets = new Map()                                     // material name → { pos, col, uv }
  const bucket = (name) => { let b = buckets.get(name); if (!b) buckets.set(name, b = { pos: [], col: [], uv: [] }); return b }
  const handles = []
  const color = new THREE.Color()
  const pts3 = [], pts2 = []
  const normal = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0)
  const B = T.buildings

  for (const b of meshes) {
    const h = hash(b.id)
    const wall = WALLS[h % WALLS.length]
    const flat = b.roof === "horizontal"
    const roof = flat ? FLAT[h % FLAT.length] : PITCHED[(h >> 3) % PITCHED.length]
    const [ox, oy, oz] = b.o
    // The storeys are the building's, not the face's, so every wall of it carries the same rows. The eave is the
    // other number worth keeping: a gable wall reaches the ridge, so the *lowest* top of the broad walls is where
    // the roof lands — which is where game/Facades.js hangs the gutter.
    let wallTop = -Infinity, eaveTop = Infinity
    const walls = []                                            // [x, z, top] per broad wall face, in game units
    for (const face of b.f) {
      if (face[0] !== 2) continue
      let top = -Infinity, fx0 = Infinity, fx1 = -Infinity, fz0 = Infinity, fz1 = -Infinity
      for (let r = 1; r < face.length; r++) {
        const ring = face[r]
        for (let i = 0; i + 2 < ring.length; i += 3) {
          if (ring[i + 1] > top) top = ring[i + 1]
          if (ring[i] < fx0) fx0 = ring[i]; if (ring[i] > fx1) fx1 = ring[i]
          if (ring[i + 2] < fz0) fz0 = ring[i + 2]; if (ring[i + 2] > fz1) fz1 = ring[i + 2]
        }
      }
      if (top === -Infinity) continue
      if (top > wallTop) wallTop = top
      if (fx1 - fx0 + (fz1 - fz0) >= 200) {                                        // 2 m of wall, not a dormer cheek
        eaveTop = Math.min(eaveTop, top)
        walls.push(ox + (fx0 + fx1) / 200, oz + (fz0 + fz1) / 200, top / 100)
      }
    }
    const wallH = wallTop > -Infinity ? wallTop / 100 : 0
    const eaveH = eaveTop < Infinity ? eaveTop / 100 : wallH
    const storeys = storeyCount(wallH, b.n)
    const storeyH = wallH / storeys
    const windows = wallH >= B.minHeight
    const lights = (h >> 7) % 3 !== 0                            // two houses in three have their lights on at night
    const at = {}
    for (const [name, part] of buckets) at[name] = part.pos.length / 3
    const xz = []
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, top = -Infinity

    for (const face of b.f) {
      const label = face[0]
      // rings → arrays of Vector3 (outer first, then holes); the vectors come from a pool reused per face, since a
      // dense tile has 60k ring vertices and allocating them all made every tile load a visible hitch
      const rings = []
      let used = 0
      for (let r = 1; r < face.length; r++) {
        const ring2 = face[r], ring = []
        for (let i = 0; i + 2 < ring2.length; i += 3) {
          const p = (POOL3[used] ??= new THREE.Vector3()).set(ox + ring2[i] / 100, oy + ring2[i + 1] / 100, oz + ring2[i + 2] / 100); used++
          ring.push(p)
          if (reg) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); top = Math.max(top, p.y); if (!b.fp) xz.push(p.x, p.z) }
        }
        if (ring.length >= 3) rings.push(ring)
      }
      if (!rings.length) continue
      newell(rings[0], normal)
      if (normal.lengthSq() < 1e-12) continue
      normal.normalize()
      // 2D basis in the face plane for earcut, and the texture frame: on a wall u is horizontal and v is world up
      u.copy(Math.abs(normal.y) > 0.9 ? X_AXIS : up).cross(normal).normalize()
      v.crossVectors(normal, u)
      pts3.length = 0; pts2.length = 0
      const contour = [], holes = []
      let used2 = 0, u0 = Infinity, u1 = -Infinity, v0 = Infinity
      for (let r = 0; r < rings.length; r++) {
        const target = r === 0 ? contour : []
        for (const p of rings[r]) {
          const q = (POOL2[used2] ??= new THREE.Vector2()).set(p.dot(u), p.dot(v)); used2++
          pts3.push(p); pts2.push(q); target.push(q)
          if (r === 0) { if (q.x < u0) u0 = q.x; if (q.x > u1) u1 = q.x; if (q.y < v0) v0 = q.y }
        }
        if (r > 0) holes.push(target)
      }
      let tris
      try { tris = THREE.ShapeUtils.triangulateShape(contour, holes) } catch { continue }

      const width = u1 - u0
      const gevel = label === 2 && windows && width >= B.minWidth
      const name = label === 1 ? (flat ? "bitumen" : "pannen") : gevel ? (lights ? "gevel" : "gevel-uit") : "steen"
      const part = bucket(name)
      // the facade is measured in bays and storeys, everything else in metres (its map repeats by the metre)
      const su = gevel ? 1 / (width / bayCount(width)) : 1
      const sv = gevel ? 1 / storeyH : 1
      const base = label === 2 ? oy : v0                        // walls start at the building's foot, roofs at the eave

      const tint = 0.92 + ((h ^ (face.length * 7919)) % 17) / 100
      color.setHex(label === 1 ? roof : wall)
      const cr = color.r * tint, cg = color.g * tint, cb = color.b * tint
      for (const [a, b2, c] of tris) {
        for (const i of [a, b2, c]) {
          const p = pts3[i], q = pts2[i]
          part.pos.push(p.x, p.y, p.z)
          part.col.push(cr, cg, cb)
          part.uv.push((q.x - u0) * su, (label === 2 ? p.y - base : q.y - base) * sv)
        }
      }
    }

    if (reg) {
      const parts = []
      for (const [name, p] of buckets) { const start = at[name] ?? 0, count = p.pos.length / 3 - start; if (count) parts.push({ name, start, count }) }
      if (parts.length) {
        const rings = b.fp ?? [hullXZ(xz)]
        handles.push({ key: `m:${b.id}`, kind: "m", rings, x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, y: oy, wall: wallH, eave: eaveH, walls, storeys, src: T.buildings.structure.on ? packFaces(b) : null, h: top - oy, max: buildingHp(rings), parts })
      }
    }
  }

  if (!buckets.size) return null
  const group = new THREE.Group(), geos = new Map()
  for (const [name, part] of buckets) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute("position", new THREE.Float32BufferAttribute(part.pos, 3))
    geo.setAttribute("color", new THREE.Float32BufferAttribute(part.col, 3))
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(part.uv, 2))
    geo.computeVertexNormals()          // non-indexed → one normal per triangle = flat shading
    geos.set(name, geo)
    group.add(new THREE.Mesh(geo, buildingMaterial(name)))
  }
  // a building's vertices are contiguous inside each bucket, so its handle is a short list of ranges
  // `remove` is destructive — collapseRange overwrites the vertices in place — so hiding for a structure keeps a
  // copy first. It is a couple of kilobytes per building and only the handful near the car ever pay it.
  const saved = new Map()
  for (const handle of handles) reg(handle.key, { ...handle,
    remove: () => { for (const p of handle.parts) collapseRange(geos.get(p.name).attributes.position, p.start, p.count) },
    tint: (k) => { for (const p of handle.parts) scaleRange(geos.get(p.name).attributes.color, p.start, p.count, k) },
    hide: () => {
      if (saved.has(handle.key)) return
      const copy = handle.parts.map((p) => geos.get(p.name).attributes.position.array.slice(p.start * 3, (p.start + p.count) * 3))
      saved.set(handle.key, copy)
      for (const p of handle.parts) collapseRange(geos.get(p.name).attributes.position, p.start, p.count)
    },
    show: () => {
      const copy = saved.get(handle.key)
      if (!copy) return
      saved.delete(handle.key)
      handle.parts.forEach((p, i) => {
        const attr = geos.get(p.name).attributes.position
        attr.array.set(copy[i], p.start * 3)
        attr.addUpdateRange(p.start * 3, p.count * 3)
        attr.needsUpdate = true
      })
    } })
  return group
}

// The faces again, packed small, because ChunkManager throws the tile JSON away the moment this function returns
// and game/Structure.js needs the shape to cut a building into pieces. Verbatim centimetre offsets from `o`, outer
// rings only (no face in the whole province has ever had a hole ring), so the grid it derives is bit-identical to
// the one the shell drew: a dense tile costs 1.5 MB rather than the 8 MB the parsed arrays hold.
function packFaces(b) {
  let n = 0
  for (const face of b.f) n += (face[1]?.length ?? 0) / 3 | 0
  const lab = new Uint8Array(b.f.length), off = new Uint32Array(b.f.length + 1), xyz = new Int32Array(n * 3)
  let at = 0
  for (let i = 0; i < b.f.length; i++) {
    const ring = b.f[i][1]
    lab[i] = b.f[i][0]
    off[i] = at
    if (ring) for (let k = 0; k + 2 < ring.length; k += 3) { xyz[at * 3] = ring[k]; xyz[at * 3 + 1] = ring[k + 1]; xyz[at * 3 + 2] = ring[k + 2]; at++ }
  }
  off[b.f.length] = at
  return { o: b.o, roof: b.roof, n: b.n, lab, off, xyz }
}

// Newell's method: robust polygon normal for concave / slightly non-planar rings
function newell(ring, out) {
  out.set(0, 0, 0)
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length]
    out.x += (p.y - q.y) * (p.z + q.z)
    out.y += (p.z - q.z) * (p.x + q.x)
    out.z += (p.x - q.x) * (p.y + q.y)
  }
  return out
}

function hash(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}
