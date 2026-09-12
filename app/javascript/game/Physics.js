import * as THREE from "three"
import { TUNING as T } from "game/Tuning"
import { noOutline } from "game/Outline"

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
const GROUP = {                                       // (what I am << 16) | (what I collide with)
  terrain: (1 << 16) | 4,
  solid: (2 << 16) | 4,
  debris: (4 << 16) | 15,
  car: (8 << 16) | 4,
}
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
      this.buildChips()
      for (const tile of this.waiting) this.addTile(tile)
      this.waiting.length = 0
      this.stats.bootMs = Math.round(performance.now() - t0)
    })()
    return this.loading
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

  // ---- the car --------------------------------------------------------------------------------------------------

  // A kinematic box: it pushes debris at the speed it is really travelling and debris cannot push it back. The size
  // comes off the mesh because the vehicle specs carry a length and a track but no width or height.
  setCar(mesh) {
    if (!this.world) return
    const box = new THREE.Box3().setFromObject(mesh)
    box.getSize(_v)
    if (this.car) this.world.removeRigidBody(this.car)
    this.carHalf = _v.clone().multiplyScalar(0.5)
    this.car = this.world.createRigidBody(this.R.RigidBodyDesc.kinematicPositionBased())
    this.world.createCollider(this.R.ColliderDesc.cuboid(this.carHalf.x, this.carHalf.y, this.carHalf.z)
      .setCollisionGroups(GROUP.car), this.car)
  }

  // a teleport is not a movement: set it hard, or the solver reads the jump as a velocity
  warp(car) {
    if (!this.car) return
    this.car.setTranslation({ x: car.x, y: car.y + this.carHalf.y, z: car.z }, false)
    this.car.setRotation(_q.setFromAxisAngle(_up, car.yaw), false)
  }

  // ---- the clock ----------------------------------------------------------------------------------------------

  update(dt, car) {
    if (!this.world || !T.physics.on) return
    const t0 = performance.now()
    // A kinematic body's velocity is inferred from how far it was told to move, so a teleport would read as several
    // hundred metres per second and fire the neighbourhood into orbit. Anything past a frame's worth of the fastest
    // car there is (~55 m/s) is not driving, so set it hard instead of sweeping to it. One guard here beats
    // remembering to call `warp` at the four places that move the car.
    if (this.car && car) {
      const jump = this.was ? Math.hypot(car.x - this.was.x, car.z - this.was.z) : 0
      if (!this.was || jump > T.physics.warpJump) this.warp(car)
      else {
        this.car.setNextKinematicTranslation({ x: car.x, y: car.y + this.carHalf.y, z: car.z })
        this.car.setNextKinematicRotation(_q.setFromAxisAngle(_up, car.yaw))
      }
      this.was = { x: car.x, z: car.z }
    }
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
    if (steps) this.retire()
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
