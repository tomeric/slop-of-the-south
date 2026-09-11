import * as THREE from "three"
import { TerrainTile } from "game/TerrainTile"
import { buildRoads } from "game/Roads"
import { buildBuildings } from "game/Buildings"
import { buildBuildingMeshes } from "game/BuildingMeshes"
import { buildTrees } from "game/Trees"
import { buildLamps, buildSignals } from "game/Furniture"
import { buildSigns } from "game/Signs"
import { paintCover, buildWater } from "game/Cover"
import { noOutlineInstanced } from "game/Outline"
import { ROAD_LIFT } from "game/Roads"

// Streams 500 m tiles in a square around the player and disposes the ones left behind. Tile JSON is fetched in the
// background; building the meshes is synchronous and heavy (a dense town tile is ~1 MB with 60k building vertices), so
// fetched tiles wait in a queue and at most one is built per frame — crossing a tile edge queues five at once, and
// building them all in one frame was a visible hitch. Every destructible object a tile builds is registered on the
// tile entry; hooks.onTile / hooks.onDrop hand them to the Destructibles index.
export class ChunkManager {
  constructor(scene, config, hooks = {}, radius = 2) {
    this.scene = scene
    this.cfg = config
    this.hooks = hooks
    this.radius = radius
    this.tiles = new Map()     // key "tx_ty" → { key, group, terrain, roads, roadIndex, junctions, biome, objects } or { loading: true }
    this.queue = []            // fetched tile data waiting to be built
  }

  // game coords → tile indices (RD metres / tile size)
  tileIndex(x, z) {
    const s = this.cfg.tile_size
    return [Math.floor((x + this.cfg.origin.x) / s), Math.floor((this.cfg.origin.y - z) / s)]
  }

  update(x, z) {
    const [cx, cy] = this.tileIndex(x, z)
    const wanted = new Set()
    for (let dy = -this.radius; dy <= this.radius; dy++)
      for (let dx = -this.radius; dx <= this.radius; dx++) {
        const key = `${cx + dx}_${cy + dy}`
        wanted.add(key)
        if (!this.tiles.has(key)) this.load(cx + dx, cy + dy, key)
      }
    for (const [key, t] of this.tiles)
      if (!wanted.has(key) && !t.loading) { this.dispose(t); this.tiles.delete(key) }
    // build one queued tile per frame, the one under the player first
    if (this.queue.length) {
      const here = `${cx}_${cy}`
      const i = Math.max(0, this.queue.findIndex((q) => q.key === here))
      const [q] = this.queue.splice(i, 1)
      if (this.tiles.get(q.key)?.loading) this.build(q.tx, q.ty, q.key, q.data)
    }
  }

  // drop every loaded tile so the next update streams pristine copies (a new round restores the world)
  reload() {
    for (const [key, t] of this.tiles) if (!t.loading) { this.dispose(t); this.tiles.delete(key) }
  }

  ready(x, z) {
    const t = this.tiles.get(this.tileIndex(x, z).join("_"))
    return !!(t && !t.loading)
  }

  // share of the tiles around (x, z) that are in, for the loading screen
  readyFraction(x, z) {
    const [cx, cy] = this.tileIndex(x, z)
    let n = 0, total = 0
    for (let dy = -this.radius; dy <= this.radius; dy++)
      for (let dx = -this.radius; dx <= this.radius; dx++) { total++; const t = this.tiles.get(`${cx + dx}_${cy + dy}`); if (t && !t.loading) n++ }
    return n / total
  }

  // Height under (x, z): the road surface when on a road (blended to the terrain over the ribbon edge), else the terrain.
  heightAt(x, z) {
    const t = this.tiles.get(this.tileIndex(x, z).join("_"))
    if (!t || t.loading) return 0
    return roadHeight(t.roadIndex, x, z, t.terrain)
  }

  // Biome label of the tile under (x, z), for the HUD.
  biomeAt(x, z) {
    const t = this.tiles.get(this.tileIndex(x, z).join("_"))
    return t && !t.loading ? t.biome : null
  }

  // Road polylines of the tile under (x, z) and its eight neighbours, for the street sign.
  roadsAround(x, z) {
    const [cx, cy] = this.tileIndex(x, z)
    const out = []
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const t = this.tiles.get(`${cx + dx}_${cy + dy}`)
        if (t && !t.loading) out.push(...t.roads)
      }
    return out
  }

  async load(tx, ty, key) {
    this.tiles.set(key, { loading: true })
    try {
      let res = await fetch(`/tiles/${tx}_${ty}.json?v=${this.cfg.tiles_version ?? 0}`)   // pre-built static tile; ?v busts the browser cache after a rebuild
      if (!res.ok) res = await fetch(`/api/tiles/${tx}/${ty}`)  // build on demand
      if (!res.ok) throw new Error(`tile ${key}: ${res.status}`)
      const data = await res.json()
      if (!this.tiles.has(key)) return                          // player already moved away
      this.queue.push({ tx, ty, key, data })
    } catch (e) {
      console.warn(e)
      this.tiles.delete(key)
    }
  }

  build(tx, ty, key, data) {
    try {
      const objects = new Map(), reg = (key, handle) => objects.set(key, handle)
      const terrain = new TerrainTile(data, this.cfg, data.cover?.length ? paintCover(data.cover, data.cover_sub ?? []) : null)
      const group = new THREE.Group()
      group.add(terrain.mesh)
      const water = buildWater(data.cover ?? [], (x, z) => terrain.heightAt(x, z), data.origin)
      if (water) group.add(water)
      const roads = buildRoads(data.roads, data.junctions, data.biome, (x, z) => terrain.heightAt(x, z))
      if (roads) group.add(roads)
      const roadIndex = indexRoads(data.roads, data.junctions ?? [])
      const buildings = buildBuildings(data.buildings, reg)
      if (buildings) group.add(buildings)
      const meshes = buildBuildingMeshes(data.meshes, reg)
      if (meshes) group.add(meshes)
      const trees = buildTrees(data.trees, (x, z) => terrain.heightAt(x, z), reg)
      if (trees) group.add(trees)
      if (data.furniture) {                                       // lamp posts, traffic lights, traffic signs
        const ground = (x, z) => roadHeight(roadIndex, x, z, terrain)
        for (const part of [buildLamps(data.furniture.lamps, ground, reg), buildSignals(data.furniture.signals, ground, reg), buildSigns(data.furniture.signs, ground, reg)]) if (part) group.add(part)
      }
      noOutlineInstanced(group)                                   // trees, grass, lamps, signs, pads: outlines ignore instanceMatrix
      this.scene.add(group)
      const tile = { key, tx, ty, group, terrain, roads: data.roads, roadIndex, junctions: data.junctions ?? [], biome: data.biome, objects, cover: data.cover ?? [], coverSub: data.cover_sub ?? [] }
      this.tiles.set(key, tile)
      this.hooks.onTile?.(tile)
    } catch (e) {
      console.warn(e)
      this.tiles.delete(key)
    }
  }

  dispose(t) {
    this.hooks.onDrop?.(t)
    this.scene.remove(t.group)
    t.group.traverse((o) => {
      o.userData.onDispose?.()                                             // e.g. traffic lights leave the animation set
      if (o.isInstancedMesh) o.dispose()                                   // instance buffers
      if (o.geometry && !o.geometry.__shared) o.geometry.dispose()
      if (o.material && !o.material.__shared) { o.material.map?.dispose(); o.material.dispose() }
    })
  }
}

// ---- road height lookup -----------------------------------------------------------------------------------------
// A uniform grid over the tile's road segments so a height query touches a handful of segments instead of all
// ~800 in a town tile: the suspension asks five times per frame, the camera once more.
const EDGE = 0.3                                          // blend band either side of the ribbon edge
const REACH = 3                                           // metres beyond the edge that nearRoad may be asked about (sidewalks)
const CELL = 25

function indexRoads(roads, junctions) {
  const segs = []                                         // [ax, az, ay, bx, bz, by, hw]
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, pad = EDGE + REACH
  for (const road of roads ?? []) {
    const hw = road.width / 2, pts = road.pts
    pad = Math.max(pad, hw + EDGE + REACH)
    for (let i = 1; i < pts.length; i++) {
      const [ax, az, ay] = pts[i - 1], [bx, bz, by] = pts[i]
      segs.push([ax, az, ay, bx, bz, by, hw])
      minX = Math.min(minX, ax, bx); maxX = Math.max(maxX, ax, bx); minZ = Math.min(minZ, az, bz); maxZ = Math.max(maxZ, az, bz)
    }
  }
  for (const [jx, jz, , r] of junctions) { pad = Math.max(pad, r + EDGE + REACH); minX = Math.min(minX, jx); maxX = Math.max(maxX, jx); minZ = Math.min(minZ, jz); maxZ = Math.max(maxZ, jz) }
  if (!segs.length && !junctions.length) return null
  const x0 = minX - pad, z0 = minZ - pad
  const nx = Math.ceil((maxX + pad - x0) / CELL) + 1, nz = Math.ceil((maxZ + pad - z0) / CELL) + 1
  const cells = new Array(nx * nz)
  const put = (bx0, bz0, bx1, bz1, item) => {
    const cx0 = Math.max(0, Math.floor((bx0 - x0) / CELL)), cx1 = Math.min(nx - 1, Math.floor((bx1 - x0) / CELL))
    const cz0 = Math.max(0, Math.floor((bz0 - z0) / CELL)), cz1 = Math.min(nz - 1, Math.floor((bz1 - z0) / CELL))
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) (cells[cz * nx + cx] ??= []).push(item)
  }
  for (const s of segs) {
    const r = s[6] + EDGE + REACH
    put(Math.min(s[0], s[3]) - r, Math.min(s[1], s[4]) - r, Math.max(s[0], s[3]) + r, Math.max(s[1], s[4]) + r, s)
  }
  for (const j of junctions) { const r = j[3] + EDGE + REACH; put(j[0] - r, j[1] - r, j[0] + r, j[1] + r, j) }   // junctions are 4-element arrays
  return { x0, z0, nx, nz, cells }
}

// whether (x, z) lies within `margin` metres of a road ribbon or junction patch (margin up to REACH)
export function nearRoad(index, x, z, margin) {
  if (!index) return false
  const cx = Math.floor((x - index.x0) / CELL), cz = Math.floor((z - index.z0) / CELL)
  if (cx < 0 || cz < 0 || cx >= index.nx || cz >= index.nz) return false
  for (const s of index.cells[cz * index.nx + cx] ?? []) {
    let out
    if (s.length === 4) out = Math.hypot(s[0] - x, s[1] - z) - s[3]
    else {
      const dx = s[3] - s[0], dz = s[4] - s[1], len2 = dx * dx + dz * dz || 1
      const t = Math.max(0, Math.min(1, ((x - s[0]) * dx + (z - s[1]) * dz) / len2))
      out = Math.hypot(s[0] + dx * t - x, s[1] + dz * t - z) - s[6]
    }
    if (out <= margin) return true
  }
  return false
}

// Ground height at (x, z): on a road ribbon or junction patch it is the surface the client draws (the road level or the
// terrain, whichever is higher, plus ROAD_LIFT); across a band of ±EDGE around the ribbon edge it blends smoothly into
// the terrain so wheels roll over the curb instead of snapping. Continuous in (x, z), so per-wheel probing never jitters.
function roadHeight(index, x, z, terrain) {
  const ground = terrain.heightAt(x, z)
  if (!index) return ground
  const cx = Math.floor((x - index.x0) / CELL), cz = Math.floor((z - index.z0) / CELL)
  if (cx < 0 || cz < 0 || cx >= index.nx || cz >= index.nz) return ground
  const items = index.cells[cz * index.nx + cx]
  if (!items) return ground
  let best = null, bestOut = Infinity                       // distance outside the ribbon edge (negative inside)
  for (const s of items) {
    let out, h
    if (s.length === 4) {                                   // junction disc [x, z, y, r]
      out = Math.hypot(s[0] - x, s[1] - z) - s[3]; h = s[2]
    } else {
      const dx = s[3] - s[0], dz = s[4] - s[1]
      const len2 = dx * dx + dz * dz || 1
      const t = Math.max(0, Math.min(1, ((x - s[0]) * dx + (z - s[1]) * dz) / len2))
      out = Math.hypot(s[0] + dx * t - x, s[1] + dz * t - z) - s[6]; h = s[2] + (s[5] - s[2]) * t
    }
    if (out <= EDGE && out < bestOut) { bestOut = out; best = h }
  }
  if (best === null) return ground
  const on = Math.max(best, ground) + ROAD_LIFT
  if (bestOut <= -EDGE) return on
  const k0 = (bestOut + EDGE) / (2 * EDGE), k = k0 * k0 * (3 - 2 * k0)   // smoothstep over the curb band
  return on + (ground - on) * k
}
