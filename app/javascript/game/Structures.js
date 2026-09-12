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
      if (obj.state !== 0 || !obj.rings || this.built.has(obj.key)) return
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
  break(entry, piece, vx = 0, vy = 0, vz = 0) {
    if (!entry.standing?.has(piece)) return 0
    entry.standing.delete(piece)
    this.physics?.breakPiece(entry, piece, vx, vy, vz)
    this.falling.add(entry)
    this.onDamage?.(entry.obj, T.physics.pieces.damage * (entry.obj.max / Math.max(1, entry.pieces.length)))
    return 1
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
      if (!this.physics?.breakPiece(entry, piece, (Math.random() - 0.5) * 3, 1 + Math.random() * 2, (Math.random() - 0.5) * 3)) {
        for (const r of piece.ranges) { const geo = entry.geos?.get(r.name); if (geo) collapseRange(geo.attributes.position, r.start, r.count) }
      }
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
