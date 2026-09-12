import * as THREE from "three"
import { TUNING as T } from "game/Tuning"
import { WINDOW } from "game/BuildingTextures"
import { bayCount, storeyCount } from "game/BuildingMeshes"
import { hash32, mulberry32 } from "game/Tuning"

// A house, built rather than painted. `BuildingMeshes.js` takes the 3D BAG faces and draws them as a shell with
// windows in the texture; this takes the same faces and makes a stack of pieces out of them — panels with real
// openings and real thickness, each one its own thing that can be broken off, fall, and let you see inside.
//
// The grid is the shell's grid. Bays come from the face's own width and storeys from the building's wall height,
// both rounded to whole numbers by `bayCount`/`storeyCount`, and the opening is punched at exactly the rectangle
// `BuildingTextures` paints its glass into. That is what lets a building swap from shell to structure at eighty
// metres without a window moving: same bond, same rows, same colour — the reveals simply gain depth.
//
// Two things make the odd faces harmless. Everything is done in the face's own plane basis (u along the wall, v
// world up, exactly as earcut already needs it), and every cell of the grid is cut out by clipping the face's
// triangles against it, one half-plane at a time. A gable's slope, a pentagon, a jog — they all come out as
// whatever shape the clip leaves, and only the cells that survive as a whole rectangle are given a window. The
// outline of a cell is then recovered by cancelling the edges that appear twice, which is what turns a soup of
// clipped triangles back into something with a side to extrude.
const EPS = 1e-4
const _u = new THREE.Vector3(), _v = new THREE.Vector3(), _n = new THREE.Vector3(), _p = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0)

// ---- the small geometry kit ----------------------------------------------------------------------------------

// Sutherland–Hodgman against one half-plane (keep where a·x + b·y ≤ c). The subject is convex here — it is a
// triangle, or something already clipped out of one — so this is exact and cannot fold.
function clipHalf(poly, a, b, c) {
  const out = []
  for (let i = 0; i < poly.length; i += 2) {
    const x1 = poly[i], y1 = poly[i + 1], j = (i + 2) % poly.length
    const x2 = poly[j], y2 = poly[j + 1]
    const d1 = a * x1 + b * y1 - c, d2 = a * x2 + b * y2 - c
    if (d1 <= EPS) out.push(x1, y1)
    if ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) {
      const t = d1 / (d1 - d2)
      out.push(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)
    }
  }
  return out.length >= 6 ? out : null
}

// a polygon clipped to the box [u0,u1] × [v0,v1]
function clipBox(poly, u0, v0, u1, v1) {
  let p = clipHalf(poly, -1, 0, -u0)
  if (p) p = clipHalf(p, 1, 0, u1)
  if (p) p = clipHalf(p, 0, -1, -v0)
  if (p) p = clipHalf(p, 0, 1, v1)
  return p
}

function areaOf(poly) {
  let a = 0
  for (let i = 0; i < poly.length; i += 2) {
    const j = (i + 2) % poly.length
    a += poly[i] * poly[j + 1] - poly[j] * poly[i + 1]
  }
  return Math.abs(a) / 2
}

// The outline of a set of polygons that share edges: every interior edge turns up twice, once each way, so hash the
// directed edges and keep the ones whose reverse is missing. Endpoints are quantised to a millimetre, because two
// clips of the same line do not always land on the same float.
function outline(polys) {
  const edges = new Map()
  const key = (x, y) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i += 2) {
      const j = (i + 2) % poly.length
      const a = key(poly[i], poly[i + 1]), b = key(poly[j], poly[j + 1])
      if (a === b) continue
      if (edges.has(`${b}|${a}`)) edges.delete(`${b}|${a}`)
      else edges.set(`${a}|${b}`, [poly[i], poly[i + 1], poly[j], poly[j + 1]])
    }
  }
  return [...edges.values()]
}

// ---- one piece ------------------------------------------------------------------------------------------------

// A slab of wall: the polygons `faces` (in plane coordinates) at depth d, the same again pushed `thick` inwards, and
// a band around every edge of the outline joining the two. `flip` says which way the plane normal points.
function slab(emit, basis, faces, edges, d, thick, mats) {
  const { skin, core } = mats
  for (const poly of faces) {
    fan(emit, skin, basis, poly, d, 1)                 // the street side, in the shell's own brick
    fan(emit, core, basis, poly, d - thick, -1)        // and the room side
  }
  for (const [x1, y1, x2, y2] of edges) band(emit, core, basis, x1, y1, x2, y2, d, thick)
}

// a convex polygon as a triangle fan on the plane at depth d, facing along ±n
function fan(emit, mat, basis, poly, d, dir) {
  const n = poly.length / 2
  for (let i = 1; i + 1 < n; i++) {
    const a = [poly[0], poly[1], d], b = [poly[i * 2], poly[i * 2 + 1], d], c = [poly[i * 2 + 2], poly[i * 2 + 3], d]
    dir > 0 ? emit.tri(mat, basis, a, b, c) : emit.tri(mat, basis, a, c, b)
  }
}

// the thickness of the wall along one outline edge
function band(emit, mat, basis, x1, y1, x2, y2, d, thick) {
  emit.quad(mat, basis, [x1, y1, d], [x2, y2, d], [x2, y2, d - thick], [x1, y1, d - thick])
}

// ---- the wall faces ---------------------------------------------------------------------------------------------

// Everything a building is made of, as pieces, out of the faces packed onto its destructible handle.
export function buildStructure(obj, emit) {
  const S = T.buildings.structure
  const src = obj.src
  if (!src) return []
  const pieces = []
  const [ox, oy, oz] = src.o
  const wallH = obj.wall
  // exactly the count the shell used: clamp it here as well and the rows stop lining up with the painted ones
  const storeys = obj.storeys ?? storeyCount(wallH, src.n)
  const storeyH = wallH / storeys
  const windows = wallH >= T.buildings.minHeight

  for (let fi = 0; fi < src.lab.length; fi++) {
    if (src.lab[fi] === 1) { roofFace(src, fi, obj, emit, pieces, S); continue }
    if (src.lab[fi] !== 2) continue
    const a0 = src.off[fi], a1 = src.off[fi + 1]
    if (a1 - a0 < 3) continue
    // the plane, and the basis the shell already uses: u along the wall, v world up
    const pts = []
    for (let k = a0; k < a1; k++) pts.push(ox + src.xyz[k * 3] / 100, oy + src.xyz[k * 3 + 1] / 100, oz + src.xyz[k * 3 + 2] / 100)
    if (!normalOf(pts, _n)) continue
    if (Math.abs(_n.y) > S.tilt) continue                         // a horizontal sliver BAG labelled "wall"
    _u.copy(UP).cross(_n).normalize()
    _v.crossVectors(_n, _u)
    // outward is whichever way leads away from the middle of the building
    if (_n.x * ((pts[0] + pts[pts.length - 3]) / 2 - obj.x) + _n.z * ((pts[2] + pts[pts.length - 1]) / 2 - obj.z) < 0) {
      _n.negate(); _u.negate()                                    // keep (u, v, n) right-handed
    }
    const basis = { u: _u.clone(), v: _v.clone(), n: _n.clone() }
    const poly = [], d = pts[0] * basis.n.x + pts[1] * basis.n.y + pts[2] * basis.n.z
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity
    for (let i = 0; i < pts.length; i += 3) {
      _p.set(pts[i], pts[i + 1], pts[i + 2])
      const a = _p.dot(basis.u), c = _p.dot(basis.v)
      poly.push(a, c)
      u0 = Math.min(u0, a); u1 = Math.max(u1, a); v0 = Math.min(v0, c); v1 = Math.max(v1, c)
    }
    const width = u1 - u0
    if (width < S.minPiece || v1 - v0 < S.minPiece) continue
    // Triangulate before cutting the grid out of it. Sutherland–Hodgman is only exact on a convex subject, and a
    // wall face is not reliably convex — an L-shaped jog or a notch comes back as a bow tie, which a triangle fan
    // then draws as a spike out the side of the house. A triangle cannot do that to us.
    const tris = triangulate(poly)
    if (!tris.length) continue

    const bays = bayCount(width), bayW = width / bays
    const gevel = windows && width >= T.buildings.minWidth
    // Cut every cell first and take the outline over the face as a whole: where two cells of the same wall meet is
    // not a side of anything, and giving both of them one would double the triangles and run a seam down the wall.
    const cells = []
    for (let bay = 0; bay < bays; bay++) {
      for (let s = 0; s <= storeys; s++) {
        const cv0 = oy + s * storeyH, cv1 = s === storeys ? v1 + 1 : oy + (s + 1) * storeyH
        if (cv1 <= v0 + EPS || cv0 >= v1 - EPS) continue
        const cu0 = u0 + bay * bayW, cu1 = cu0 + bayW
        const parts = []
        let area = 0
        for (const tri of tris) {
          const part = clipBox(tri, cu0, cv0, cu1, cv1)
          if (part) { parts.push(part); area += areaOf(part) }
        }
        if (area < S.minArea) continue
        const top = Math.min(cv1, v1)
        const full = Math.abs(area - bayW * (top - cv0)) < 0.05 && cv1 <= v1 + EPS
        const opening = full && gevel && s < storeys ? windowRect(cu0, cv0, bayW, storeyH) : null
        cells.push({ bay, s, cu0, cu1, cv0, top, parts, opening })
      }
    }
    const rim = outline(cells.flatMap((c) => (c.opening ? holeParts(c) : c.parts)))
    for (const c of cells) {
      const piece = { kind: "wall", face: fi, bay: c.bay, storey: c.s, ranges: [] }
      const mine = rim.filter(([x1, y1, x2, y2]) => inCell(c, (x1 + x2) / 2, (y1 + y2) / 2))
      emit.begin(piece)
      if (c.opening) panelWithHole(emit, basis, d, c, mine, S)
      else slab(emit, basis, c.parts, mine, d, S.thick, { skin: "steen", core: "pleister" })
      emit.end(piece)
      pieces.push(piece)
    }
  }
  if (S.interior) interior(obj, emit, pieces, S, storeys, storeyH)
  return pieces
}

// ---- the inside ---------------------------------------------------------------------------------------------

// Floors, the walls between the rooms, the doorways in them and one flight of stairs per storey. None of this is in
// the data — BAG's LoD2.2 is a hollow shell and the ground faces are dropped server-side — so it is invented, but
// invented from the numbers the building does have: its own footprint, its own storey height, and a generator
// seeded on its id, so the same house always gets the same rooms.
function interior(obj, emit, pieces, S, storeys, storeyH) {
  const oy = obj.src.o[1], rings = obj.rings
  if (!rings?.length || rings[0].length < 8) return
  const eave = Math.min(obj.wall, obj.eave ?? obj.wall)
  const floors = Math.max(1, Math.min(storeys, Math.floor((eave - 0.6) / storeyH)))
  // the footprint in the floor's own plane: u is x, v is -z, which keeps (u, v, up) right-handed
  const shell = []
  for (let i = 0; i + 1 < rings[0].length; i += 2) shell.push(rings[0][i], -rings[0][i + 1])
  // the floor runs out to the footprint: its edge ends up buried inside the 25 cm of wall, which is exactly where
  // the edge of a floor belongs and saves insetting a polygon that is not always convex
  const inner = shell
  if (areaOf(inner) < 4) return
  const tris = triangulate(inner)
  if (!tris.length) return
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity
  for (let i = 0; i < inner.length; i += 2) {
    u0 = Math.min(u0, inner[i]); u1 = Math.max(u1, inner[i])
    v0 = Math.min(v0, inner[i + 1]); v1 = Math.max(v1, inner[i + 1])
  }
  const rnd = mulberry32(hash32(obj.key))
  const stair = wellIn(inner, u0, v0, u1, v1, S)
  const cell = Math.max(2.5, Math.min(7, Math.sqrt(areaOf(inner) / S.slabs)))

  for (let s = 0; s <= floors; s++) {
    const y = oy + s * storeyH
    // the slab: cut into cells so it can come down piece by piece, with the stair well left out of every floor above
    // the ground one
    for (let cu = u0; cu < u1; cu += cell) for (let cv = v0; cv < v1; cv += cell) {
      let parts = []
      for (const tri of tris) { const q = clipBox(tri, cu, cv, cu + cell, cv + cell); if (q) parts.push(q) }
      if (s > 0 && S.stairs && stair) parts = subtractRect(parts, stair)
      const area = parts.reduce((a, q) => a + areaOf(q), 0)
      if (area < S.minArea) continue
      const piece = { kind: "slab", storey: s, ranges: [] }
      emit.begin(piece)
      slab(emit, FLOOR, parts, outline(parts), y, S.floorThick, { skin: "beton", core: "pleister" })
      emit.end(piece)
      pieces.push(piece)
    }
    if (s >= floors) break
    // the rooms: one cut across the long axis, then one across the larger half, each with a doorway left out of it
    for (const cut of rooms(u0, v0, u1, v1, rnd, S)) partition(emit, pieces, cut, y, Math.min(storeyH, oy + eave - y), inner, S, s)
    if (S.stairs && stair) flight(emit, pieces, stair, y, storeyH, S, s)
  }
}

// Somewhere inside the building to put the stairs. The bounding box of a footprint is not the footprint — on an L
// or a terrace end the corner of the box is out over the street — so walk in from each corner until all four corners
// of the well are actually inside, and give up rather than build a staircase in the road.
function wellIn(poly, u0, v0, u1, v1, S) {
  const w = S.stairWide, l = S.stairLong
  if (u1 - u0 < w + 1 || v1 - v0 < l + 1) return null
  for (let step = 0.5; step < Math.max(u1 - u0, v1 - v0); step += 1.5) {
    for (const [su, sv] of [[u0 + step, v0 + step], [u1 - step - w, v0 + step], [u0 + step, v1 - step - l], [u1 - step - w, v1 - step - l]]) {
      const r = { u0: su, v0: sv, u1: su + w, v1: sv + l }
      if (pointInPoly(poly, r.u0, r.v0) && pointInPoly(poly, r.u1, r.v0) &&
          pointInPoly(poly, r.u0, r.v1) && pointInPoly(poly, r.u1, r.v1)) return r
    }
  }
  return null
}

// two cuts through the footprint's box, the second across whichever half is bigger; each carries a doorway
function rooms(u0, v0, u1, v1, rnd, S) {
  const out = []
  const wide = u1 - u0 > v1 - v0
  const t = 0.35 + rnd() * 0.3
  if (wide) {
    const u = u0 + (u1 - u0) * t
    out.push({ u0: u, v0, u1: u, v1, door: v0 + (v1 - v0) * (0.3 + rnd() * 0.4) })
    const half = u - u0 > u1 - u ? [u0, u] : [u, u1]
    const v = v0 + (v1 - v0) * (0.4 + rnd() * 0.2)
    out.push({ u0: half[0], v0: v, u1: half[1], v1: v, door: half[0] + (half[1] - half[0]) * (0.3 + rnd() * 0.4) })
  } else {
    const v = v0 + (v1 - v0) * t
    out.push({ u0, v0: v, u1, v1: v, door: u0 + (u1 - u0) * (0.3 + rnd() * 0.4) })
    const half = v - v0 > v1 - v ? [v0, v] : [v, v1]
    const u = u0 + (u1 - u0) * (0.4 + rnd() * 0.2)
    out.push({ u0: u, v0: half[0], u1: u, v1: half[1], door: half[0] + (half[1] - half[0]) * (0.3 + rnd() * 0.4) })
  }
  return out
}

// One partition, walked along in short lengths: a length whose middle is outside the footprint is not built (the
// footprint is not a rectangle), and one length is left out for the doorway.
function partition(emit, pieces, cut, y, height, inner, S, storey) {
  const along = Math.hypot(cut.u1 - cut.u0, cut.v1 - cut.v0)
  if (along < 1.5 || height < 1.6) return
  const du = (cut.u1 - cut.u0) / along, dv = (cut.v1 - cut.v0) / along
  const step = S.partStep
  for (let a = 0; a + 0.4 < along; a += step) {
    const b = Math.min(a + step, along)
    const mu = cut.u0 + du * (a + b) / 2, mv = cut.v0 + dv * (a + b) / 2
    if (!pointInPoly(inner, mu, mv)) continue
    const doorAt = du ? cut.door : cut.door                      // the gap, measured along the same axis as the cut
    const doorPos = du ? mu : mv
    if (Math.abs(doorPos - doorAt) < S.doorWide / 2 + step / 2 && height > 2.1) continue
    const piece = { kind: "partition", storey, ranges: [] }
    emit.begin(piece)
    box(emit, cut.u0 + du * a, cut.v0 + dv * a, cut.u0 + du * b, cut.v0 + dv * b, y + S.floorThick, height - S.floorThick, S.partThick, "pleister")
    emit.end(piece)
    pieces.push(piece)
  }
}

// a straight flight of chunky steps up through the well left in the slab above
function flight(emit, pieces, st, y, storeyH, S, storey) {
  const n = Math.max(4, Math.round(storeyH / 0.22))
  const run = (st.v1 - st.v0) / n, rise = storeyH / n
  const piece = { kind: "stair", storey, ranges: [] }
  emit.begin(piece)
  for (let i = 0; i < n; i++) {
    const v = st.v0 + i * run
    boxAt(emit, st.u0, v, st.u1, v + run, y + S.floorThick, rise * (i + 1), "beton")
  }
  emit.end(piece)
  pieces.push(piece)
}

// A roof plane, cut into panels on its own slope. Same grid-and-clip as a wall, but square panels rather than bays
// and storeys, no openings, and the thickness goes down into the attic rather than into the room.
function roofFace(src, fi, obj, emit, pieces, S) {
  const [ox, oy, oz] = src.o
  const a0 = src.off[fi], a1 = src.off[fi + 1]
  if (a1 - a0 < 3) return
  const pts = []
  for (let k = a0; k < a1; k++) pts.push(ox + src.xyz[k * 3] / 100, oy + src.xyz[k * 3 + 1] / 100, oz + src.xyz[k * 3 + 2] / 100)
  if (!normalOf(pts, _n)) return
  if (_n.y < 0) _n.negate()                                       // a roof faces the sky, whatever the winding says
  _u.copy(Math.abs(_n.y) > 0.9 ? X : UP).cross(_n).normalize()
  _v.crossVectors(_n, _u)
  const basis = { u: _u.clone(), v: _v.clone(), n: _n.clone() }
  const poly = [], d = pts[0] * basis.n.x + pts[1] * basis.n.y + pts[2] * basis.n.z
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity
  for (let i = 0; i < pts.length; i += 3) {
    _p.set(pts[i], pts[i + 1], pts[i + 2])
    const a = _p.dot(basis.u), c = _p.dot(basis.v)
    poly.push(a, c)
    u0 = Math.min(u0, a); u1 = Math.max(u1, a); v0 = Math.min(v0, c); v1 = Math.max(v1, c)
  }
  const tris = triangulate(poly)
  if (!tris.length) return
  const skin = src.roof === "horizontal" ? "bitumen" : "pannen"
  const cols = Math.max(1, Math.round((u1 - u0) / S.panel)), rows = Math.max(1, Math.round((v1 - v0) / S.panel))
  const pw = (u1 - u0) / cols, ph = (v1 - v0) / rows
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
    const cu0 = u0 + c * pw, cv0 = v0 + r * ph
    const cell = []
    let area = 0
    for (const tri of tris) {
      const part = clipBox(tri, cu0, cv0, cu0 + pw, cv0 + ph)
      if (part) { cell.push(part); area += areaOf(part) }
    }
    if (area < S.minArea) continue
    const piece = { kind: "roof", face: fi, bay: c, storey: -1, ranges: [] }
    emit.begin(piece)
    slab(emit, basis, cell, outline(cell), d, S.roofThick, { skin, core: "pleister" })
    emit.end(piece)
    pieces.push(piece)
  }
}

// where the facade texture paints its glass, in metres, scaled to this building's bay and storey
function windowRect(u0, v0, bayW, storeyH) {
  const w = WINDOW.w / WINDOW.bay * bayW, h = WINDOW.h / WINDOW.storey * storeyH
  return { u0: u0 + (bayW - w) / 2, u1: u0 + (bayW + w) / 2,
           v0: v0 + WINDOW.sill / WINDOW.storey * storeyH, v1: v0 + WINDOW.sill / WINDOW.storey * storeyH + h }
}

// the four rectangles a cell with a window is made of: a pier either side, brick under the sill and over the head
function holeParts(c) {
  const o = c.opening
  return [[c.cu0, c.cv0, o.u0, c.top], [o.u1, c.cv0, c.cu1, c.top],
          [o.u0, c.cv0, o.u1, o.v0], [o.u0, o.v1, o.u1, c.top]]
    .filter(([a, b, e, f]) => e - a > EPS && f - b > EPS)
    .map(([a, b, e, f]) => [a, b, e, b, e, f, a, f])
}

const inCell = (c, u, v) => u > c.cu0 - EPS && u < c.cu1 + EPS && v > c.cv0 - EPS && v < c.top + EPS

// a full cell with a hole in it: the brick around the opening, a reveal round its edge, and the glass
function panelWithHole(emit, basis, d, c, rim, S) {
  const o = c.opening
  slab(emit, basis, holeParts(c), rim, d, S.thick, { skin: "steen", core: "pleister" })
  // the reveal: the four faces of the hole, facing inwards
  const rv = [[o.u0, o.v0, o.u1, o.v0], [o.u1, o.v0, o.u1, o.v1], [o.u1, o.v1, o.u0, o.v1], [o.u0, o.v1, o.u0, o.v0]]
  for (const [x1, y1, x2, y2] of rv) emit.quad("pleister", basis, [x2, y2, d], [x1, y1, d], [x1, y1, d - S.thick], [x2, y2, d - S.thick])
  const glass = [o.u0, o.v0, o.u1, o.v0, o.u1, o.v1, o.u0, o.v1]
  fan(emit, "glas", basis, glass, d - S.reveal, 1)
  fan(emit, "glas", basis, glass, d - S.reveal, -1)
}

// a flat [u, v, …] ring → flat convex triangles, through the same earcut the shell uses
function triangulate(poly) {
  const pts = []
  for (let i = 0; i < poly.length; i += 2) pts.push(new THREE.Vector2(poly[i], poly[i + 1]))
  let idx
  try { idx = THREE.ShapeUtils.triangulateShape(pts, []) } catch { return [] }
  return idx.map(([a, b, c]) => [pts[a].x, pts[a].y, pts[b].x, pts[b].y, pts[c].x, pts[c].y])
}

// is (x, y) inside a flat [x, y, …] ring?
function pointInPoly(poly, x, y) {
  let inside = false
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

// the same polygons with a rectangle taken out of them: four bands round the hole, each one a clip we already have
function subtractRect(polys, r) {
  const out = []
  const bands = [[-1e6, -1e6, r.u0, 1e6], [r.u1, -1e6, 1e6, 1e6], [r.u0, -1e6, r.u1, r.v0], [r.u0, r.v1, r.u1, 1e6]]
  for (const poly of polys) for (const [a, b, c, e] of bands) {
    const q = clipBox(poly, a, b, c, e)
    if (q && areaOf(q) > 1e-3) out.push(q)
  }
  return out
}

// Newell over a flat [x, y, z, …] list
function normalOf(pts, out) {
  out.set(0, 0, 0)
  const n = pts.length / 3
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const px = pts[i * 3], py = pts[i * 3 + 1], pz = pts[i * 3 + 2]
    const qx = pts[j * 3], qy = pts[j * 3 + 1], qz = pts[j * 3 + 2]
    out.x += (py - qy) * (pz + qz)
    out.y += (pz - qz) * (px + qx)
    out.z += (px - qx) * (py + qy)
  }
  if (out.lengthSq() < 1e-12) return false
  out.normalize()
  return true
}

// ---- collecting the triangles -------------------------------------------------------------------------------

// Where the generator writes. One bucket per material, plain arrays while a building is being built; the streamer
// copies them into its slab and hands each piece back the range it owns. Positions arrive in the face's own plane
// coordinates and are turned into world ones here, which is the only place that transform lives.
export function collector(colour) {
  const buckets = new Map()
  const bucket = (name) => {
    let b = buckets.get(name)
    if (!b) buckets.set(name, b = { pos: [], nor: [], uv: [], col: [] })
    return b
  }
  const at = new Map()
  let box = null, obb = null, id = 0
  const P = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], N = new THREE.Vector3()
  const place = (basis, [u, v, d], out) =>
    out.set(basis.u.x * u + basis.v.x * v + basis.n.x * d,
            basis.u.y * u + basis.v.y * v + basis.n.y * d,
            basis.u.z * u + basis.v.z * v + basis.n.z * d)

  const emit = {
    tri(mat, basis, a, b, c) {
      const t = bucket(mat)
      // the piece's own box, tracked in the plane it was built in: a wall panel is a thin slab standing on its edge,
      // and an axis-aligned box round it would be a poor collider on any street that does not run north-south
      if (obb) {
        if (!obb.basis) obb.basis = basis
        for (const q of [a, b, c]) {
          if (q[0] < obb.u0) obb.u0 = q[0]; if (q[0] > obb.u1) obb.u1 = q[0]
          if (q[1] < obb.v0) obb.v0 = q[1]; if (q[1] > obb.v1) obb.v1 = q[1]
          if (q[2] < obb.d0) obb.d0 = q[2]; if (q[2] > obb.d1) obb.d1 = q[2]
        }
      }
      place(basis, a, P[0]); place(basis, b, P[1]); place(basis, c, P[2])
      N.copy(P[1]).sub(P[0]).cross(_p.copy(P[2]).sub(P[0]))
      if (N.lengthSq() < 1e-12) return
      N.normalize()
      const rgb = colour[mat] ?? colour.wall
      for (let i = 0; i < 3; i++) {
        const p = P[i], s = i === 0 ? a : i === 1 ? b : c
        t.pos.push(p.x, p.y, p.z)
        t.nor.push(N.x, N.y, N.z)
        t.uv.push(s[0], s[1])
        t.col.push(rgb[0], rgb[1], rgb[2])
        if (box) box.expandByPoint(p)
      }
    },
    quad(mat, basis, a, b, c, d) { emit.tri(mat, basis, a, b, c); emit.tri(mat, basis, a, c, d) },
    begin(piece) {
      at.clear()
      for (const [name, b] of buckets) at.set(name, b.pos.length / 3)
      box = new THREE.Box3()
      obb = { basis: null, u0: Infinity, u1: -Infinity, v0: Infinity, v1: -Infinity, d0: Infinity, d1: -Infinity }
    },
    end(piece) {
      piece.id = id++
      piece.ranges = []
      for (const [name, b] of buckets) {
        const start = at.get(name) ?? 0, count = b.pos.length / 3 - start
        if (count) piece.ranges.push({ name, start, count })
      }
      piece.box = box.isEmpty() ? null : box
      piece.obb = obb?.basis ? obb : null
      box = null; obb = null
    },
    buckets,
  }
  return emit
}

// ---- boxes, and the horizontal plane ---------------------------------------------------------------------------

// The floor's own basis: u is world x, v is minus world z, n is up — the minus keeps it right-handed, so a slab's
// top faces the sky and its underside faces the room below without anything having to be flipped by hand.
const FLOOR = { u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 0, -1), n: new THREE.Vector3(0, 1, 0) }

// a partition standing on the line (u0,v0)-(u1,v1) of the floor plane, `h` tall and `t` thick, centred on the line
function box(emit, u0, v0, u1, v1, y, h, t, mat) {
  const x1 = u0, z1 = -v0, x2 = u1, z2 = -v1
  const dx = x2 - x1, dz = z2 - z1, len = Math.hypot(dx, dz)
  if (len < 0.05 || h < 0.3) return
  const U = new THREE.Vector3(dx / len, 0, dz / len), V = new THREE.Vector3(0, 1, 0)
  const N = new THREE.Vector3().crossVectors(U, V)
  const basis = { u: U, v: V, n: N }
  const uA = x1 * U.x + z1 * U.z, uB = x2 * U.x + z2 * U.z, d = x1 * N.x + z1 * N.z
  const face = [uA, y, uB, y, uB, y + h, uA, y + h]
  slab(emit, basis, [face], outline([face]), d + t / 2, t, { skin: mat, core: mat })
}

// an axis-aligned box between two corners in floor coordinates, from y up by h
function boxAt(emit, u0, v0, u1, v1, y, h, mat) {
  const poly = [u0, v0, u1, v0, u1, v1, u0, v1]
  slab(emit, FLOOR, [poly], outline([poly]), y + h, h, { skin: mat, core: mat })
}
