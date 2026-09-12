import { TUNING as T } from "game/Tuning"

// What holds what up, so that nothing is left hanging in the air.
//
// Every piece of a building knows which pieces rest on it and which it rests on, and the ones sitting on the ground
// are the roots. Take a piece away and the question is only "which pieces can no longer be reached from a root?" —
// a flood fill over a few hundred nodes, microseconds — and those are the ones that fall. That single rule is what
// turns knocking out a ground-floor wall into a collapse rather than a hole, and it is why a house cannot end up
// with a floor floating over a gap.
//
// The test itself is one clause: two pieces touch in plan, and one of them starts where the other stops. Two panels
// side by side on the same storey deliberately do *not* hold each other up — if they did, the graph would stay
// connected sideways and nothing above a hole would ever come down.
const EMPTY = []

export function graphOf(entry) {
  const S = T.physics.support
  const pieces = entry.pieces.filter((p) => p.box)
  const cell = 2
  const grid = new Map()
  const key = (x, z) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`
  for (const p of pieces) {
    p.up = []; p.down = []
    p.bot = p.box.min.y; p.top = p.box.max.y
    p.root = p.bot <= entry.obj.y + S.groundBite
    for (let x = p.box.min.x - S.weld; x <= p.box.max.x + S.weld; x += cell)
      for (let z = p.box.min.z - S.weld; z <= p.box.max.z + S.weld; z += cell) {
        const k = key(x, z)
        if (!grid.has(k)) grid.set(k, [])
        grid.get(k).push(p)
      }
  }
  const seen = new Set()
  for (const list of grid.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j], pair = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`
      if (seen.has(pair)) continue
      seen.add(pair)
      if (!overlaps(a, b, S.weld)) continue
      if (holds(a, b, S)) { a.up.push(b); b.down.push(a) }
      else if (holds(b, a, S)) { b.up.push(a); a.down.push(b) }
    }
  }
  entry.standing = new Set(pieces)
  return pieces
}

const overlaps = (a, b, w) =>
  a.box.min.x - w < b.box.max.x && a.box.max.x + w > b.box.min.x &&
  a.box.min.z - w < b.box.max.z && a.box.max.z + w > b.box.min.z

// does a hold b up? b starts inside a's span, and a is the lower of the two — unless b is a floor, which may be
// pocketed into the middle of a wall that runs from the ground to the eave in one piece
function holds(a, b, S) {
  if (b.bot < a.bot - S.weld || b.bot > a.top + S.slack) return false
  return a.box.min.y < b.box.min.y - 0.01 || b.kind === "slab"
}

// Everything still standing that no longer has a path down to the ground. `gone` is what has just been taken away.
export function unsupported(entry) {
  const S = T.physics.support
  const standing = entry.standing
  const safe = new Set()
  const queue = []
  for (const p of standing) if (p.root) { safe.add(p); queue.push(p) }
  while (queue.length) {
    const p = queue.pop()
    for (const q of p.up ?? EMPTY) {
      if (safe.has(q) || !standing.has(q)) continue
      // it is only held if enough of what held it is still there: a slab hanging off one corner comes down
      if (!enough(q, safe, S)) continue
      safe.add(q); queue.push(q)
    }
  }
  const out = []
  for (const p of standing) if (!safe.has(p)) out.push(p)
  return out
}

// a piece stands if its own middle is not hanging too far past whatever is left under it
function enough(p, safe, S) {
  let n = 0, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
  for (const s of p.down ?? EMPTY) {
    if (!safe.has(s)) continue
    n++
    const c = s.box
    x0 = Math.min(x0, (c.min.x + c.max.x) / 2); x1 = Math.max(x1, (c.min.x + c.max.x) / 2)
    z0 = Math.min(z0, (c.min.z + c.max.z) / 2); z1 = Math.max(z1, (c.min.z + c.max.z) / 2)
  }
  if (!n) return false
  if (p.kind === "wall" || p.kind === "partition") return true          // a wall on any wall below it still stands
  const cx = (p.box.min.x + p.box.max.x) / 2, cz = (p.box.min.z + p.box.max.z) / 2
  return cx > x0 - S.overhang && cx < x1 + S.overhang && cz > z0 - S.overhang && cz < z1 + S.overhang
}
