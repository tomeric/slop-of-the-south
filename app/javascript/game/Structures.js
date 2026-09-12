import * as THREE from "three"
import { TUNING as T } from "game/Tuning"
import { buildStructure, collector } from "game/Structure"
import { buildingMaterial } from "game/BuildingTextures"
import { buildingPalette as palette } from "game/BuildingMeshes"
import { graphOf, unsupported } from "game/Support"
import { collapseRange } from "game/Destructibles"

// Which houses are built rather than painted, and when they change over.
//
// A building has two forms. Far away it is the shell `BuildingMeshes.js` merged into its tile — five meshes for a
// whole tile, windows in the texture, nothing you can take apart. Within `T.buildings.structure.radius` it is
// swapped for a stack of pieces from `game/Structure.js`: the shell's own vertices are copied out and collapsed,
// the pieces go up in their place, and driving away puts the shell back.
//
// The work is spread the way every other streamer in this game spreads it — a few buildings a frame, nearest first,
// under a millisecond budget — because converting a house is a couple of milliseconds and a city centre holds a
// hundred of them inside eighty metres.
// the paint on a front door, from the building's own id so it does not change when it is rebuilt
const DOORS = [0x2f4a35, 0x6b2a24, 0x2b3a52, 0x4a3626, 0x7a6a4a]
const _c = new THREE.Color()
function doorColour(key) {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619)
  _c.setHex(DOORS[(h >>> 0) % DOORS.length])
  return [_c.r, _c.g, _c.b]
}

// What a piece is made of: the material bucket most of its triangles went into. A wall panel is mostly brick, a
// window's pane is glass, a door and a staircase are timber, a floor slab is concrete.
function materialOf(piece) {
  let best = null, most = 0
  for (const r of piece.ranges ?? []) if (r.count > most) { most = r.count; best = r.name }
  return best === "glas" ? "glas"
    : best === "hout" ? "hout"
    : best === "beton" || best === "pannen" || best === "bitumen" ? "beton"
    : "steen"
}

const PANE_VERTS = 12                                 // one pane of glass: two faces, two triangles each

export class Structures {
  constructor(scene, index, chunks, physics) {
    this.scene = scene
    this.index = index
    this.chunks = chunks
    this.physics = physics
    this.built = new Map()                    // key → { obj, group, pieces, geos }
    this.queue = []
    this.falling = new Set()                  // buildings with a piece missing, waiting for the flood fill
    this.slabbed = new Map()                  // key → obj for the buildings wearing a slab shell instead of pieces
    this.onDamage = null                      // set by game.js: a broken piece counts against the building's hp
    this.stats = { built: 0, pieces: 0, buildMs: 0, queued: 0, fell: 0, slabs: 0 }
  }

  update(car) {
    const S = T.buildings.structure
    if (!S.on) return this.clear()
    const wanted = new Set()
    this.index.near(car.x, car.z, S.radius, (obj) => {
      if (obj.kind !== "m" || obj.state > 0 || !obj.src) return
      wanted.add(obj.key)
      if (!this.built.has(obj.key)) this.queue.push(obj)
    })
    for (const [key, entry] of this.built) {
      if (wanted.has(key)) continue
      const d = Math.hypot(entry.obj.x - car.x, entry.obj.z - car.z)
      if (d > S.radius * S.keep) this.drop(key)     // hysteresis, or a building on the rim flickers
    }
    this.queue = this.queue.filter((o) => wanted.has(o.key) && !this.built.has(o.key))
    this.queue.sort((a, b) => Math.hypot(a.x - car.x, a.z - car.z) - Math.hypot(b.x - car.x, b.z - car.z))
    const t0 = performance.now()
    for (let i = 0; i < S.perFrame && this.queue.length && this.built.size < S.maxBuildings; i++) {
      this.build(this.queue.shift())
      if (performance.now() - t0 > S.budgetMs) break
    }
    this.stats.buildMs = performance.now() - t0
    this.stats.queued = this.queue.length
    this.settle()
    const now = performance.now()
    for (const [key, entry] of this.built) if (entry.dying && now - entry.dying > T.physics.pieces.settle * 1000) this.drop(key)
    this.slabs(car)
  }

  // The second tier of solid. Only so many houses can be built out of pieces — `maxBuildings` caps it, `perFrame`
  // rations it, and the OSM boxes have no faces to build from at all — but every one of them still has to stop a
  // car that now has a real chassis. So everything intact inside `T.physics.solid.radius` that is not built wears a
  // shell of slabs instead (game/Physics.js `solid`), and hands over the moment it is built for real.
  slabs(car) {
    const S = T.physics.solid
    const phys = this.physics
    if (!phys?.world) return
    const want = new Set(), fresh = []
    this.index.near(car.x, car.z, S.radius, (obj) => {
      if (obj.state !== 0 || this.built.has(obj.key)) return
      if (!obj.rings && obj.kind !== "t") return                 // buildings, and the trunks of standing trees
      want.add(obj.key)
      if (!this.slabbed.has(obj.key)) fresh.push(obj)
    })
    for (const [key, obj] of this.slabbed) {
      if (want.has(key)) continue
      // a house that has just been built, or been knocked down, loses its shell at once; one that has merely
      // drifted to the rim keeps it until it is properly out of range, or it flickers
      const far = Math.hypot(obj.x - car.x, obj.z - car.z) > S.radius * S.keep
      if (far || this.built.has(key) || obj.state !== 0) { phys.unsolid(key); this.slabbed.delete(key) }
    }
    fresh.sort((a, b) => Math.hypot(a.x - car.x, a.z - car.z) - Math.hypot(b.x - car.x, b.z - car.z))
    for (let i = 0; i < S.perFrame && i < fresh.length; i++) {
      if (phys.solid(fresh[i])) this.slabbed.set(fresh[i].key, fresh[i])
    }
    this.stats.slabs = this.slabbed.size
  }

  unslab(key) {
    if (!this.slabbed.delete(key)) return
    this.physics?.unsolid(key)
  }

  build(obj) {
    const t0 = performance.now()
    const p = palette(obj.key.slice(2), obj.src.roof)
    const wall = new THREE.Color(p.wall)
    const emit = collector({
      wall: [wall.r, wall.g, wall.b], steen: [wall.r, wall.g, wall.b],
      pleister: [1, 1, 1], beton: [1, 1, 1], glas: [1, 1, 1], pannen: [1, 1, 1], bitumen: [1, 1, 1],
      hout: doorColour(obj.key),
    })
    const pieces = buildStructure(obj, emit)
    if (!pieces.length) { this.built.set(obj.key, { obj, group: null, pieces }); return }
    const group = new THREE.Group(), geos = new Map()
    for (const [name, b] of emit.buckets) {
      if (!b.pos.length) continue
      const geo = new THREE.BufferGeometry()
      geo.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3))
      geo.setAttribute("normal", new THREE.Float32BufferAttribute(b.nor, 3))
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(b.uv, 2))
      geo.setAttribute("color", new THREE.Float32BufferAttribute(b.col, 3))
      geos.set(name, geo)
      group.add(new THREE.Mesh(geo, buildingMaterial(name)))
    }
    obj.hide?.()
    obj.detail?.hide?.()
    this.scene.add(group)
    const entry = { obj, group, pieces, geos }
    graphOf(entry)                                  // who holds whom up, before anything can be taken away
    this.built.set(obj.key, entry)
    this.physics?.attach(entry)                     // a standing piece is something the car can hit
    this.stats.built = this.built.size
    this.stats.pieces += pieces.length
    this.stats.buildMs = performance.now() - t0
  }

  // A piece comes off — the car went through it, a rocket found it — and then everything it was holding up comes
  // down after it, a few a frame so a block reads as a collapse rather than a single frame of everything vanishing.
  // A piece lets go. What happens next depends on what it is made of: a wall panel topples as the panel it is and
  // sheds a few bricks off the break, but a pane of glass does not topple — it goes, all at once, into shards. That
  // is the difference between a window breaking and a window falling over.
  break(entry, piece, vx = 0, vy = 0, vz = 0) {
    if (!entry.standing?.has(piece)) return 0
    entry.standing.delete(piece)
    const mat = materialOf(piece)
    const b = piece.box
    const cx = b ? (b.min.x + b.max.x) / 2 : entry.obj.x
    const cy = b ? (b.min.y + b.max.y) / 2 : entry.obj.y
    const cz = b ? (b.min.z + b.max.z) / 2 : entry.obj.z
    const size = b ? Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) : 1
    // A window is not a piece of its own — the cell is the brick surround, the reveal and the pane together — so
    // the glass is taken out of it by range rather than by piece. It shatters where it stood and the panel around
    // it topples on without it, which is what breaking a window actually looks like.
    const glass = (piece.ranges ?? []).find((r) => r.name === "glas" && r.count)
    if (glass) {
      this.hideRange(entry, glass)
      // Out into the street, not into the front room. The pane sits inside the wall, so a burst at the piece's own
      // centre put every shard behind the brick where nobody could see it — which is why the glass looked like it
      // was not breaking at all. The face normal is the way out.
      const n = piece.obb?.basis?.n
      const k = T.buildings.structure.thick + 0.35
      // a lump of masonry can carry several windows, and its glass is one range across the lot of them, so the
      // shards follow how much glass there actually was: PANE_VERTS is one pane, two faces of two triangles
      const panes = Math.max(1, Math.round(glass.count / PANE_VERTS))
      this.physics?.burst(cx + (n?.x ?? 0) * k, cy + (n?.y ?? 0) * k, cz + (n?.z ?? 0) * k,
                          size * 0.3, Math.min(T.physics.pieces.maxShards, T.physics.pieces.shards * panes), "glas")
    }
    if (mat === "glas") {
      this.hide(entry, piece)                                   // nothing left worth toppling
    } else {
      this.physics?.breakPiece(entry, piece, vx, vy, vz)
      const n = Math.min(T.physics.pieces.chips, Math.max(1, Math.round(size)))
      this.physics?.burst(cx, cy, cz, size * 0.35, n, mat)
    }
    this.falling.add(entry)
    this.onDamage?.(entry.obj, T.physics.pieces.damage * (entry.obj.max / Math.max(1, entry.pieces.length)))
    return 1
  }

  // A second rocket into the same hole. Panels that have already come down are lying there as whole panels, so a
  // blast that only breaks what is still standing does nothing to them. This turns the fallen ones within reach
  // into the material they are made of: the body goes, the panel goes out of the drawn geometry, and what is left
  // is a heap of brick. Fire enough and a wall ends up as rubble rather than as a stack of slabs.
  shatter(x, y, z, r) {
    let n = 0
    for (const entry of this.built.values()) {
      if (!entry.live?.size) continue
      if (Math.hypot(entry.obj.x - x, entry.obj.z - z) > r + T.buildings.structure.radius) continue
      for (const [piece, slot] of [...entry.live]) {
        const p = slot.body.translation()
        if (Math.hypot(p.x - x, p.y - y, p.z - z) > r) continue
        const mat = materialOf(piece)
        const b = piece.box
        const size = b ? Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) : 1
        this.physics?.dropPiece(entry, piece, slot)
        this.hide(entry, piece)
        this.physics?.burst(p.x, p.y, p.z, size * 0.3, Math.min(T.physics.pieces.shatter, Math.max(2, Math.round(size * 1.6))), mat)
        n++
      }
    }
    if (n) this.stats.pieces = Math.max(0, this.stats.pieces - n)
    return n
  }

  // take a piece out of the standing geometry without giving it a body of its own
  hide(entry, piece) { for (const r of piece.ranges) this.hideRange(entry, r) }

  hideRange(entry, r) {
    const geo = entry.geos?.get(r.name)
    if (geo) collapseRange(geo.attributes.position, r.start, r.count)
  }

  // whatever lost its support last frame, let go of it now
  settle() {
    if (!this.falling.size) return
    let budget = T.physics.pieces.perFrame
    for (const entry of [...this.falling]) {
      const loose = unsupported(entry)
      if (!loose.length) { this.falling.delete(entry); continue }
      for (const piece of loose) {
        if (budget-- <= 0) return
        entry.standing.delete(piece)
        this.physics?.breakPiece(entry, piece, 0, -0.5, 0)
        this.stats.fell++
      }
    }
  }

  // The server has decided this house is rubble or gone while it was standing here as pieces. Its word is final,
  // so everything still up lets go at once and the entry is dropped a couple of seconds later, by which time the
  // heap `Destructibles` puts down has taken over.
  demolish(obj) {
    const entry = this.built.get(obj.key)
    if (!entry || entry.dying) return
    entry.dying = performance.now()
    for (const piece of [...entry.standing]) {
      entry.standing.delete(piece)
      if (!this.physics?.breakPiece(entry, piece, (Math.random() - 0.5) * 3, 1 + Math.random() * 2, (Math.random() - 0.5) * 3)) this.hide(entry, piece)
    }
    this.falling.delete(entry)
  }

  drop(key) {
    const entry = this.built.get(key)
    if (!entry) return
    this.physics?.detach(entry)
    this.falling.delete(entry)
    if (entry.group) {
      this.scene.remove(entry.group)
      for (const geo of entry.geos.values()) geo.dispose()
    }
    if (entry.obj.state === 0) { entry.obj.show?.(); entry.obj.detail?.show?.() }   // a dead house does not come back
    this.stats.pieces -= entry.pieces.length
    this.built.delete(key)
    this.stats.built = this.built.size
  }

  clear() {
    for (const key of [...this.built.keys()]) this.drop(key)
    for (const key of [...this.slabbed.keys()]) this.unslab(key)
  }

  // a tile going out takes its buildings with it: the handles are about to be dropped from the index
  dropTile(tile) {
    for (const [key, entry] of this.built) if (entry.obj.tile === tile) this.drop(key)
    for (const [key, obj] of [...this.slabbed]) if (obj.tile === tile) this.unslab(key)
  }

  get(key) { return this.built.get(key) }
}
