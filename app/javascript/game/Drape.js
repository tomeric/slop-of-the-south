// Laying flat things on a terrain that is not flat.
//
// The ground is a grid of 10 m cells, each drawn as two triangles split along the diagonal from (c, r+1) to
// (c+1, r). A road surface laid over it is only as accurate as its own vertices: anywhere a triangle spans a grid
// line the terrain bulges through it, by up to a decimetre on a slope and much more where the road builder steps
// the ground beside a kerb. Cut every triangle along all three families of lines first — x, z and x + z, all at
// multiples of the grid step in world coordinates — and every vertex then sits exactly on the surface, so a
// constant lift is enough and no polygon offset is needed.
//
// A vertex is a plain array [x, z, …attributes]; the attributes (u, v, the road's own level, anything) are
// interpolated at every cut, so a texture does not stretch where a triangle was split.
const EPS = 1e-6

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)

// split one triangle where f crosses `value`: one vertex ends up alone on its side, which gives a triangle and a
// quad, and the quad is two more triangles
function split(tri, f, value) {
  const s = [f(tri[0]) - value, f(tri[1]) - value, f(tri[2]) - value]
  if ((s[0] >= -EPS && s[1] >= -EPS && s[2] >= -EPS) || (s[0] <= EPS && s[1] <= EPS && s[2] <= EPS)) return [tri]
  let lone = 0
  for (let i = 0; i < 3; i++) {
    const a = s[i] > 0, b = s[(i + 1) % 3] > 0, c = s[(i + 2) % 3] > 0
    if (a !== b && a !== c) { lone = i; break }
  }
  const A = tri[lone], B = tri[(lone + 1) % 3], C = tri[(lone + 2) % 3]
  const sa = s[lone], sb = s[(lone + 1) % 3], sc = s[(lone + 2) % 3]
  const ab = mix(A, B, sa / (sa - sb))
  const ac = mix(A, C, sa / (sa - sc))
  return [[A, ab, ac], [ab, B, C], [ab, C, ac]]
}

function cut(tris, f, step) {
  const out = []
  for (const tri of tris) {
    const v = [f(tri[0]), f(tri[1]), f(tri[2])]
    const lo = Math.floor(Math.min(v[0], v[1], v[2]) / step), hi = Math.floor(Math.max(v[0], v[1], v[2]) / step)
    let work = [tri]
    for (let k = lo + 1; k <= hi; k++) {
      const next = []
      for (const t of work) next.push(...split(t, f, k * step))
      work = next
    }
    out.push(...work)
  }
  return out
}

// split anything longer than `maxEdge` first, so a triangle spanning many cells does not have to be cut a dozen times
function refine(tris, maxEdge) {
  const out = [], stack = [...tris]
  const max2 = maxEdge * maxEdge
  while (stack.length) {
    const t = stack.pop()
    let worst = -1, len = max2
    for (let i = 0; i < 3; i++) {
      const a = t[i], b = t[(i + 1) % 3]
      const d = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2
      if (d > len) { len = d; worst = i }
    }
    if (worst < 0 || out.length + stack.length > 40000) { out.push(t); continue }
    const a = t[worst], b = t[(worst + 1) % 3], c = t[(worst + 2) % 3], m = mix(a, b, 0.5)
    stack.push([a, m, c], [m, b, c])
  }
  return out
}

// tris: triangles of vertices [x, z, …attrs]. Returns the same triangles cut to the grid.
export function drape(tris, { step = 10, maxEdge = 7 } = {}) {
  let out = refine(tris, maxEdge)
  out = cut(out, (v) => v[0], step)
  out = cut(out, (v) => v[1], step)
  out = cut(out, (v) => v[0] + v[1], step)
  return out
}

// A ring of [x, z] pairs (outer first, holes after) → triangles of [x, z, u, v] with the UV in metres, ready for
// `drape`. Earcut comes with three; the rings are in game coordinates, so the UV is just the position.
export function ringsToTriangles(rings, THREE) {
  const pts = [], contour = [], holes = []
  for (let r = 0; r < rings.length; r++) {
    const target = r === 0 ? contour : []
    for (let i = 0; i + 1 < rings[r].length; i += 2) {
      const p = new THREE.Vector2(rings[r][i], rings[r][i + 1])
      pts.push(p); target.push(p)
    }
    if (r > 0 && target.length >= 3) holes.push(target)
  }
  if (contour.length < 3) return []
  let tris
  try { tris = THREE.ShapeUtils.triangulateShape(contour, holes) } catch { return [] }
  const flat = contour.concat(...holes)
  return tris.map(([a, b, c]) => [a, b, c].map((i) => { const p = flat[i]; return [p.x, p.y, p.x, p.y] }))
}
