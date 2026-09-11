import * as THREE from "three"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"
import { drape, ringsToTriangles } from "game/Drape"
import { texture, speckle, grain, cracks, bricks, grey, rng } from "game/Textures"
import { noOutline } from "game/Outline"

// What the roads are made of, as surveyed. BGT maps every carriageway, cycle path, footway, parking bay, driveway
// and traffic island as a polygon, and the tile ships them as [class, material, ring…] with rings as flat decimetre
// offsets from the north-west corner, read exactly like `cover`. Junctions need no code of their own: the server
// unions the approach legs into one polygon before it sends them.
//
// Every polygon is triangulated, cut to the terrain grid (game/Drape.js) and laid a few centimetres above the
// ground, so nothing pokes through and no polygon offset is needed. The raised classes — footways, islands, parking
// — get a kerb along the edges that face a street. The lane markings stay with the centrelines in game/Roads.js,
// because a polygon has no along-the-road direction to hang them on.
const ROAD = 0, CYCLE = 1, FOOT = 2, PARKING = 3, DRIVEWAY = 4, ISLAND = 5
const RAISED = new Set([ FOOT, ISLAND ])            // a parking bay is part of the carriageway; a footway is a kerb above it
const LIFT = 0.07, KERB = 0.12          // the lift clears Drape's tolerance, so the ground never comes through
const EDGE = 0.05                                   // a ring segment this close to the tile edge is the neighbour's job

// (class, material) → the surface it is made of. Material 0 is closed paving (asphalt, concrete), 1 open (bricks
// and tiles), 2 half-paved (gravel), 3 unpaved (sand and earth).
function styleOf(cls, mat) {
  if (mat === 2) return "grind"
  if (mat === 3) return "zand"
  if (cls === CYCLE) return mat === 1 ? "klinker" : "fietspad"
  if (mat === 1) return cls === ROAD || cls === DRIVEWAY ? "klinker" : "tegel"
  return "asfalt"
}
const ALIGNED = new Set([ "klinker", "tegel" ])     // brick and tiles have a direction: lay them along the street

const DRAW = {
  asfalt: [3, (ctx, size) => { const r = rng(41); speckle(ctx, size, 96, 22, 9000, 3, r); grain(ctx, size, 96, 40, 12000, 2, r, 0.5); cracks(ctx, size, 5, 60, r) }],
  fietspad: [3, (ctx, size) => { const r = rng(42); speckle(ctx, size, 120, 18, 9000, 3, r); grain(ctx, size, 110, 30, 9000, 2, r, 0.4) }],
  klinker: [2.4, (ctx, size) => bricks(ctx, size, { mortar: "#8f8880", palette: ["#9b8d81", "#93857a", "#a3958a", "#8b7d73", "#a89a8f"], rows: 8, cols: 24, rnd: rng(43) })],
  tegel: [1.2, (ctx, size) => {
    const r = rng(44), n = 4, w = size / n
    ctx.fillStyle = "#9a958d"; ctx.fillRect(0, 0, size, size)
    for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) {
      const x = col * w + 2, y = row * w + 2, s = w - 4
      ctx.fillStyle = grey(150 + r() * 30); ctx.fillRect(x, y, s, s)
      ctx.fillStyle = "rgba(255,255,255,.12)"; ctx.fillRect(x, y, s, 3)
      ctx.fillStyle = "rgba(0,0,0,.18)"; ctx.fillRect(x, y + s - 3, s, 3)
    }
    grain(ctx, size, 150, 40, 5000, 2, r, 0.35)
  }],
  grind: [1.5, (ctx, size) => { const r = rng(45); speckle(ctx, size, 150, 30, 9000, 3, r); grain(ctx, size, 150, 50, 9000, 4, r, 0.5) }],
  zand: [2, (ctx, size) => { const r = rng(46); speckle(ctx, size, 168, 20, 7000, 4, r); grain(ctx, size, 160, 30, 6000, 3, r, 0.4) }],
}
const TINT = { asfalt: 0x6e7176, fietspad: 0x9c4a3c, klinker: 0xa79a8c, tegel: 0xb6b1a8, grind: 0xa89a84, zand: 0xc3b394 }

const materials = {}
function material(name) {
  return materials[name] ??= noOutline(Object.assign(
    new THREE.MeshStandardMaterial({ map: texture(DRAW[name][0], DRAW[name][1]), color: TINT[name], roughness: 0.95 }), { __shared: true }))
}
const kerbMat = noOutline(Object.assign(new THREE.MeshStandardMaterial({ color: 0xb7b2a8, roughness: 0.9, side: THREE.DoubleSide }), { __shared: true }))

// surfaces: the tile array. origin: the tile's north-west corner in game units. terrainAt: the ground height.
// ctx.nearRoad(x, z, margin) says whether a point is on a road ribbon; ctx.headingAt(x, z) gives the direction of
// the nearest centreline, for laying bricks along the street.
export function buildSurfaces(surfaces, origin, terrainAt, ctx = {}) {
  if (!surfaces?.length) return null
  const [ox, oz] = origin, x1 = ox + 500, z1 = oz + 500
  const byMat = new Map()
  const add = (mat, geo) => { if (!geo) return; if (!byMat.has(mat)) byMat.set(mat, []); byMat.get(mat).push(geo) }
  const kerbs = []
  for (const entry of surfaces) {
    const cls = entry[0], mat = entry[1]
    const rings = []
    for (let r = 2; r < entry.length; r++) {
      const dm = entry[r], ring = new Array(dm.length)
      for (let i = 0; i < dm.length; i += 2) { ring[i] = ox + dm[i] / 10; ring[i + 1] = oz + dm[i + 1] / 10 }
      rings.push(ring)
    }
    if (!rings.length) continue
    const name = styleOf(cls, mat)
    const raised = RAISED.has(cls)
    const tris = drape(ringsToTriangles(rings), { heightAt: terrainAt })
    if (!tris.length) continue
    const angle = ALIGNED.has(name) && ctx.headingAt ? ctx.headingAt(rings[0][0], rings[0][1]) : 0
    add(material(name), toGeometry(tris, terrainAt, LIFT + (raised ? KERB : 0), angle))
    if (raised) kerbs.push(...kerbSkirt(rings, terrainAt, ctx.nearRoad, ox, oz, x1, z1))
  }
  if (kerbs.length) add(kerbMat, kerbGeometry(kerbs))
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

// draped triangles ([x, z, u, v]) → a geometry on the ground, with the texture frame turned by `angle`
function toGeometry(tris, terrainAt, lift, angle) {
  const pos = [], uv = []
  const ca = Math.cos(angle), sa = Math.sin(angle)
  for (const t of tris) for (const v of t) {
    pos.push(v[0], terrainAt(v[0], v[1]) + lift, v[1])
    uv.push(v[2] * ca + v[3] * sa, -v[2] * sa + v[3] * ca)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2))
  return g
}

// the vertical face of a kerb, along every edge of a raised polygon: where the neighbour is raised too the face is
// buried inside it, and where it is not — a carriageway, a parking bay, a verge — it closes the step that would
// otherwise show the ground through it. A segment lying on the tile border is left to the neighbouring tile, or
// both would draw one and a wall would run down the pavement at every seam.
function kerbSkirt(rings, terrainAt, nearRoad, ox, oz, x1, z1) {
  const out = []
  const onEdge = (x, z) => Math.abs(x - ox) < EDGE || Math.abs(x - x1) < EDGE || Math.abs(z - oz) < EDGE || Math.abs(z - z1) < EDGE
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 2) {
      const j = (i + 2) % ring.length
      const ax = ring[i], az = ring[i + 1], bx = ring[j], bz = ring[j + 1]
      if (onEdge(ax, az) && onEdge(bx, bz)) continue
      out.push([ax, az, bx, bz, terrainAt(ax, az), terrainAt(bx, bz)])
    }
  }
  return out
}

function kerbGeometry(segments) {
  const pos = []
  for (const [ax, az, bx, bz, ya, yb] of segments) {
    const ta = ya + LIFT + KERB, tb = yb + LIFT + KERB, ba = ya + LIFT - 0.02, bb = yb + LIFT - 0.02
    pos.push(ax, ta, az, bx, tb, bz, bx, bb, bz)
    pos.push(ax, ta, az, bx, bb, bz, ax, ba, az)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3 * 2), 2))
  return g
}
