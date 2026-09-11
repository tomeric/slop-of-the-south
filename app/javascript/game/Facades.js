import * as THREE from "three"
import { TUNING as T } from "game/Tuning"
import { collapseRange } from "game/Destructibles"
import { WINDOW } from "game/BuildingTextures"
import { nearRoad } from "game/ChunkManager"
import { noOutline } from "game/Outline"
import { casts } from "game/Shadows"

// The half-metre of a house you only see from the pavement: a stone plinth around its foot, a gutter along the
// eaves, a sill under every window and a front door on the side that faces the street. None of it can be baked into
// the facade texture — a painted sill throws no shadow line and a painted door has no depth — and none of it is
// worth a triangle beyond a hundred metres, so it is streamed in cells around the car and dropped behind, the way
// game/Scatter.js streams the grass.
//
// It is all built from the building's own footprint and the numbers BuildingMeshes snapped: the same
// `bays = round(width / bay)` and `storeys = round(wallH / storey)`, so a sill lands under the window that is
// painted there and not half a bay off. Dividing an edge into whole bays is symmetric, so it does not matter which
// end the grid is counted from — the only reason this can work off the footprint instead of the wall faces.
const PLINTH = { h: 0.45, out: 0.07, deep: 0.07, drop: 0.05 }
const GUTTER = { h: 0.11, out: 0.1, deep: 0.13 }
const SILL = { out: 0.08, thick: 0.05, over: 0.08 }
const DOOR = { w: 0.95, h: 2.05, out: 0.05, reach: 22 }
const DOORS = [0x2f4a35, 0x6b2a24, 0x2b3a52, 0x4a3626, 0x7a6a4a]      // the paint on a Limburg front door
const MIN_EDGE = 0.9
const BUCKETS = ["stone", "dark", "paint"]
const UP = [0, 1, 0], DOWN = [0, -1, 0]

const materials = {
  stone: noOutline(Object.assign(new THREE.MeshStandardMaterial({ color: 0xcfc9bd, roughness: 0.85 }), { __shared: true })),
  dark: noOutline(Object.assign(new THREE.MeshStandardMaterial({ color: 0x4a4640, roughness: 0.7 }), { __shared: true })),
  paint: noOutline(Object.assign(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 }), { __shared: true })),
}

export class Facades {
  constructor(scene, index, chunks) {
    this.scene = scene
    this.index = index
    this.chunks = chunks
    this.cells = new Map()             // "cx_cz" → { group, buildings }
    this.queue = []
  }

  // one cell per frame, like the tiles: a town cell holds a few hundred houses and doing five at once hitches
  update(car) {
    const D = T.buildings.detail
    if (!D.on) return this.clear()
    const size = D.cell, r = D.radius
    const cx = Math.floor(car.x / size), cz = Math.floor(car.z / size)
    const wanted = new Set()
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const key = `${cx + dx}_${cz + dz}`
      wanted.add(key)
      if (!this.cells.has(key) && !this.queue.some((q) => q.key === key)) this.queue.push({ key, x: cx + dx, z: cz + dz })
    }
    for (const [key, cell] of this.cells) if (!wanted.has(key)) this.drop(key, cell)
    this.queue = this.queue.filter((q) => wanted.has(q.key))
    const i = this.queue.findIndex((q) => this.ready(q.x, q.z, size))
    if (i >= 0) { const [q] = this.queue.splice(i, 1); this.build(q.key, q.x, q.z) }
  }

  // wait for the tiles under the cell: a cell is built once, so a house that streams in later would never get its
  // doorstep until the player drove away and came back
  ready(cx, cz, size) {
    for (const [dx, dz] of [[0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]])
      if (!this.chunks.ready((cx + dx) * size, (cz + dz) * size)) return false
    return true
  }

  clear() { for (const [key, cell] of this.cells) this.drop(key, cell) }

  drop(key, cell) {
    this.scene.remove(cell.group)
    cell.group.traverse((o) => { if (o.geometry) o.geometry.dispose() })
    for (const obj of cell.buildings) obj.detail = null
    this.cells.delete(key)
  }

  build(key, cx, cz) {
    const size = T.buildings.detail.cell
    const x0 = cx * size, z0 = cz * size
    const parts = { stone: [], dark: [], paint: [] }
    const buildings = []
    const ground = (x, z) => this.chunks.heightAt(x, z)
    this.index.near(x0 + size / 2, z0 + size / 2, size, (obj) => {
      if (obj.kind !== "m" || obj.state > 0 || !obj.rings || obj.wall == null) return
      if (obj.x < x0 || obj.x >= x0 + size || obj.z < z0 || obj.z >= z0 + size) return
      const at = {}
      for (const b of BUCKETS) at[b] = parts[b].length
      detailOf(obj, parts, ground)
      if (BUCKETS.every((b) => parts[b].length === at[b])) return
      buildings.push(obj)
      obj.detail = at                                        // filled in below, once the geometries exist
    })
    const group = new THREE.Group(), geos = {}
    for (const b of BUCKETS) {
      const tris = parts[b]
      if (!tris.length) continue
      const pos = new Float32Array(tris.length * 9)
      tris.forEach((t, i) => pos.set(t.pos, i * 9))
      const geo = new THREE.BufferGeometry()
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3))
      if (b === "paint") {
        const col = new Float32Array(tris.length * 9)
        tris.forEach((t, i) => col.set(t.col, i * 9))
        geo.setAttribute("color", new THREE.BufferAttribute(col, 3))
      }
      geo.computeVertexNormals()
      geos[b] = geo
      group.add(new THREE.Mesh(geo, materials[b]))
    }
    if (group.children.length) { casts(group); this.scene.add(group) }
    // each building's own slice of each merged geometry, so its detail goes down with it (Destructibles calls this)
    for (let i = 0; i < buildings.length; i++) {
      const at = buildings[i].detail, next = buildings[i + 1]?.detail
      buildings[i].detail = () => {
        for (const b of BUCKETS) {
          const end = next ? next[b] : parts[b].length
          if (geos[b] && end > at[b]) collapseRange(geos[b].attributes.position, at[b] * 3, (end - at[b]) * 3)
        }
      }
    }
    this.cells.set(key, { group, buildings })
  }
}

function detailOf(obj, parts, groundAt) {
  const B = T.buildings
  const windows = obj.wall >= B.minHeight
  // the rows are laid out over the wall height BuildingMeshes used — the ridge, on a gabled house — but a sill may
  // only hang where there is wall under it, and along a footprint edge that is the eave
  const storeys = Math.max(1, Math.round(obj.wall / B.storey)), storeyH = obj.wall / storeys
  const eave = Math.min(obj.wall, obj.eave ?? obj.wall)
  const edges = []
  for (const ring of obj.rings) {
    const n = ring.length / 2
    if (n < 3) continue
    let mx = 0, mz = 0
    for (let i = 0; i < n; i++) { mx += ring[i * 2]; mz += ring[i * 2 + 1] }
    mx /= n; mz /= n
    for (let i = 0; i < n; i++) {
      const px = ring[i * 2], pz = ring[i * 2 + 1], qx = ring[((i + 1) % n) * 2], qz = ring[((i + 1) % n) * 2 + 1]
      const dx = qx - px, dz = qz - pz, len = Math.hypot(dx, dz)
      if (len < MIN_EDGE) continue
      const ux = dx / len, uz = dz / len
      let nx = uz, nz = -ux                                  // out of the wall: whichever side faces away from the middle
      if (nx * ((px + qx) / 2 - mx) + nz * ((pz + qz) / 2 - mz) < 0) { nx = -nx; nz = -nz }
      edges.push({ px, pz, ux, uz, nx, nz, len, y: obj.y, eave: eaveOver(obj, px + ux * len / 2, pz + uz * len / 2, eave) })
    }
  }
  // the door first, so the sill of the bay it stands in can be left out: the longest edge facing a street
  let door = null
  for (const e of edges)
    if (e.len >= 2 && (!door || e.len > door.len) &&
        nearRoad(obj.tile?.roadIndex, e.px + e.ux * e.len / 2 + e.nx * 3, e.pz + e.uz * e.len / 2 + e.nz * 3, DOOR.reach)) door = e
  const bay = door && doorBay(door, T.buildings)
  for (const e of edges) {
    band(parts.stone, e, -PLINTH.drop, PLINTH.h, PLINTH.out, PLINTH.deep)
    band(parts.dark, e, e.eave - GUTTER.h, GUTTER.h, GUTTER.out, GUTTER.deep)
    if (windows && e.len >= B.minWidth) sills(parts.stone, e, e.eave, storeys, storeyH, B, e === door ? bay : -1)
  }
  if (door) {
    const bays = Math.max(1, Math.round(door.len / B.bay)), c = (bay + 0.5) * (door.len / bays)
    doorway(parts.paint, door, obj, bay, groundAt(door.px + door.ux * c + door.nx * 1.5, door.pz + door.uz * c + door.nz * 1.5))
  }
}

// How high the wall over this footprint edge goes: the top of the nearest broad wall face BuildingMeshes measured.
// One height for the whole building will not do — a church with a low side chapel would wear its gutter at the
// chapel's eaves all the way round.
function eaveOver(obj, x, z, fallback) {
  const w = obj.walls
  if (!w?.length) return fallback
  let best = fallback, d2 = Infinity
  for (let i = 0; i < w.length; i += 3) {
    const d = (w[i] - x) ** 2 + (w[i + 1] - z) ** 2
    if (d < d2) { d2 = d; best = w[i + 2] }
  }
  return Math.min(obj.wall, best)
}

// the bay of the street-facing wall the door stands in: the middle one, so it lands between windows and not under one
function doorBay(e, B) {
  const bays = Math.max(1, Math.round(e.len / B.bay))
  return Math.min(bays - 1, Math.floor(bays / 2))
}

// A ledge along one wall edge: an outer face `h` tall standing `out` proud of the brick, and a top surface running
// `deep` back into it. Both ends run past the corner by `out`, so the two edges of a corner meet without a notch.
function band(out3, e, y0, h, out, deep) {
  const y = e.y + y0, top = y + h
  const ox = e.nx * out, oz = e.nz * out, bx = -e.nx * deep, bz = -e.nz * deep
  const a = [e.px - e.ux * out + ox, e.pz - e.uz * out + oz]
  const b = [e.px + e.ux * (e.len + out) + ox, e.pz + e.uz * (e.len + out) + oz]
  quad(out3, [a[0], y, a[1]], [b[0], y, b[1]], [b[0], top, b[1]], [a[0], top, a[1]], [e.nx, 0, e.nz])
  quad(out3, [a[0], top, a[1]], [b[0], top, b[1]], [b[0] + bx, top, b[1] + bz], [a[0] + bx, top, a[1] + bz], UP)
}

// One sill under every window the facade paints on this wall: the bays BuildingMeshes snapped to, and the window's
// own width and sill height out of the cell it is drawn in, scaled to this building's bay and storey.
function sills(out3, e, ceiling, storeys, storeyH, B, skipBay = -1) {
  const bays = Math.max(1, Math.round(e.len / B.bay)), bayW = e.len / bays
  const w = WINDOW.w / WINDOW.bay * bayW + SILL.over * 2
  const ox = e.nx * SILL.out, oz = e.nz * SILL.out
  for (let s = 0; s < storeys; s++) {
    const y = e.y + s * storeyH + WINDOW.sill / WINDOW.storey * storeyH - SILL.thick
    if (y + SILL.thick > e.y + ceiling || y < e.y + PLINTH.h) continue
    for (let k = 0; k < bays; k++) {
      if (s === 0 && k === skipBay) continue                 // the front door stands here
      const c = (k + 0.5) * bayW
      const a = [e.px + e.ux * (c - w / 2), e.pz + e.uz * (c - w / 2)]
      const b = [e.px + e.ux * (c + w / 2), e.pz + e.uz * (c + w / 2)]
      quad(out3, [a[0], y + SILL.thick, a[1]], [b[0], y + SILL.thick, b[1]], [b[0] + ox, y + SILL.thick, b[1] + oz], [a[0] + ox, y + SILL.thick, a[1] + oz], UP)
      quad(out3, [a[0] + ox, y, a[1] + oz], [b[0] + ox, y, b[1] + oz], [b[0] + ox, y + SILL.thick, b[1] + oz], [a[0] + ox, y + SILL.thick, a[1] + oz], [e.nx, 0, e.nz])
      quad(out3, [a[0] + ox, y, a[1] + oz], [a[0], y, a[1]], [b[0], y, b[1]], [b[0] + ox, y, b[1] + oz], DOWN)
    }
  }
}

// The leaf stands on the ground rather than on the building's own foot: BAG puts that at the level the surveyor
// measured, which is not always where the pavement ended up.
function doorway(out3, e, obj, bay, ground) {
  const bays = Math.max(1, Math.round(e.len / T.buildings.bay)), bayW = e.len / bays
  const w = Math.min(DOOR.w, bayW - 0.5, e.len - 0.4)
  // Stand it on the pavement, and never higher than the top of the plinth: BAG measures a building's foot where the
  // surveyor found it, which is up to a metre under the street, and a door hanging over its own doorstep is worse
  // than one whose bottom edge is buried a few centimetres.
  const y = Math.max(Math.min(ground, obj.y + PLINTH.h), obj.y - 1.5)
  const h = Math.min(DOOR.h, obj.y + obj.wall - 0.2 - y)
  if (w < 0.5 || h < 1.4) return
  const c = (bay + 0.5) * bayW
  const ox = e.nx * DOOR.out, oz = e.nz * DOOR.out
  const a = [e.px + e.ux * (c - w / 2) + ox, e.pz + e.uz * (c - w / 2) + oz]
  const b = [e.px + e.ux * (c + w / 2) + ox, e.pz + e.uz * (c + w / 2) + oz]
  const col = new THREE.Color(DOORS[hash(obj.key) % DOORS.length])
  quad(out3, [a[0], y, a[1]], [b[0], y, b[1]], [b[0], y + h, b[1]], [a[0], y + h, a[1]], [e.nx, 0, e.nz], col)
  // the reveal: two cheeks and a head running back to the brick, so the leaf reads as set into the wall
  const back = (p) => [p[0] - ox, p[1] - oz]
  const ab = back(a), bb = back(b)
  quad(out3, [a[0], y, a[1]], [ab[0], y, ab[1]], [ab[0], y + h, ab[1]], [a[0], y + h, a[1]], [-e.ux, 0, -e.uz], col)
  quad(out3, [b[0], y, b[1]], [bb[0], y, bb[1]], [bb[0], y + h, bb[1]], [b[0], y + h, b[1]], [e.ux, 0, e.uz], col)
  quad(out3, [a[0], y + h, a[1]], [b[0], y + h, b[1]], [bb[0], y + h, bb[1]], [ab[0], y + h, ab[1]], DOWN, col)
}

// Two triangles, turned to face `n`: the corners are given in order round the face and the winding is fixed here,
// so no caller has to remember which way round three wants them. Every face is single-sided, and a wall band wound
// inside out is invisible from the street — which is exactly how the first version came out.
function quad(out3, a, b, c, d, n, col) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
  const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx
  const [p, q, r, s] = fx * n[0] + fy * n[1] + fz * n[2] >= 0 ? [a, b, c, d] : [a, d, c, b]
  const rgb = col ? [col.r, col.g, col.b] : null
  for (const [i, j, k] of [[p, q, r], [p, r, s]])
    out3.push({ pos: [...i, ...j, ...k], col: rgb && [...rgb, ...rgb, ...rgb] })
}

function hash(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}
