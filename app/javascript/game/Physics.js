import * as THREE from "three"
import { TUNING as T } from "game/Tuning"
import { noOutline } from "game/Outline"
import { bridgeDecks } from "game/Bridges"

// Rigid bodies, so that what comes off a building falls on the ground instead of fading out in mid-air. Rapier
// (Rust compiled to WebAssembly) does the solving; this module owns the world, its clock, and the pool of bodies.
//
// Three things are worth knowing about how it is wired in.
//
// It is loaded on demand. The engine is 2 MB — nearly three times three.js — so the import is dynamic and lives
// behind `T.physics.on`: `?fysica=0` never fetches it at all. Compiling the WebAssembly takes a tenth of a second on
// the main thread, so it is started at boot, behind the loading screen, and never waited for in the frame loop.
//
// It has its own clock. The frame delta is whatever the browser gives us (clamped at 1/20 s); a solver wants a fixed
// step or its contacts chatter. So time is accumulated and spent in whole steps of `T.physics.step`, at most
// `maxSteps` of them in one frame — past that the arrears are dropped rather than paid, which is the same "slow
// down, do not explode" bargain the frame clamp already makes. What is left over interpolates the drawn transform,
// or a 144 Hz screen would show every body juddering between the steps it did not get.
//
// It does not own the car. The car keeps the arcade model it was tuned with and enters the world as a kinematic
// body: it shoves debris around at the speed it is really moving, and nothing can shove it back. Teleports have to
// be told about (`warp`), or the solver reads a 50 km jump as a velocity and fires the neighbourhood into orbit.
//                                                    bit 0 terrain, 1 solid, 2 debris, 3 car, 4 missile
const GROUP = {                                       // (what I am << 16) | (what I collide with)
  terrain: (1 << 16) | (4 | 8 | 16),
  solid: (2 << 16) | (4 | 8 | 16),                    // standing building pieces, and the slabs that stand in for them
  debris: (4 << 16) | (1 | 2 | 4 | 8 | 16),
  car: (8 << 16) | (1 | 2 | 4),                       // a real chassis: the ground and the walls push back now
  missile: (16 << 16) | (1 | 2 | 4),                  // hits the world, not the trike that fired it
  // what a shape query says it is, so that it matches the standing pieces: a query only hits a collider when each
  // side's membership is in the other's filter. It borrows the debris bit, and deliberately leaves the car out of
  // its filter so a query at the bumper does not keep finding the bumper.
  query: (4 << 16) | (1 | 2 | 4),
}
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 }
const CHIP_COLOURS = [0x9a9186, 0x8a8078, 0xa89c8c, 0x77706a, 0xb0a595]
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _m = new THREE.Matrix4()
const _q2 = new THREE.Quaternion()
const _up = new THREE.Vector3(0, 1, 0)

export class Physics {
  constructor(scene, chunks) {
    this.scene = scene
    this.chunks = chunks
    this.R = null                                     // the engine, once it has loaded
    this.world = null
    this.tiles = new Map()                            // tile key → the heightfield body
    this.waiting = []                                 // tiles that arrived while the engine was still loading
    this.chips = []                                   // the pool: every dynamic body in the world today
    this.pieces = new Map()                           // collider handle → { entry, piece } for everything standing
    this.solids = new Map()                           // key → the slab body standing in for a building with no pieces
    this.moving = new Set()                           // the pieces that have come loose and are still moving
    this.acc = 0
    this.alpha = 0
    this.next = 0                                     // round-robin over the pool
    this.stats = { bootMs: 0, stepMs: 0, awake: 0, live: 0, tiles: 0, steps: 0, highest: 0 }
  }

  // Start loading the engine. Returns a promise the boot can wait on; the frame loop never does.
  async boot() {
    if (this.world || this.loading) return this.loading
    const t0 = performance.now()
    this.loading = (async () => {
      const R = await import("@dimforge/rapier3d-compat")
      await R.init()
      this.R = R
      this.world = new R.World({ x: 0, y: T.physics.gravity, z: 0 })
      this.world.timestep = T.physics.step
      if (this.scene) this.buildChips()
      for (const tile of this.waiting) this.addTile(tile)
      this.waiting.length = 0
      this.stats.bootMs = Math.round(performance.now() - t0)
    })()
    return this.loading
  }

  // The engine compiles while the world request is still in flight, so the boot starts before there is a scene to
  // hang the debris mesh in. Whichever of the two finishes second builds the pool.
  setScene(scene) {
    this.scene = scene
    if (this.world && !this.chips.length) this.buildChips()
  }

  get ready() { return !!this.world }

  // ---- the terrain ------------------------------------------------------------------------------------------------

  // One heightfield per tile. Rapier stores the grid column-major with rows along z and columns along x, and centres
  // it on its own origin, so the grid is transposed on the way in and the body sits at the middle of the tile.
  addTile(tile) {
    if (!this.world) { if (T.physics.on) this.waiting.push(tile); return }
    if (this.tiles.has(tile.key)) return
    const t = tile.terrain, n = t.n, size = t.size
    const heights = new Float32Array(n * n)
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) heights[c * n + r] = t.h[r * n + c]
    const body = this.world.createRigidBody(
      this.R.RigidBodyDesc.fixed().setTranslation(t.ox + size / 2, 0, t.oz + size / 2))
    this.world.createCollider(
      this.R.ColliderDesc.heightfield(n - 1, n - 1, heights, { x: size, y: 1, z: size })
        .setFriction(T.physics.debris.friction).setCollisionGroups(GROUP.terrain), body)
    // The bridges in this tile ride on the same body: the heightfield under a bridge is the valley floor, so
    // without a deck to stand on anything with a chassis drives off the bank. Collider translations are body-local,
    // hence the subtraction.
    const ox = t.ox + size / 2, oz = t.oz + size / 2
    for (const d of bridgeDecks(tile.roads)) {
      this.world.createCollider(
        this.R.ColliderDesc.cuboid(d.hx, d.hy, d.hz)
          .setTranslation(d.x - ox, d.y, d.z - oz)
          .setRotation({ x: 0, y: Math.sin(d.yaw / 2), z: 0, w: Math.cos(d.yaw / 2) })
          .setFriction(T.physics.debris.friction).setCollisionGroups(GROUP.terrain), body)
    }
    this.tiles.set(tile.key, body)
    this.stats.tiles = this.tiles.size
  }

  dropTile(tile) {
    const body = this.tiles.get(tile.key)
    if (!body) return
    this.world.removeRigidBody(body)
    this.tiles.delete(tile.key)
    this.stats.tiles = this.tiles.size
  }

  // ---- the buildings that are not built out of pieces ----------------------------------------------------------

  // A house near enough to drive into but too far, too many or too plain to be built (game/Structures.js caps how
  // many are, and the OSM boxes have no faces to build from) still has to stop a car. So it gets one upright slab
  // per footprint edge on a single fixed body: hollow inside, which is the point — a convex hull would fill in an
  // L-shaped block's courtyard and a terrace's alley and you would drive into thin air. Rings arrive open, so the
  // last edge wraps back to the first point.
  solid(obj) {
    if (!this.world || this.solids.has(obj.key) || !obj.rings) return 0
    const S = T.physics.solid
    const base = obj.y ?? (this.chunks ? this.chunks.heightAt(obj.x, obj.z) : 0)
    const h = Math.max(2, obj.h ?? 6)
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.fixed())
    let n = 0
    for (const raw of obj.rings) {
      const ring = simplify(raw, S.jog)
      for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
        const ax = ring[j], az = ring[j + 1], bx = ring[i], bz = ring[i + 1]
        const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz)
        if (len < 0.1) continue
        const yaw = Math.atan2(dx, dz)                // local +z runs along the wall, +x through it
        this.world.createCollider(
          this.R.ColliderDesc.cuboid(S.thick / 2, h / 2, len / 2)
            .setTranslation((ax + bx) / 2, base + h / 2, (az + bz) / 2)
            .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
            .setCollisionGroups(GROUP.solid), body)
        n++
      }
    }
    if (!n) { this.world.removeRigidBody(body); return 0 }
    this.solids.set(obj.key, body)
    return n
  }

  unsolid(key) {
    const body = this.solids.get(key)
    if (!body) return
    this.world.removeRigidBody(body)
    this.solids.delete(key)
  }

  // ---- the debris pool --------------------------------------------------------------------------------------------

  // Every chip is made once and reused for the life of the page: a body, a collider sized to match, and one slot in
  // a single instanced mesh, so the whole pool costs one draw call however much of it is in the air.
  buildChips() {
    const C = T.physics.chips
    // no `vertexColors`: the per-instance colour arrives through `instanceColor`, and turning vertexColors on as
    // well would make the shader read a per-vertex colour attribute the box geometry does not have — which is not
    // white, it is an unbound attribute, i.e. black
    const mat = noOutline(Object.assign(new THREE.MeshStandardMaterial({ roughness: 1 }), { __shared: true }))
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, C.pool)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.frustumCulled = false                   // the pool is scattered; its rest bounds mean nothing
    this.mesh.count = C.pool
    const colour = new THREE.Color()
    for (let i = 0; i < C.pool; i++) {
      const size = C.size * (0.7 + (i % 7) / 10)      // never much under maxFall / step, or it slips through (see step())
      const body = this.world.createRigidBody(this.R.RigidBodyDesc.dynamic()
        .setTranslation(0, -1000, 0).setLinearDamping(T.physics.debris.linear).setAngularDamping(T.physics.debris.angular)
        .setCanSleep(true).setCcdEnabled(true).setEnabled(false))   // small, fast and cheap: without it they slip through the ground
      const col = this.world.createCollider(this.R.ColliderDesc.cuboid(size / 2, size / 2, size / 2)
        .setDensity(T.physics.debris.density).setFriction(T.physics.debris.friction)
        .setRestitution(T.physics.debris.bounce).setCollisionGroups(GROUP.debris), body)
      this.chips.push({ body, col, size, live: false, born: 0, prev: null })
      this.mesh.setMatrixAt(i, _m.makeScale(0, 0, 0))
      this.mesh.setColorAt(i, colour.setHex(CHIP_COLOURS[i % CHIP_COLOURS.length]))
    }
    this.mesh.instanceMatrix.needsUpdate = true
    this.mesh.instanceColor.needsUpdate = true
    this.scene.add(this.mesh)
  }

  // n chips thrown out of a point, the replacement for the hand-integrated boxes in game/Effects.js
  burst(x, y, z, r, n) {
    if (!this.world || !T.physics.on) return 0
    if (this.chunks && !this.chunks.ready(x, z)) return 0     // no ground under it yet: it would fall for ever
    const C = T.physics.chips
    let made = 0
    for (let k = 0; k < n; k++) {
      const chip = this.take()
      if (!chip) break
      const a = (k / n + Math.random() / n) * Math.PI * 2, up = 0.4 + Math.random() * 0.9
      const spread = Math.max(r, C.size * 1.5)              // born apart: five boxes inside one metre shove each
      chip.body.setEnabled(true)                            // other hard enough to push one of them through the floor
      chip.body.setTranslation({ x: x + Math.cos(a) * spread, y: y + Math.random() * r * 0.5, z: z + Math.sin(a) * spread }, true)
      chip.body.setRotation(_q.setFromAxisAngle(_up, Math.random() * 6.28), false)
      chip.body.setLinvel({ x: Math.cos(a) * C.speed * Math.random(), y: C.speed * up, z: Math.sin(a) * C.speed * Math.random() }, true)   // outwards and up
      chip.body.setAngvel({ x: (Math.random() - 0.5) * 9, y: (Math.random() - 0.5) * 9, z: (Math.random() - 0.5) * 9 }, true)
      chip.live = true
      chip.born = performance.now()
      chip.prev = null
      made++
    }
    return made
  }

  // a free slot, else the oldest one — and anything recycled in mid-air is set down on the ground first, because a
  // chip that stops being simulated while it is still falling is exactly the thing this module exists to prevent
  take() {
    const pool = this.chips
    if (!pool.length) return null
    for (let i = 0; i < pool.length; i++) {
      const chip = pool[(this.next + i) % pool.length]
      if (!chip.live) { this.next = (this.next + i + 1) % pool.length; return chip }
    }
    let oldest = pool[0]
    for (const chip of pool) if (chip.born < oldest.born) oldest = chip
    this.land(oldest)
    return oldest
  }

  land(chip) {
    const p = chip.body.translation()
    const ground = this.chunks ? this.chunks.heightAt(p.x, p.z) : 0
    if (p.y > ground + 0.2) chip.body.setTranslation({ x: p.x, y: ground + chip.size / 2, z: p.z }, false)
  }

  free(chip) {
    chip.live = false
    chip.body.setEnabled(false)
    chip.body.setLinvel({ x: 0, y: 0, z: 0 }, false)
    chip.body.setAngvel({ x: 0, y: 0, z: 0 }, false)
  }

  // ---- the buildings that are built out of pieces -----------------------------------------------------------

  // Every standing piece is a static box on one fixed body per building, so the car has something to hit and a
  // rocket has something to find. The pieces stay part of their building's merged geometry until one of them comes
  // loose, which is what keeps this affordable: thousands of colliders, no extra draw calls.
  attach(entry) {
    if (!this.world || entry.body) return
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.fixed())
    entry.body = body
    entry.live = new Map()                                        // piece → its dynamic slot, once it comes loose
    for (const piece of entry.pieces) {
      if (!piece.obb) continue
      const w = worldBox(piece.obb)
      const col = this.world.createCollider(this.R.ColliderDesc.cuboid(w.hx, w.hy, w.hz)
        .setTranslation(w.cx, w.cy, w.cz).setRotation(w.q).setCollisionGroups(GROUP.solid), body)
      piece.world = w
      piece.collider = col.handle
      this.pieces.set(col.handle, { entry, piece })
    }
  }

  detach(entry) {
    if (!this.world || !entry.body) return
    for (const piece of entry.pieces) {
      if (piece.collider != null) this.pieces.delete(piece.collider)
      piece.collider = null
      const slot = entry.live?.get(piece)
      if (slot) { this.world.removeRigidBody(slot.body); this.moving.delete(slot) }
    }
    this.world.removeRigidBody(entry.body)
    entry.body = null
    entry.live = null
  }

  // A piece comes off: its static box goes, a dynamic one takes its place at the same spot, and its triangles stay
  // where they are in the building's geometry — they are simply rewritten from the body's transform every frame.
  // The body is made with no rotation and the box carries the orientation instead, so the rest position of every
  // vertex is just "where it already is, relative to the centre", with no inverse rotation anywhere.
  breakPiece(entry, piece, vx = 0, vy = 0, vz = 0) {
    if (!this.world || !piece.obb || entry.live?.has(piece)) return null
    if (this.moving.size >= T.physics.pieces.max) return null
    const w = piece.world ?? worldBox(piece.obb)
    if (piece.collider != null) { this.world.removeCollider(this.world.getCollider(piece.collider), false); this.pieces.delete(piece.collider); piece.collider = null }
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.dynamic()
      .setTranslation(w.cx, w.cy, w.cz).setLinearDamping(T.physics.debris.linear).setAngularDamping(T.physics.debris.angular)
      .setCcdEnabled(true))
    this.world.createCollider(this.R.ColliderDesc.cuboid(w.hx, w.hy, w.hz).setRotation(w.q)
      .setDensity(T.physics.debris.density).setFriction(T.physics.debris.friction)
      .setRestitution(T.physics.debris.bounce).setCollisionGroups(GROUP.debris), body)
    body.setLinvel({ x: vx, y: vy, z: vz }, true)
    body.setAngvel({ x: (Math.random() - 0.5) * 3, y: (Math.random() - 0.5) * 3, z: (Math.random() - 0.5) * 3 }, true)
    const slot = { body, entry, piece, rest: restOf(entry, piece, w), born: performance.now(), asleep: false }
    entry.live.set(piece, slot)
    this.moving.add(slot)
    return slot
  }

  // Which standing pieces are within r of a point. One broad-phase query rather than a walk over every piece of
  // every building, which is what the car needs at 40 m/s and what a rocket needs over its blast radius.
  near(x, y, z, r) {
    const out = []
    if (!this.world) return out
    this.world.intersectionsWithShape({ x, y, z }, IDENTITY, this.ball(r), (col) => {
      const found = this.pieces.get(col.handle)
      if (found) out.push(found)
      return out.length < 24
    }, undefined, GROUP.query)
    return out
  }

  ball(r) {
    if (!this._ball || this._ballR !== r) { this._ball = new this.R.Ball(r); this._ballR = r }
    return this._ball
  }

  // the moving pieces, written back into the geometry they never left
  writePieces() {
    if (!this.moving.size) return
    const dirty = new Set()
    for (const slot of this.moving) {
      if (slot.asleep) continue
      const t = slot.body.translation(), r = slot.body.rotation()
      _q.set(r.x, r.y, r.z, r.w)
      _m.makeRotationFromQuaternion(_q).setPosition(t.x, t.y, t.z)
      for (const part of slot.rest) {
        const attr = part.attr, base = part.start * 3
        for (let i = 0; i < part.rest.length; i += 3) {
          _v.set(part.rest[i], part.rest[i + 1], part.rest[i + 2]).applyMatrix4(_m)
          attr.array[base + i] = _v.x; attr.array[base + i + 1] = _v.y; attr.array[base + i + 2] = _v.z
        }
        attr.needsUpdate = true
        dirty.add(attr)
      }
      // settled: write it one last time, freeze it where it lies and stop paying for it every frame. It still
      // collides — a heap of fallen wall is something to drive into — but it is no longer simulated.
      if (slot.body.isSleeping()) {
        slot.asleep = true
        slot.body.setBodyType(this.R.RigidBodyType.Fixed, false)
        this.moving.delete(slot)
      }
    }
  }

  // ---- the car --------------------------------------------------------------------------------------------------

  // ---- the vehicle -------------------------------------------------------------------------------------------

  // A real chassis: one dynamic body carrying the hull, and Rapier's raycast vehicle controller (Bullet's
  // btRaycastVehicle, port and all) casting a ray per wheel to hold it up. The wheels come off the mesh, so the
  // wheels that are drawn are the wheels that touch the ground — which is also what finally gives the three-wheeled
  // trike an honest attitude instead of the four-wheel average that pinned it at both clamps.
  //
  // The body's origin sits at the contact patch, where the meshes are authored, so `body.translation()` is the same
  // point the arcade model called (x, y, z) and nothing downstream has to learn a new anchor. Mass is declared
  // rather than derived: the collider has no density, and `setAdditionalMassProperties` carries the spec's mass, a
  // centre of mass dropped to about axle height (a box's own centroid rolls it over in every corner), and the
  // inertia of a box that size.
  setVehicle(spec, mesh) {
    if (!this.world) return
    this.dropVehicle()
    const b = spec.body ?? { hx: 0.9, hy: 0.5, hz: 2, y: 0.8, z: 0 }
    const m = spec.mass ?? 1400
    const chassis = this.world.createRigidBody(this.R.RigidBodyDesc.dynamic()
      .setTranslation(0, 0, 0).setCcdEnabled(true)
      .setLinearDamping(0).setAngularDamping(T.physics.car.angularDamping)
      .setAdditionalMassProperties(m, { x: 0, y: spec.com ?? b.y, z: b.z },
        { x: m * (b.hy * b.hy + b.hz * b.hz) / 3, y: m * (b.hx * b.hx + b.hz * b.hz) / 3, z: m * (b.hx * b.hx + b.hy * b.hy) / 3 },
        IDENTITY))
    this.world.createCollider(this.R.ColliderDesc.cuboid(b.hx, b.hy, b.hz)
      .setTranslation(0, b.y, b.z).setDensity(0)
      .setFriction(T.physics.car.hullFriction).setRestitution(0)
      .setCollisionGroups(GROUP.car)
      .setActiveEvents(this.R.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(T.physics.car.contactForce), chassis)

    const ctrl = this.world.createVehicleController(chassis)
    const C = T.physics.car
    const wheels = mesh.userData.wheels ?? []
    for (const w of wheels) {
      const r = w.r ?? T.susp.wheelRadius
      ctrl.addWheel({ x: w.lx, y: r + C.rest, z: w.lz }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, C.rest, r)
    }
    // Bullet's suspension numbers are its own: stiffness and damping are not N/m and Ns/m but scale with the
    // sprung weight the solver works out per wheel, so they are given straight rather than derived from the
    // spring-and-damper constants the old fake suspension used.
    const corner = m * Math.abs(T.physics.gravity) / Math.max(1, wheels.length)
    for (let i = 0; i < wheels.length; i++) {
      ctrl.setWheelSuspensionStiffness(i, C.stiffness)
      ctrl.setWheelSuspensionCompression(i, C.compression)
      ctrl.setWheelSuspensionRelaxation(i, C.relaxation)
      ctrl.setWheelMaxSuspensionTravel(i, T.susp.travel)
      ctrl.setWheelMaxSuspensionForce(i, corner * C.forceHeadroom)
      ctrl.setWheelFrictionSlip(i, (spec.grip ?? 1) * C.frictionSlip)
      ctrl.setWheelSideFrictionStiffness(i, C.sideStiffness)
    }
    this.chassis = chassis
    this.ctrl = ctrl
    this.spec = spec
    this.wheels = wheels
    this.car = chassis                                  // the name the rest of the module already knows it by
  }

  // What the driver is asking for, in newtons and radians. Called once a frame from game/Vehicle.js; the controller
  // holds the values until they are changed, so the same numbers apply to every substep.
  drive({ engine = 0, brake = 0, steer = 0, slip = null, rearSlip = null }) {
    const ctrl = this.ctrl
    if (!ctrl) return
    const wheels = this.wheels
    const driven = wheels.filter((w) => !w.front).length || wheels.length
    // Bullet's two pedals are not in the same units, which is a trap: the engine is a force (it multiplies by the
    // timestep itself) but the brake is the maximum *impulse* the tyre may take off the wheel this step. Hand it a
    // force and it arrives twenty times too hard, all of it at the contact patch, and the car pitches over its own
    // nose — which is exactly what the first version of this did. So the brake is converted here and every caller
    // gets to think in newtons.
    const h = this.world.timestep
    for (let i = 0; i < wheels.length; i++) {
      const w = wheels[i]
      const drives = wheels.length === driven || !w.front
      ctrl.setWheelEngineForce(i, drives ? engine / driven : 0)
      ctrl.setWheelBrake(i, (brake * h) / wheels.length)
      ctrl.setWheelSteering(i, w.front ? steer : 0)
      const g = (w.front ? slip : rearSlip ?? slip)
      if (g !== null) ctrl.setWheelFrictionSlip(i, g)
    }
  }

  // Standing forces on the chassis — drag, thrusters — and one-off impulses.
  //
  // Rapier's `addForce` is not a one-shot: it keeps applying every step until it is reset, which is exactly what a
  // standing force wants (it reaches every substep, not just the first) but means the driver has to clear last
  // frame's before setting this frame's. Forget that and the drag accumulates frame on frame until it strangles
  // the engine, which is what the first version of this did.
  clearForces() { this.chassis?.resetForces(false); this.chassis?.resetTorques(false) }
  force(x, y, z) { this.chassis?.addForce({ x, y, z }, true) }
  forceAt(x, y, z, px, py, pz) { this.chassis?.addForceAtPoint({ x, y, z }, { x: px, y: py, z: pz }, true) }
  torque(x, y, z) { this.chassis?.addTorque({ x, y, z }, true) }
  impulse(x, y, z) { this.chassis?.applyImpulse({ x, y, z }, true) }

  // The first thing on this line, and how far along it. Used by the rocket to find what it flew into: the terrain,
  // a standing wall or a heap of rubble, whichever comes first.
  rayHit(ox, oy, oz, dx, dy, dz, len) {
    if (!this.world) return null
    this._ray ??= new this.R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    this._ray.origin = { x: ox, y: oy, z: oz }
    this._ray.dir = { x: dx, y: dy, z: dz }
    const hit = this.world.castRay(this._ray, len, true, undefined, GROUP.missile)
    return hit ? hit.timeOfImpact : null
  }

  // Where the chassis has got to: the pose to draw and the state the game reasons about.
  read(out) {
    const c = this.chassis
    if (!c) return null
    const p = c.translation(), r = c.rotation(), v = c.linvel(), a = c.angvel()
    out.x = p.x; out.y = p.y; out.z = p.z
    out.qx = r.x; out.qy = r.y; out.qz = r.z; out.qw = r.w
    out.vx = v.x; out.vy = v.y; out.vz = v.z
    out.wy = a.y
    out.wheelsDown = 0
    for (let i = 0; i < this.wheels.length; i++) if (this.ctrl.wheelIsInContact(i)) out.wheelsDown++
    return out
  }

  dropVehicle() {
    if (this.ctrl) { this.world.removeVehicleController(this.ctrl); this.ctrl = null }
    if (this.chassis) { this.world.removeRigidBody(this.chassis); this.chassis = null }
    this.car = null
  }

  // A teleport is not a movement: set the pose hard and kill the velocity, or the solver reads the jump as several
  // hundred metres per second and fires the neighbourhood into orbit.
  warp(x, y, z, yaw) {
    const c = this.chassis
    if (!c) return
    c.setTranslation({ x, y, z }, false)
    c.setRotation(_q.setFromAxisAngle(_up, yaw), false)
    c.setLinvel({ x: 0, y: 0, z: 0 }, false)
    c.setAngvel({ x: 0, y: 0, z: 0 }, false)
    c.wakeUp()
  }

  // ---- the clock ----------------------------------------------------------------------------------------------

  update(dt) {
    if (!this.world || !T.physics.on) return
    const t0 = performance.now()
    const h = T.physics.step
    this.world.timestep = h
    this.acc = Math.min(this.acc + dt, h * T.physics.maxSteps)
    let steps = 0
    while (this.acc >= h) {
      for (const chip of this.chips) if (chip.live) this.remember(chip)
      this.step()
      this.acc -= h
      steps++
    }
    this.alpha = T.physics.interpolate ? this.acc / h : 1
    if (steps) { this.retire(); this.writePieces() }
    this.draw()
    this.stats.steps = steps
    this.stats.stepMs = performance.now() - t0
  }

  // One step, with a terminal velocity on the way in. This is the one number that has to be right: a body travels
  // `maxFall × step` metres between two contact checks, and a heightfield triangle is a surface with no thickness,
  // so anything much thinner than that goes straight through it however much CCD is switched on. Measured, dropping
  // boxes 20 m onto a hillside: at 15 m/s (0.25 m a step) the 0.30 m chips fell through and the 0.44 m ones did not.
  // So the terminal velocity and the smallest chip are a pair, kept about two to one apart, and `floorDrop` catches
  // whatever still gets away. Rubble falling at 11 m/s reads as heavy anyway.
  step() {
    // The controller casts its wheel rays and applies its forces against the state the solver is about to advance,
    // so it belongs inside the fixed step, not once a frame.
    if (this.ctrl) {
      this.ctrl.updateVehicle(this.world.timestep)
      const C = T.physics.car
      const v = this.chassis.linvel()
      if (v.y < -C.maxFall) this.chassis.setLinvel({ x: v.x, y: -C.maxFall, z: v.z }, false)
    }
    const cap = -T.physics.debris.maxFall
    for (const chip of this.chips) {
      if (!chip.live) continue
      const v = chip.body.linvel()
      if (v.y < cap) chip.body.setLinvel({ x: v.x, y: cap, z: v.z }, false)
    }
    this.world.step()
  }

  remember(chip) {
    const p = chip.body.translation(), r = chip.body.rotation()
    chip.prev ??= new Float64Array(7)
    chip.prev.set([p.x, p.y, p.z, r.x, r.y, r.z, r.w])
  }

  // asleep, too old, or fallen through a tile that unloaded under it
  retire() {
    const now = performance.now(), life = T.physics.chips.life * 1000
    let awake = 0, live = 0, highest = 0
    for (const chip of this.chips) {
      if (!chip.live) continue
      const p = chip.body.translation()
      const ground = this.chunks ? this.chunks.heightAt(p.x, p.z) : 0
      if (p.y < ground - T.physics.floorDrop || now - chip.born > life) { this.free(chip); continue }
      live++
      if (chip.body.isSleeping()) highest = Math.max(highest, p.y - ground - chip.size / 2)
      else awake++
    }
    this.stats.awake = awake
    this.stats.live = live
    this.stats.highest = highest
  }

  draw() {
    if (!this.mesh) return
    const a = this.alpha
    for (let i = 0; i < this.chips.length; i++) {
      const chip = this.chips[i]
      if (!chip.live) { this.mesh.setMatrixAt(i, _m.makeScale(0, 0, 0)); continue }
      const p = chip.body.translation(), r = chip.body.rotation(), q = chip.prev
      _v.set(p.x, p.y, p.z)
      _q.set(r.x, r.y, r.z, r.w)
      if (q && a < 1) {                               // where it was, where it is, and how far into the step we are
        _v.set(q[0] + (p.x - q[0]) * a, q[1] + (p.y - q[1]) * a, q[2] + (p.z - q[2]) * a)
        _q.copy(_q2.set(q[3], q[4], q[5], q[6])).slerp(_q2.set(r.x, r.y, r.z, r.w), a)
      }
      this.mesh.setMatrixAt(i, _m.compose(_v, _q, _s.setScalar(chip.size)))
    }
    this.mesh.instanceMatrix.needsUpdate = true
  }

  // everything goes: a new round, or the knob turned off
  clear() {
    for (const chip of this.chips) if (chip.live) this.free(chip)
  }
}

// ---- the shape of a piece ---------------------------------------------------------------------------------------

// A piece's oriented box in world terms: where its centre is, how big it is, and which way it is turned. The box is
// built in the plane the piece was made in (u along the wall, v up, n out of it), so a panel on a street that does
// not run north-south still gets a collider that lies flat against it.
// A BAG footprint is surveyed, so it is full of 20 cm jogs where a bay window or a downpipe was measured. Each one
// would be its own collider. Drop any vertex that sits within `tol` of the line between its neighbours: the wall
// moves by less than the slab is thick, and a third of the colliders go away.
function simplify(ring, tol) {
  if (ring.length <= 8) return ring                             // a box: nothing to gain
  let pts = Array.from(ring)
  for (let pass = 0; pass < 4; pass++) {
    const out = []
    const n = pts.length / 2
    for (let i = 0; i < n; i++) {
      const a = ((i - 1 + n) % n) * 2, b = i * 2, c = ((i + 1) % n) * 2
      const dx = pts[c] - pts[a], dz = pts[c + 1] - pts[a + 1]
      const len = Math.hypot(dx, dz)
      const off = len > 1e-6
        ? Math.abs(dx * (pts[a + 1] - pts[b + 1]) - (pts[a] - pts[b]) * dz) / len
        : Math.hypot(pts[b] - pts[a], pts[b + 1] - pts[a + 1])
      if (off >= tol || out.length / 2 + (n - i - 1) < 4) { out.push(pts[b], pts[b + 1]) }
    }
    if (out.length === pts.length) return out
    pts = out
    if (pts.length <= 8) return pts
  }
  return pts
}

function worldBox(obb) {
  _mm.makeBasis(obb.basis.u, obb.basis.v, obb.basis.n)
  const q = _qq.setFromRotationMatrix(_mm)
  const u = (obb.u0 + obb.u1) / 2, v = (obb.v0 + obb.v1) / 2, d = (obb.d0 + obb.d1) / 2
  return {
    cx: obb.basis.u.x * u + obb.basis.v.x * v + obb.basis.n.x * d,
    cy: obb.basis.u.y * u + obb.basis.v.y * v + obb.basis.n.y * d,
    cz: obb.basis.u.z * u + obb.basis.v.z * v + obb.basis.n.z * d,
    hx: Math.max(0.02, (obb.u1 - obb.u0) / 2), hy: Math.max(0.02, (obb.v1 - obb.v0) / 2),
    hz: Math.max(0.02, (obb.d1 - obb.d0) / 2),
    q: { x: q.x, y: q.y, z: q.z, w: q.w },
  }
}

// where every vertex of a piece sits relative to its own centre, taken once, the moment it comes loose
function restOf(entry, piece, w) {
  const out = []
  for (const range of piece.ranges) {
    const geo = entry.geos?.get(range.name)
    if (!geo) continue
    const attr = geo.attributes.position
    const rest = new Float32Array(range.count * 3)
    for (let i = 0; i < range.count * 3; i += 3) {
      rest[i] = attr.array[range.start * 3 + i] - w.cx
      rest[i + 1] = attr.array[range.start * 3 + i + 1] - w.cy
      rest[i + 2] = attr.array[range.start * 3 + i + 2] - w.cz
    }
    out.push({ attr, start: range.start, rest })
  }
  return out
}

const _mm = new THREE.Matrix4(), _qq = new THREE.Quaternion()
