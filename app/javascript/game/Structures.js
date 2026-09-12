import * as THREE from "three"
import { TUNING as T } from "game/Tuning"
import { buildStructure, collector } from "game/Structure"
import { buildingMaterial } from "game/BuildingTextures"
import { buildingPalette as palette } from "game/BuildingMeshes"
import { graphOf, unsupported } from "game/Support"

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
export class Structures {
  constructor(scene, index, chunks, physics) {
    this.scene = scene
    this.index = index
    this.chunks = chunks
    this.physics = physics
    this.built = new Map()                    // key → { obj, group, pieces, geos }
    this.queue = []
    this.falling = new Set()                  // buildings with a piece missing, waiting for the flood fill
    this.onDamage = null                      // set by game.js: a broken piece counts against the building's hp
    this.stats = { built: 0, pieces: 0, buildMs: 0, queued: 0, fell: 0 }
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
  }

  build(obj) {
    const t0 = performance.now()
    const p = palette(obj.key.slice(2), obj.src.roof)
    const wall = new THREE.Color(p.wall)
    const emit = collector({
      wall: [wall.r, wall.g, wall.b], steen: [wall.r, wall.g, wall.b],
      pleister: [1, 1, 1], beton: [1, 1, 1], glas: [1, 1, 1], pannen: [1, 1, 1], bitumen: [1, 1, 1],
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

  drop(key) {
    const entry = this.built.get(key)
    if (!entry) return
    this.physics?.detach(entry)
    this.falling.delete(entry)
    if (entry.group) {
      this.scene.remove(entry.group)
      for (const geo of entry.geos.values()) geo.dispose()
    }
    entry.obj.show?.()
    entry.obj.detail?.show?.()
    this.stats.pieces -= entry.pieces.length
    this.built.delete(key)
    this.stats.built = this.built.size
  }

  clear() { for (const key of [...this.built.keys()]) this.drop(key) }

  // a tile going out takes its buildings with it: the handles are about to be dropped from the index
  dropTile(tile) {
    for (const [key, entry] of this.built) if (entry.obj.tile === tile) this.drop(key)
  }

  get(key) { return this.built.get(key) }
}
