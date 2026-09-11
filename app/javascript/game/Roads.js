import * as THREE from "three"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"
import { noOutline } from "game/Outline"
import { drape } from "game/Drape"

// What the centrelines still draw. The road surface itself comes from the surveyed BGT outlines (game/Surfaces.js);
// this module keeps the things that need a direction along the road: the lane markings, and the bridges.
//
// Tile entries carry ready-made 3D centrelines (RoadBuilder: smoothed, junction-pinned, seated in the terrain) as
// pts [x, z, y] where y IS the road surface level, already cut back where three or more roads meet, so markings
// stop short of a crossing on their own. Markings are drawn as an alpha-tested ribbon over the full road width.
// A road BGT does not pave (`ribbon`, the German border strip, a new estate) falls back to the old full-width
// ribbon with its own asphalt, klinkers or gravel, its sidewalks and a patch over the junctions.
export const ROAD_LIFT = 0.05
export const CURB = 0.12
const MARK = 0.13                                    // the markings ride above the surveyed surface under them
const LIFT = ROAD_LIFT, TEX_LEN = 24, SIDEWALK = 1.7
const URBAN = new Set(["stad", "woonwijk", "dorp"])

const textures = {}
function texture(name) {
  if (textures[name]) return textures[name]
  const c = document.createElement("canvas"); c.width = 256; c.height = 512
  const ctx = c.getContext("2d")
  const marks = name.startsWith("mark-")
  const base = { cycle: "#8a3d34", gravel: "#9c8d72", klinker: "#7a6459", pavers: "#a9a29a" }[name.split("-")[0]] ?? "#3b3c40"
  if (!marks) { ctx.fillStyle = base; ctx.fillRect(0, 0, 256, 512) }
  // speckle
  const rnd = mulberry32(7)
  if (!marks) {
    ctx.globalAlpha = 0.18
    for (let i = 0; i < 1800; i++) { ctx.fillStyle = rnd() > 0.5 ? "#000" : "#fff"; ctx.fillRect(rnd() * 256, rnd() * 512, 2, 2) }
    ctx.globalAlpha = 1
  }
  if (name === "klinker") {                     // brick bond
    ctx.strokeStyle = "rgba(0,0,0,.35)"; ctx.lineWidth = 2
    for (let y = 0; y < 512; y += 20) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(256, y); ctx.stroke()
      for (let x = (y / 20) % 2 ? 0 : 12; x < 256; x += 24) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 20); ctx.stroke() } }
  }
  if (name === "pavers") {
    ctx.strokeStyle = "rgba(0,0,0,.25)"; ctx.lineWidth = 2
    for (let y = 0; y < 512; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(256, y); ctx.stroke() }
    for (let x = 0; x < 256; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 512); ctx.stroke() }
  }
  const white = "#e8e8e2"
  const edge = () => { ctx.fillStyle = white; ctx.fillRect(8, 0, 5, 512); ctx.fillRect(243, 0, 5, 512) }
  const dashes = (x, on = 3, off = 9) => { ctx.fillStyle = white; for (let y = 0; y < 512; y += (on + off) * (512 / TEX_LEN)) ctx.fillRect(x - 2, y, 5, on * (512 / TEX_LEN)) }
  if (name === "asphalt-edge-centre" || name === "mark-edge-centre") { edge(); dashes(128) }
  if (name === "asphalt-centre" || name === "mark-centre") dashes(128)
  if (name.startsWith("asphalt-lanes-") || name.startsWith("mark-lanes-")) { edge(); const lanes = Number(name.split("-").at(-1)); for (let i = 1; i < lanes; i++) dashes(256 * i / lanes, 3, 6) }
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4
  textures[name] = tex
  return tex
}

const markMaterials = {}
function markMaterial(name) {
  return markMaterials[name] ??= noOutline(Object.assign(
    new THREE.MeshStandardMaterial({ map: texture(name), roughness: 0.9, alphaTest: 0.5, transparent: false }), { __shared: true }))
}

const materials = {}
function material(name) {
  return materials[name] ??= noOutline(Object.assign(new THREE.MeshStandardMaterial({ map: texture(name), roughness: 0.95 }), { __shared: true }))
}
const junctionMat = noOutline(Object.assign(new THREE.MeshStandardMaterial({ map: texture("asphalt"), roughness: 0.95 }), { __shared: true }))
const concrete = Object.assign(new THREE.MeshStandardMaterial({ color: 0x9a9892, roughness: 0.9 }), { __shared: true })

// the lane markings a road carries, or null for the quiet streets that have none
function markingsOf(road, urban) {
  const k = road.kind
  if (k === "cycleway" || k === "track" || k === "service" || k === "living_street") return null
  if (k === "motorway" || k === "trunk") return `mark-lanes-${Math.min(4, Math.max(2, road.lanes ?? 2))}`
  if (k === "motorway_link" || k === "trunk_link") return null
  if (k === "primary" || k === "secondary") return urban ? "mark-centre" : "mark-edge-centre"
  if (k === "tertiary" || k === "unclassified") return !urban && road.width >= 5.5 ? "mark-centre" : null
  return null
}

// which texture a fallback ribbon gets: class, width, surface and whether the tile is built-up decide
function styleOf(road, urban) {
  const k = road.kind, s = road.surface ?? ""
  if (k === "cycleway") return "cycle"
  if (k === "track" || /unpaved|gravel|ground|dirt|compacted|fine_gravel/.test(s)) return "gravel"
  if (k === "living_street" || /paving_stones|sett|cobblestone/.test(s)) return "klinker"
  if (k === "motorway" || k === "trunk") return `asphalt-lanes-${Math.min(4, Math.max(2, road.lanes ?? 2))}`
  if (k === "motorway_link" || k === "trunk_link" || k === "service") return "asphalt"
  if (k === "primary" || k === "secondary") return urban ? "asphalt-centre" : "asphalt-edge-centre"
  if (k === "tertiary" || k === "unclassified") return urban ? "asphalt" : (road.width >= 5.5 ? "asphalt-centre" : "asphalt")
  return "asphalt"                                    // residential and the rest: no markings
}
// raised sidewalks along neighbourhood streets in built-up tiles; through roads have their own BGT footways and cycle paths
const sidewalks = (road, urban) => urban && !road.oneway && ["residential", "living_street", "unclassified"].includes(road.kind)

// terrainAt(x, z) is the tile's terrain height; ribbons and patches never sink below it
export function buildRoads(roads, junctions, biome, terrainAt = null) {
  const urban = URBAN.has(biome)
  const byMat = new Map()
  const add = (mat, geo) => { if (!byMat.has(mat)) byMat.set(mat, []); byMat.get(mat).push(geo) }
  let fallback = false
  for (const road of roads) {
    if (road.pts.length < 2) continue
    if (road.ribbon) {                                             // BGT does not pave this one: draw it ourselves
      fallback = true
      add(material(styleOf(road, urban)), ribbon(road.pts, road.width / 2, LIFT, 0, terrainAt))
      if (sidewalks(road, urban)) {
        for (const side of [-1, 1]) add(material("pavers"), ribbon(road.pts, SIDEWALK / 2, LIFT + CURB, side * (road.width / 2 + SIDEWALK / 2), terrainAt))
      }
    }
    const marks = markingsOf(road, urban)
    if (marks) add(markMaterial(marks), ribbon(road.pts, road.width / 2, MARK, 0, terrainAt))
    for (const span of bridgeRuns(road.pts)) {
      for (const side of [-1, 1]) add(concrete, wall(span, LIFT + 0.9, LIFT, side * (road.width / 2 + 0.15)))
      add(concrete, pillars(span, road, roads))
    }
  }
  for (const [x, z, y, r] of fallback ? junctions ?? [] : []) {      // the surveyed outlines already cover a crossing
    const tris = []
    for (let i = 0; i < 16; i++) {                               // a fan, in 2D, with the junction's level on every vertex
      const a = i / 16 * Math.PI * 2, b = (i + 1) / 16 * Math.PI * 2
      tris.push([[x, z, 0.5, 0.5, y], [x + Math.cos(b) * r, z + Math.sin(b) * r, 0.5, 0.5, y], [x + Math.cos(a) * r, z + Math.sin(a) * r, 0.5, 0.5, y]])
    }
    add(junctionMat, toGeometry(drape(tris, { heightAt: terrainAt }), LIFT + 0.01, terrainAt))
  }
  if (!byMat.size) return null
  const group = new THREE.Group()
  for (const [mat, geos] of byMat) {
    const merged = mergeGeometries(geos, false)
    geos.forEach((g) => g.dispose())
    merged.computeVertexNormals()
    group.add(new THREE.Mesh(merged, mat))
  }
  return group
}

// A flat ribbon along pts ([x, z, y]) of half-width hw, shifted sideways by `offset` metres. It is built in 2D,
// cut to the terrain grid (game/Drape.js) and only then lifted, so it sits a constant `lift` above the higher of
// the road's own level and the ground under it and can never be pierced between two vertices. `wall` is the other
// shape a road needs: a vertical strip for a bridge parapet, which follows the deck and is not draped.
function edgesOf(pts, hw, offset) {
  const edges = []
  for (let i = 0; i < pts.length; i++) {
    const [x, z] = pts[i]
    const [px, pz] = pts[Math.max(i - 1, 0)], [nx, nz] = pts[Math.min(i + 1, pts.length - 1)]
    let dx = nx - px, dz = nz - pz
    const len = Math.hypot(dx, dz) || 1
    dx /= len; dz /= len
    const lx = -dz, lz = dx                                   // left-hand unit vector
    const cx = x + lx * offset, cz = z + lz * offset
    edges.push([cx + lx * hw, cz + lz * hw, cx - lx * hw, cz - lz * hw, cx, cz])
  }
  return edges
}

function ribbon(pts, hw, lift, offset = 0, terrainAt = null) {
  const edges = edgesOf(pts, hw, offset)
  const tris = []
  let along = 0
  for (let i = 1; i < pts.length; i++) {
    const va = along
    along += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
    const [alx, alz, arx, arz] = edges[i - 1], [blx, blz, brx, brz] = edges[i]
    const ya = pts[i - 1][2], yb = pts[i][2]
    const L0 = [alx, alz, 0, va / TEX_LEN, ya], R0 = [arx, arz, 1, va / TEX_LEN, ya]
    const L1 = [blx, blz, 0, along / TEX_LEN, yb], R1 = [brx, brz, 1, along / TEX_LEN, yb]
    tris.push([L0, L1, R0], [R0, L1, R1])
  }
  return toGeometry(drape(tris, { heightAt: terrainAt }), lift, terrainAt)
}

// draped triangles ([x, z, u, v, level]) → a geometry, every vertex lifted above whichever is higher
function toGeometry(tris, lift, terrainAt) {
  const pos = [], uv = []
  for (const t of tris) for (const v of t) {
    pos.push(v[0], (terrainAt ? Math.max(v[4], terrainAt(v[0], v[1])) : v[4]) + lift, v[1])
    uv.push(v[2], v[3])
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2))
  return g
}

// a vertical strip along the (offset) centre line, from `bottom` to `top` above the road level: bridge parapets
function wall(pts, top, bottom, offset) {
  const edges = edgesOf(pts, 0, offset)
  const verts = [], uvs = [], idx = []
  let along = 0
  for (let i = 0; i < pts.length; i++) {
    const y = pts[i][2]
    if (i > 0) along += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
    const [, , , , cx, cz] = edges[i]
    verts.push(cx, y + bottom, cz, cx, y + top, cz)
    uvs.push(0, along / TEX_LEN, 1, along / TEX_LEN)
    if (i > 0) { const a = 2 * (i - 1); idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3) }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3))
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2))
  g.setIndex(idx)
  return g.toNonIndexed()
}

// bridge pillars about every 25 m along the deck, from the deck down 40 m (the terrain or water cuts them off),
// turned to the deck heading; a pillar that would land on another road moves along the deck until it stands clear
function pillars(pts, road, roads) {
  const geos = []
  const across = Math.max(1.2, road.width * 0.35)
  let along = 0, last = -13
  for (let i = 1; i < pts.length; i++) {
    const [ax, az, ay] = pts[i - 1], [bx, bz, by] = pts[i]
    const seg = Math.hypot(bx - ax, bz - az)
    for (let d = 0; d < seg; d += 2) {
      if (along + d - last < 25) continue
      const t = d / seg, x = ax + (bx - ax) * t, z = az + (bz - az) * t
      if (!clearOfRoads(x, z, roads, road, across / 2 + 1)) continue
      const g = new THREE.BoxGeometry(1.2, 40, across)
      g.rotateY(-Math.atan2(bz - az, bx - ax))
      g.translate(x, ay + (by - ay) * t - 20 + LIFT, z)
      const ng = g.toNonIndexed()
      ng.deleteAttribute("normal")
      ng.deleteAttribute("uv"); ng.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(ng.attributes.position.count * 2), 2))
      geos.push(ng)
      last = along + d
    }
    along += seg
  }
  if (!geos.length) { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute([], 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute([], 2)); return g }
  const merged = mergeGeometries(geos, false); geos.forEach((g) => g.dispose()); return merged
}

// whether (x, z) keeps `margin` metres between itself and the ribbon of every road but `own`
function clearOfRoads(x, z, roads, own, margin) {
  for (const r of roads) {
    if (r === own) continue
    const reach = r.width / 2 + margin
    for (let i = 1; i < r.pts.length; i++) {
      const [ax, az] = r.pts[i - 1], [bx, bz] = r.pts[i]
      const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz
      const t = len2 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / len2)) : 0
      if (Math.hypot(ax + dx * t - x, az + dz * t - z) < reach) return false
    }
  }
  return true
}

// consecutive runs of bridge points ([x, z, y, 1]), each at least two points long
function bridgeRuns(pts) {
  const runs = []
  let run = []
  for (const p of pts) { if (p[3] === 1) run.push(p); else { if (run.length > 1) runs.push(run); run = [] } }
  if (run.length > 1) runs.push(run)
  return runs
}

function mulberry32(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
