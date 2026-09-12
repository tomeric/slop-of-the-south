import * as THREE from "three"
import { distTo } from "game/Destructibles"
import { softTexture } from "game/Effects"
import { TUNING as T, euro } from "game/Tuning"

// What the player's vehicle does to the world: ramming, driving over rubble, and the tricks on E: the trike's
// missiles, the monster truck's jump and the bulldozer's blade. Everything here is local prediction plus messages:
// damage is queued per object and sent to the server in `hit` batches, the server decides when something falls
// (Destructibles.apply), and `fire` tells the other players what to draw. Explosions also shove nearby cars.
const JUMP = { r: 4, dmg: 90 }          // what a hard landing crushes under the monster truck
const BLADE = { lift: 0.35, tilt: 0.32, rate: 2.5, slam: 150, reach: 2.2 }   // the arms rise and pivot up (rad), per second, damage on the way
const _mz = new THREE.Vector3(), _dir = new THREE.Vector3()
const shotMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d0, metalness: 0.5, roughness: 0.4 })
const noseMat = new THREE.MeshStandardMaterial({ color: 0xc8102e, roughness: 0.5 })
const finMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.8 })
let flameMat = null

export class Combat {
  constructor({ scene, index, effects, heightAt, car, send, structures, physics }) {
    this.scene = scene
    this.index = index
    this.effects = effects
    this.heightAt = heightAt
    this.car = car
    this.send = send
    this.structures = structures    // the houses built out of pieces: what the car can go through rather than off
    this.physics = physics
    this.pending = new Map()        // key → { damage, max } since the last flush
    this.lastRam = new WeakMap()    // object → time of the last ram, so a car resting against it does not hammer it
    this.billed = new WeakMap()     // object → euros taken off it since it last counted towards a figure
    this.pot = 0                    // euros come due since the last bang, summed across every building involved
    this.potAt = [ 0, 0, 0 ]
    this.enabled = false            // only while a round is running
    this.shots = []                 // { mesh, x, y, z, vx, vy, vz, life, own, puff }
    this.blades = new Map()         // mesh → { t, target, slammed } for every bulldozer blade on screen
    this.cd = 0                     // seconds until the trick is ready again
  }

  // ---- collisions ---------------------------------------------------------------------------------------------------

  // Between car.integrate() and car.settle(): twelve probes around the body (three per side) against the index. The
  // damage a hit does grows with the square of the speed into the wall, so a flank sliding into a house at speed
  // hurts it more than a nudge, and the monster truck's `side` factor rewards drifting in sideways. The car is
  // pushed out along the contact normal and loses the speed it had into the wall, keeping most of the rest.
  // Pushing vehicles grind through what is in front of them; rubble only slows and takes chipping; an airborne car
  // clears posts and trees but not houses. One contact resolves per frame.
  // What a hit costs, in hit points. It is the kinetic energy the vehicle actually delivers into the thing it hit:
  // half its mass times the closing speed along the contact normal, squared. So doubling your speed does four times
  // the damage, and a bulldozer that has been slowed to walking pace stops being a wrecking ball.
  //
  // Two coefficients sit on top. `bite` is how well the thing is shaped for demolition — a blade concentrates its
  // energy into a wall, a trike's nose splatters — and it is what keeps the three vehicles distinct now that mass
  // does the rest. The direction multiplier is which part of you made contact: the monster truck hits twice as hard
  // with a flank and four times as hard with its underside, and a bulldozer with its blade in motion lands half as
  // hard again.
  energy(car, closing, mult = 1) {
    return T.damage.k * 0.5 * car.mass * closing * closing * (car.spec.bite ?? 0.3) * mult
  }

  // the blade counts only while it is actually swinging, which is the 0.4 s between a press and the arms arriving
  bladeMoving(mesh) {
    const b = this.blades.get(mesh)
    return !!b && b.t !== b.target
  }

  // Clear a path. The chassis is a real body now, so a wall stops it the moment it touches one — and a wall is many
  // panels thick, so breaking a few at a probe point leaves the car stalled against the rest of the house. Above the
  // vehicle's smash speed it instead sweeps everything out of a ball just ahead of the bumper, sized by the vehicle
  // and by how fast it is going, and drives on through what is now loose rubble. The speed it loses is the energy
  // the solver takes off it shoving that rubble aside, which is a better answer than the per-panel tax used to be.
  plough(car, dt, input) {
    const spec = car.spec, v = car.speed
    if (!this.physics?.world) return 0
    const fast = v >= (spec.smashMin ?? T.physics.smash.speed)
    // Stopped against a wall with the throttle down, what gets through is not speed but traction — the force the
    // vehicle can actually put on the ground, which is its mass times its acceleration. That is 60 kN for the
    // bulldozer, 36 for the monster truck and 3.9 for the trike: high, middling and very nearly hopeless, without a
    // table anywhere saying so. So leaning on a house works, and how well depends on what you are leaning with.
    const press = !fast && input?.throttle > 0 && v > -0.5 ? car.mass * car.accel : 0
    if (!fast && !press) { this.grindT = 0; return 0 }
    const f = car.forward()
    const reach = spec.length / 2 + T.physics.smash.ahead + Math.abs(v) * dt
    const px = car.x + f.x * reach, pz = car.z + f.z * reach
    const r = Math.max(T.physics.smash.reach, (spec.track ?? 2) * 0.5 + T.physics.smash.reach)
    const here = this.physics.near(px, car.y + (spec.body?.y ?? 1), pz, r)
    if (!here.length) { this.grindT = 0; return 0 }

    // How many panels may go this frame: everything in the way when you arrive at speed, or what your traction
    // grinds off while you lean. The fractional part carries over, or a trike would never break anything at all.
    let budget = T.physics.smash.perFrame
    if (!fast) {
      this.grindT = (this.grindT ?? 0) + (press / T.physics.smash.perNewton) * dt
      budget = Math.floor(this.grindT)
      if (budget > 0) this.grindT -= budget
      this.queue(here[0].entry.obj, press * T.damage.grind * dt)
    }
    let n = 0
    for (const h of here) {
      if (n >= budget) break
      const shove = fast ? T.physics.smash.shove : T.physics.smash.shove * 0.3
      const broke = this.structures.break(h.entry, h.piece, car.vx * shove, 1.5, car.vz * shove)
      if (broke) this.queue(h.entry.obj, T.physics.smash.damage)
      n += broke
    }
    if (n) {
      this.effects.dust(px, car.y + 0.8, pz, 1.2 + n * 0.3)
      this.effects.shake(Math.min(0.5, Math.abs(v) / 40))
    }
    return n
  }

  // What the front of the vehicle does to the rubbish lying in the road, which is a different job from what it does
  // to walls. `clear` is the same coefficient the rubble heaps use and spans 0.4 to 50, so a trike nudges a brick
  // and a bulldozer clears the street — and the dozer, alone, carts off what goes under the blade instead of
  // pushing an ever-growing pile in front of it.
  sweep(car, dt) {
    const spec = car.spec, v = car.speed
    if (!this.physics?.world || !spec.clear || Math.abs(v) < 1) return
    const D = T.physics.debris
    const f = car.forward()
    const reach = spec.length / 2 + D.sweepAhead
    // A blade only clears when it is down. Nothing in the map means it has never been raised.
    const b = this.blades.get(car.mesh)
    const carts = spec.push === true && (!b || b.t < 0.5)
    const push = spec.clear * D.sweepPush * Math.min(1, Math.abs(v) / 8) * dt
    // A blade is wider than the machine, and it takes the whole swath: shove and cart at the same radius, or the
    // rubbish is simply pushed along in front of the blade for ever and never actually cleared, which is what the
    // first version of this did and what the complaint was.
    const r = (spec.track ?? 2) * 0.6 + 0.6 + (carts ? D.bladeExtra : 0)
    const x = car.x + f.x * reach, z = car.z + f.z * reach
    const { carted } = this.physics.shove(x, car.y + 0.4, z, r, Math.sign(v) * f.x, Math.sign(v) * f.z, push, carts ? r : 0)
    if (carted) this.effects.dust(x, car.y + 0.4, z, 1 + carted * 0.25)
  }

  collide(car, dt, input) {
    this.plough(car, dt, input)
    this.sweep(car, dt)
    const spec = car.spec, f = car.forward(), rx = -f.z, rz = f.x
    const hl = spec.length / 2, ht = spec.track / 2, v = car.speed
    const probes = [[-1, hl], [1, hl], [0, hl], [-1, -hl], [1, -hl], [0, -hl], [-1, hl * 0.5], [-1, 0], [-1, -hl * 0.5], [1, hl * 0.5], [1, 0], [1, -hl * 0.5]]
    if (Math.abs(v) * dt > 1) probes.push([0, (v > 0 ? hl : -hl) - v * dt / 2])             // swept: a fast car skips no wall
    for (const [side, along] of probes) {
      const px = car.x + f.x * along + rx * side * ht, pz = car.z + f.z * along + rz * side * ht
      const hit = this.index.hitPoint(px, pz, 0.3)
      if (!hit) continue
      const { obj, nx, nz, depth } = hit
      if (car.airborne && !obj.rings) continue
      const flank = Math.abs(nx * rx + nz * rz) > Math.abs(nx * f.x + nz * f.z)               // the wall faces the side, not the nose
      // Rubble, either kind: what a building crumbled to, or a heap the server has put in the parade's way. You
      // plough through it rather than off it — the pieces lying there are real bodies and slow the car themselves,
      // so nothing here has to pretend to.
      if (obj.state === 1 || obj.kind === "d") { this.queue(obj, spec.clear * Math.abs(v) * 4 * dt); break }
      const into0 = -(car.vx * nx + car.vz * nz)
      // A house built out of pieces is not a footprint any more. hitPoint still answers with the outline BAG
      // surveyed, but what is actually in the way is whatever panels are still standing there — so ask the physics
      // world, and if the wall at this spot has already gone, drive on through the hole.
      if (this.structures?.get(obj.key)) {
        // Whatever is standing at this point, whoever owns it. A terrace shares its party walls with the house next
        // door, and asking only about the building hitPoint happened to name left the car gliding through the one
        // that was actually in the way.
        const here = this.physics.near(px, car.y + 0.7, pz, T.physics.smash.reach)
        if (!here.length) continue                                     // the wall that stood here is gone: drive on
        // What it takes to go through one is the vehicle's business, not the world's: a bulldozer leans on it at
        // walking pace, a monster truck needs a run-up, a trike needs to be reckless.
        if (into0 > (spec.smashMin ?? T.physics.smash.speed)) {
          this.queue(obj, this.energy(car, into0, T.damage.through))    // the panels themselves are plough()'s business
          break
        }
        break                                                           // too slow to break it: plough() bills the lean
      }
      if (spec.push && !flank && v > spec.pushMin && nx * f.x + nz * f.z < 0) { this.queue(obj, this.energy(car, v, T.damage.through) * dt * 4); this.effects.shake(0.05); break }
      car.x += nx * depth; car.z += nz * depth
      const into = -(car.vx * nx + car.vz * nz)                                              // speed into the wall
      if (into <= 0) continue
      const wx = car.vx + nx * into * 1.2, wz = car.vz + nz * into * 1.2                    // that part reverses to a fifth
      car.speed = wx * f.x + wz * f.z; car.lateral = wx * rx + wz * rz; car.vx = wx; car.vz = wz
      if (into > 2 && this.rammed(obj)) {
        const mult = (flank ? spec.side ?? 1 : 1) * (this.bladeMoving(car.mesh) ? spec.blade ?? 1 : 1)
        this.queue(obj, this.energy(car, into, mult))
        this.effects.dust(px, car.y + 0.6, pz, 1.5)
        this.effects.shake(Math.min(0.6, into / 30))
      }
      break
    }
  }

  // What this hit costs in euros. A building has to lose `T.money.label` of itself before it is worth a figure, and
  // everything that comes due inside one flush — a tenth of a second, whether that is three panels of one house or
  // a whole terrace going over at once — goes up as a single summed number rather than a stack of small ones.
  // The running total is the server's to keep (lib/game/round.rb); this is only the label.
  bill(obj, dmg) {
    if (!(obj.woz > 0)) return
    const euros = obj.woz * Math.min(dmg, obj.hp ?? obj.max) / (obj.max || 1)
    const owed = (this.billed.get(obj) ?? 0) + euros
    if (owed < T.money.label) { this.billed.set(obj, owed); return }
    this.billed.set(obj, 0)
    this.pot += owed
    this.potAt = [ obj.x, (this.heightAt(obj.x, obj.z) ?? 0) + (obj.h ?? 4) * 0.8, obj.z ]
  }

  // one bang for everything that has come due since the last one
  bang() {
    if (!(this.pot > 0)) return
    this.effects.price(...this.potAt, this.pot, euro(this.pot))
    this.pot = 0
  }

  rammed(obj) {
    const t = performance.now()
    if (t - (this.lastRam.get(obj) ?? 0) < 250) return false
    this.lastRam.set(obj, t)
    return true
  }

  // ---- the tricks --------------------------------------------------------------------------------------------------

  // E fires the vehicle's trick when its cooldown has run out (outside a round it is all show: queue() drops the
  // damage); landings and blades in motion resolve here too
  abilities(car, input, dt) {
    this.cd = Math.max(0, this.cd - dt)
    if (car.landed) {                                                                       // a hop off a hill puffs dust; the monster truck's hard landings crush
      car.landed = false
      // landing on a house is a hit with your underside, at the speed you landed with — which is where the monster
      // truck's bottom multiplier earns its keep
      if (car.landImpact > T.damage.landMin) {
        const dmg = this.energy(car, car.landImpact, car.spec.bottom ?? 1)
        if (dmg > 1) this.explode(car.x, car.y + 0.5, car.z, JUMP.r, dmg, true, false)
      }
      else if (car.landImpact > 2) this.effects.dust(car.x, car.y + 0.4, car.z, 1 + car.landImpact * 0.3)
      this.effects.shake(Math.min(0.6, car.landImpact / 12))
    }
    this.moveBlades(dt)
    const a = car.spec.ability
    if (a.kind === "none" || a.kind === "thrust" || !input.ability || this.cd > 0) return
    switch (a.kind) {
      case "missile": this.launch(car, true); break
      case "blade":   this.toggleBlade(car.mesh, true); break
    }
    this.cd = a.cooldown
    this.send("fire", { kind: a.kind, x: car.x, y: car.y, z: car.z, yaw: car.yaw, ...(this.lastShot ?? {}) })
  }

  get cooldownFraction() { const c = this.car?.spec.ability.cooldown; return c ? this.cd / c : 0 }

  // Fire from where the launcher actually is. The tube is a group on the trike's own mesh, so its muzzle and the
  // direction it points come off the matrix — which is the end of the two copies of those offsets that used to sit
  // in this file, one of which had the lateral sign the wrong way round and put every other player's rocket out of
  // the far side of the trike. The trike's own velocity goes with it, because a rocket does not forget it was moving.
  launch(car, own) {
    const a = car.mesh?.userData.anim
    if (!a?.muzzle) return
    car.mesh.updateMatrixWorld()
    a.muzzle.getWorldPosition(_mz)
    a.launcher.getWorldDirection(_dir).negate()              // getWorldDirection is +z; the muzzle points down -z
    const M = T.missile
    const vx = car.vx + _dir.x * M.speed, vy = (car.vy ?? 0) + _dir.y * M.speed, vz = car.vz + _dir.z * M.speed
    this.lastShot = { mx: +_mz.x.toFixed(2), my: +_mz.y.toFixed(2), mz: +_mz.z.toFixed(2),
                      vx: +vx.toFixed(2), vy: +vy.toFixed(2), vz: +vz.toFixed(2) }
    this.shoot(_mz.x, _mz.y, _mz.z, vx, vy, vz, own)
  }

  // a missile: body, red nose, fins and a flame at the tail; it leaves a smoke trail while it flies
  shoot(x, y, z, vx, vy, vz, own) {
    const mesh = new THREE.Group()
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 1.3, 10), shotMat); body.rotation.x = Math.PI / 2; mesh.add(body)
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.4, 10), noseMat); nose.rotation.x = -Math.PI / 2; nose.position.z = -0.85; mesh.add(nose)
    for (const [fx, fy] of [[0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]]) { const fin = new THREE.Mesh(new THREE.BoxGeometry(fx ? 0.45 : 0.04, fy ? 0.45 : 0.04, 0.3), finMat); fin.position.set(fx, fy, 0.5); mesh.add(fin) }
    flameMat ??= new THREE.SpriteMaterial({ map: softTexture(), color: 0xff9a2a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
    const flame = new THREE.Sprite(flameMat); flame.position.z = 0.95; flame.scale.setScalar(0.9); mesh.add(flame)
    mesh.position.set(x, y, z)
    mesh.lookAt(x + vx, y + vy, z + vz)
    this.scene.add(mesh)
    this.shots.push({ mesh, flame, x, y, z, vx, vy, vz, life: T.missile.life, own, puff: 0 })
  }

  // A rocket is ballistic now: it leaves the launcher on the arc the tube is pointing along, carrying the trike's
  // own speed with it, and falls at the same gravity everything else does. What it flew into comes from one ray per
  // substep against the world the car drives on — the terrain, a standing wall, a heap of rubble — rather than the
  // old flat test of "am I below the ground, or inside a footprint's height box", which could not tell a roof from
  // the street and never checked the vertical at all because the vertical never moved.
  projectiles(dt) {
    const M = T.missile
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i]
      const speed = Math.hypot(s.vx, s.vy, s.vz)
      const n = Math.max(1, Math.ceil(speed * dt / M.step)), h = dt / n
      let burst = null
      for (let k = 0; k < n && !burst; k++) {
        s.vy += T.physics.gravity * h
        const dx = s.vx * h, dy = s.vy * h, dz = s.vz * h
        const len = Math.hypot(dx, dy, dz) || 1e-6
        const toi = this.physics?.rayHit(s.x, s.y, s.z, dx / len, dy / len, dz / len, len)
        if (toi != null) burst = [s.x + dx / len * toi, s.y + dy / len * toi, s.z + dz / len * toi]
        else {
          s.x += dx; s.y += dy; s.z += dz
          if (s.y <= this.heightAt(s.x, s.z)) burst = [s.x, this.heightAt(s.x, s.z), s.z]   // tiles with no collider yet
        }
      }
      if (burst) { this.explode(burst[0], burst[1], burst[2], M.r, M.dmg, s.own); this.drop(i); continue }
      if ((s.life -= dt) <= 0) { this.drop(i); continue }
      s.mesh.position.set(s.x, s.y, s.z)
      s.mesh.lookAt(s.x + s.vx, s.y + s.vy, s.z + s.vz)       // the nose follows the arc down
      s.flame.scale.setScalar(0.7 + 0.4 * Math.random())
      if ((s.puff += dt) > 0.05) {                                                             // the exhaust plume
        s.puff = 0
        const k = 1.1 / (speed || 1)
        this.effects.smoke.emit(s.x - s.vx * k, s.y - s.vy * k, s.z - s.vz * k,
          (Math.random() - 0.5) * 2, 1.5 + Math.random(), (Math.random() - 0.5) * 2, 0.9, 0.5, 2.4, 0.55)
      }
    }
  }

  drop(i) { this.scene.remove(this.shots[i].mesh); this.shots.splice(i, 1) }

  // the bulldozer's blade goes up or down over half a second; a building it meets on the way takes a slam
  toggleBlade(mesh, own) {
    const b = this.blades.get(mesh) ?? { t: 0, target: 0, slammed: true, own }
    b.target = b.target ? 0 : 1
    b.slammed = false
    this.blades.set(mesh, b)
  }

  moveBlades(dt) {
    for (const [mesh, b] of this.blades) {
      const blade = mesh.userData.anim?.blade
      if (!blade || !mesh.parent) { this.blades.delete(mesh); continue }
      if (b.t === b.target) continue
      b.t = b.target > b.t ? Math.min(b.target, b.t + BLADE.rate * dt) : Math.max(b.target, b.t - BLADE.rate * dt)
      blade.position.y = b.t * BLADE.lift
      blade.rotation.x = b.t * BLADE.tilt                                                     // the arms pivot at the hull; the blade out front swings up
      if (b.slammed || !b.own) continue
      const yaw = mesh.rotation.y, fx = -Math.sin(yaw), fz = -Math.cos(yaw)
      const px = mesh.position.x + fx * 3.2, pz = mesh.position.z + fz * 3.2
      const hit = this.index.hitPoint(px, pz, 0.6)
      if (hit?.obj.rings) {
        b.slammed = true
        this.queue(hit.obj, BLADE.slam)
        // and if it is built out of pieces, the blade takes the ones it is standing against with it
        const entry = this.structures?.get(hit.obj.key)
        if (entry) for (const h of this.physics.near(px, mesh.position.y + 1.2, pz, BLADE.reach)) {
          if (h.entry === entry) this.structures.break(entry, h.piece, fx * 4, 3, fz * 4)
        }
        this.effects.dust(px, mesh.position.y + 1, pz, 2.5)
        this.effects.shake(0.35)
      }
    }
  }

  // damage everything standing within r of (x, z), falling off to half at the edge, and shove the player's car if it
  // stands close; `own` false replays another player's shot: looks and knockback only, the damage is theirs. A
  // landing of your own does not shove you (`shove` false), or the monster truck would bounce forever.
  explode(x, y, z, r, dmg, own = true, shove = true) {
    this.effects.explosion(x, y, z, r)
    if (own) this.index.near(x, z, r, (obj) => this.queue(obj, dmg * (1 - 0.5 * distTo(x, z, obj) / r)))
    // A blast against a house that is built out of pieces takes the pieces, not just the hit points. This runs for
    // everybody's rockets, not only your own: the hole is cosmetic, and two players seeing the same hole is worth
    // more than being strict about whose damage it was.
    if (this.physics?.world) {
      const blast = T.physics.blast
      // whatever is already lying there gets broken up rather than merely shoved again
      this.structures?.shatter(x, y, z, r * blast.reach)
      for (const { entry, piece } of this.physics.near(x, y, z, r * blast.reach)) {
        const c = piece.world
        const dx = c.cx - x, dy = c.cy - y, dz = c.cz - z, d = Math.hypot(dx, dy, dz) || 1
        const k = blast.push * (1 - Math.min(1, d / (r * blast.reach)))
        this.structures.break(entry, piece, dx / d * k, Math.abs(dy / d) * k + 2, dz / d * k)
      }
    }
    const car = this.car
    if (!car || !shove) return
    const d = Math.hypot(car.x - x, car.z - z)
    if (d < 1.5 * r) {
      const k = (1 - d / (1.5 * r)) * Math.min(14, dmg / 10)
      car.kick((car.x - x) / (d || 1) * k, (car.z - z) / (d || 1) * k)
      if (k > 4 && !car.airborne) car.jump(Math.min(6, k * 0.5))
    }
  }

  // another player's trick, as seen from here
  remoteFire(msg, mesh) {
    if (msg.kind === "missile" && msg.vx != null) this.shoot(msg.mx, msg.my, msg.mz, msg.vx, msg.vy, msg.vz, false)
    if (msg.kind === "blade" && mesh) this.toggleBlade(mesh, false)
  }

  // ---- the hit queue -----------------------------------------------------------------------------------------------

  queue(obj, dmg) {
    if (!this.enabled || dmg < 0.5 || obj.state === 2) return
    this.bill(obj, dmg)
    for (const key of obj.keys ?? [obj.key]) {
      const q = this.pending.get(key) ?? { damage: 0, max: obj.max, woz: obj.woz }
      q.damage += dmg
      this.pending.set(key, q)
    }
  }

  // every 100 ms from game.js, next to the position update
  flush() {
    this.bang()                     // everything that came due in the last tenth of a second, as one figure
    if (!this.pending.size) return
    // `woz` is what this building is worth in euros, so the server can total the damage the room has done. It is
    // sent with every hit and the server keeps the first figure it is given for a building.
    const hits = [...this.pending].map(([key, h]) => ({ key, damage: Math.round(h.damage * 10) / 10, max: h.max, woz: h.woz || 0 }))
    this.pending.clear()
    for (let i = 0; i < hits.length; i += 32) this.send("hit", { hits: hits.slice(i, i + 32) })
  }

  reset() {
    this.pending.clear()
    this.pot = 0
    while (this.shots.length) this.drop(this.shots.length - 1)
    this.cd = 0
  }
}
