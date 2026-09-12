import * as THREE from "three"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"
import { noOutline } from "game/Outline"
import { ROAD_LIFT } from "game/Roads"

// Bridges. The server already decides where one is (tagged, over water, or floating above the terrain for long
// enough) and gives the deck its ramps, so what is left is the object itself: a slab with a fascia and a soffit, a
// parapet with an outer face, an inner face and a cap, two steel rails with a post every couple of metres, an
// abutment at each end where the deck leaves the ground, and piers — a cap beam on twin columns — every twenty-odd
// metres. Before this a bridge was two single-sided walls and a buried box every 25 m, with a deck of no thickness
// that vanished when seen edge-on and ended in mid-air over the embankment.
//
// Tile road entries carry pts [x, z, y, bridge?]; a run of points flagged 1 is one bridge. A pier never lands on
// another road, and the side of a deck that faces its twin carriageway gets no parapet or railing, so a dual
// carriageway reads as one bridge rather than two with a fence down the middle.
const DECK = 1.15                                     // how thick the slab looks from the side
const OVER = 0.6, LIP = 0.15                          // the deck oversails the road by this much; the parapet stands this far in
const PARAPET = 0.34, CAP = 0.08
const RAIL = { low: 0.72, high: 1.1, thick: 0.05, post: 2.2, postWidth: 0.07 }
const PIER = { every: 22, width: 1.0, depth: 1.3, cap: 0.9, over: 0.8, bury: 1.5, clear: 1.0 }
const ABUT = { depth: 2.4, over: 1.6, bury: 0.6, least: 0.6 }
const LAMP = { every: 30, height: 5, arm: 1.4 }

const concrete = noOutline(Object.assign(new THREE.MeshStandardMaterial({ color: 0x9a9892, roughness: 0.9 }), { __shared: true }))
const dark = noOutline(Object.assign(new THREE.MeshStandardMaterial({ color: 0x6f6d69, roughness: 0.9 }), { __shared: true }))
const steel = noOutline(Object.assign(new THREE.MeshStandardMaterial({ color: 0x8d9093, roughness: 0.5, metalness: 0.6 }), { __shared: true }))
const lampHead = noOutline(Object.assign(new THREE.MeshStandardMaterial({ color: 0xdedcd0, emissive: 0xfff1c4, emissiveIntensity: 0.4, roughness: 0.4 }), { __shared: true }))

export function buildBridges(roads, terrainAt) {
  const parts = new Map()
  const add = (mat, geo) => { if (!geo) return; if (!parts.has(mat)) parts.set(mat, []); parts.get(mat).push(geo) }
  for (const road of roads ?? []) {
    for (const span of runs(road.pts)) {
      const hw = road.width / 2
      const outer = offset(span, hw + OVER), inner = offset(span, hw + OVER - LIP)
      const open = [0, 1].map((side) => twinAlongside(mid(outer[side]), span, roads, road, hw))
      for (const side of [0, 1]) {
        const top = outer[side], lip = inner[side]
        add(concrete, strip(shift(top, 0.05), shift(top, -DECK)))                 // the fascia down the side
        add(concrete, strip(shift(top, PARAPET), shift(top, 0.05)))               // the parapet, outside
        if (open[side]) continue
        add(concrete, strip(shift(lip, PARAPET), shift(lip, 0.06)))               // …and inside
        add(dark, strip(shift(top, PARAPET), shift(lip, PARAPET)))                // the cap over both
        add(dark, strip(shift(top, PARAPET + CAP), shift(top, PARAPET)))
        add(steel, rails(top))
      }
      add(dark, strip(shift(outer[0], -DECK), shift(outer[1], -DECK)))            // the soffit, seen from below
      add(concrete, supports(span, road, roads, terrainAt))
      if (!open[0]) addLamps(add, outer[0], span)
    }
  }
  if (!parts.size) return null
  const group = new THREE.Group()
  for (const [mat, geos] of parts) {
    const merged = merge(geos)
    if (!merged) continue
    merged.computeVertexNormals()                     // flat shading, and the strips and boxes agree on it
    group.add(new THREE.Mesh(merged, mat))
  }
  return group.children.length ? group : null
}

// consecutive runs of bridge points ([x, z, y, 1]), each at least two points long
// The deck as something to drive on. The drawn bridge is a shell — fascia, parapet, railing — and the terrain
// heightfield underneath it is the valley floor, so without this a car with a real chassis drives off the bank and
// into the river. One oriented slab per deck segment, the width the deck is drawn and topped at the surface
// `ChunkManager.heightAt` reports (the road level plus ROAD_LIFT), with a little overlap at the joints so a bend
// does not open a gap. Bridges are rare — about a third of a span per tile — so this costs a handful of colliders.
export function bridgeDecks(roads) {
  const out = []
  const thick = DECK + ROAD_LIFT
  for (const road of roads ?? []) {
    for (const span of runs(road.pts)) {
      for (let i = 1; i < span.length; i++) {
        const [ax, az, ay] = span[i - 1], [bx, bz, by] = span[i]
        const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz)
        if (len < 0.05) continue
        out.push({
          x: (ax + bx) / 2, y: (ay + by) / 2 + ROAD_LIFT - thick / 2, z: (az + bz) / 2,
          hx: road.width / 2 + OVER, hy: thick / 2, hz: len / 2 + 0.25,
          yaw: Math.atan2(dx, dz),                              // local +z runs along the segment
        })
      }
    }
  }
  return out
}

function runs(pts) {
  const out = []
  let run = []
  for (const p of pts) { if (p[3] === 1) run.push(p); else { if (run.length > 1) out.push(run); run = [] } }
  if (run.length > 1) out.push(run)
  return out
}

// the deck's two edges as 3D polylines [x, y, z]
function offset(pts, hw) {
  const left = [], right = []
  for (let i = 0; i < pts.length; i++) {
    const [x, z, y] = pts[i]
    const [px, pz] = pts[Math.max(i - 1, 0)], [nx, nz] = pts[Math.min(i + 1, pts.length - 1)]
    let dx = nx - px, dz = nz - pz
    const len = Math.hypot(dx, dz) || 1
    dx /= len; dz /= len
    left.push([x - dz * hw, y, z + dx * hw])
    right.push([x + dz * hw, y, z - dx * hw])
  }
  return [left, right]
}

const shift = (line, dy) => line.map(([x, y, z]) => [x, y + dy, z])
const mid = (line) => line[Math.floor(line.length / 2)]

// two triangles per rib between two polylines, wound so the normal points outwards from the deck
function strip(a, b) {
  const pos = []
  for (let i = 1; i < a.length; i++) {
    const [ax, ay, az] = a[i - 1], [bx, by, bz] = a[i], [cx, cy, cz] = b[i - 1], [dx, dy, dz] = b[i]
    pos.push(ax, ay, az, cx, cy, cz, bx, by, bz)
    pos.push(bx, by, bz, cx, cy, cz, dx, dy, dz)
  }
  return geometry(pos)
}

function rails(top) {
  const geos = []
  for (const h of [RAIL.low, RAIL.high]) geos.push(strip(shift(top, h + RAIL.thick), shift(top, h)))
  let along = RAIL.post
  for (let i = 1; i < top.length; i++) {
    const [ax, ay, az] = top[i - 1], [bx, , bz] = top[i]
    const seg = Math.hypot(bx - ax, bz - az)
    for (let d = 0; d < seg; d += 0.5) {
      along += 0.5
      if (along < RAIL.post) continue
      along = 0
      const t = d / (seg || 1), x = ax + (bx - ax) * t, z = az + (bz - az) * t, y = ay + (top[i][1] - ay) * t
      geos.push(box(RAIL.postWidth, RAIL.high + RAIL.thick, RAIL.postWidth, 0, x, y + (RAIL.high + RAIL.thick) / 2, z))
    }
  }
  return merge(geos)
}

// an abutment where the deck leaves the ground, and a pier every PIER.every metres in between
function supports(span, road, roads, terrainAt) {
  const geos = []
  const hw = road.width / 2
  let along = PIER.every
  for (let i = 0; i < span.length; i++) {
    const [x, z, y] = span[i]
    const ground = terrainAt ? terrainAt(x, z) : y - 4
    const clear = y - DECK - ground
    const angle = heading(span, i)
    const end = i === 0 || i === span.length - 1
    if (i > 0) along += Math.hypot(x - span[i - 1][0], z - span[i - 1][1])
    if (end && clear > ABUT.least) {
      const h = clear + ABUT.bury
      geos.push(box(road.width + ABUT.over, h, ABUT.depth, angle, x, ground - ABUT.bury + h / 2, z))
      continue
    }
    if (end || along < PIER.every || clear < PIER.clear) continue
    if (!clearOfRoads([x, y, z], roads, road, hw + 1.5)) continue
    along = 0
    geos.push(box(road.width + PIER.over, PIER.cap, PIER.depth + 0.3, angle, x, y - DECK - PIER.cap / 2, z))
    const depth = clear - PIER.cap + PIER.bury
    for (const side of [-1, 1]) {
      const ox = Math.cos(angle) * side * (hw - 0.5), oz = -Math.sin(angle) * side * (hw - 0.5)
      geos.push(box(PIER.width, depth, PIER.depth, angle, x + ox, y - DECK - PIER.cap - depth / 2 + PIER.bury, z + oz))
    }
  }
  return merge(geos)
}

function addLamps(add, line, span) {
  let along = LAMP.every
  for (let i = 1; i < line.length; i++) {
    const [ax, ay, az] = line[i - 1], [bx, , bz] = line[i]
    const seg = Math.hypot(bx - ax, bz - az)
    along += seg
    if (along < LAMP.every) continue
    along = 0
    const angle = heading(span, i)
    add(concrete, box(0.12, LAMP.height, 0.12, angle, ax, ay + LAMP.height / 2, az))
    add(concrete, box(0.1, 0.1, LAMP.arm, angle, ax - Math.sin(angle) * 0, ay + LAMP.height, az))
    add(lampHead, box(0.5, 0.14, 0.26, angle, ax, ay + LAMP.height - 0.05, az))
  }
}

// the compass heading of the deck at point i
function heading(span, i) {
  const a = span[Math.max(i - 1, 0)], b = span[Math.min(i + 1, span.length - 1)]
  return Math.atan2(b[1] - a[1], b[0] - a[0])
}

// Whether the deck's own twin runs along this side: another road close to this edge but well off our own line.
// The test has to tell a twin carriageway from this bridge's own continuation, which the server cuts into a
// separate piece at every junction and which passes straight through the deck line.
function twinAlongside(p, span, roads, own, hw) {
  for (const r of roads) {
    if (r === own || r.pts.length < 2) continue
    const near = nearestOn(r.pts, p[0], p[2])
    if (near.d > hw + 6) continue
    if (nearestOn(span, near.x, near.z).d < 3) continue                    // that is us, carrying on
    return true
  }
  return false
}

// the closest point on a polyline ([x, z, …]) to (x, z), and how far it is
function nearestOn(pts, x, z) {
  let best = { d: Infinity, x: 0, z: 0 }
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i]
    const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz
    const t = len2 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / len2)) : 0
    const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(px - x, pz - z)
    if (d < best.d) best = { d, x: px, z: pz }
  }
  return best
}

// whether (x, y, z) keeps `margin` metres between itself and the ribbon of every road but `own`
export function clearOfRoads(p, roads, own, margin) {
  const [x, , z] = p.length === 3 ? p : [p[0], 0, p[1]]
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

function box(w, h, d, angle, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d)
  g.rotateY(-angle)
  g.translate(x, y, z)
  return g.toNonIndexed()
}

function geometry(pos) {
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  return g
}

// position only: a box comes with normals and UVs and a strip does not, and mergeGeometries refuses the mixture
function merge(geos) {
  const clean = geos.filter(Boolean).map((g) => {
    const n = g.index ? g.toNonIndexed() : g
    n.deleteAttribute("normal"); n.deleteAttribute("uv")
    return n
  })
  if (!clean.length) return null
  const merged = mergeGeometries(clean, false)
  clean.forEach((g) => g.dispose())
  return merged
}
