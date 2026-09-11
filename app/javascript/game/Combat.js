import * as THREE from "three"
import { distTo } from "game/Destructibles"
import { softTexture } from "game/Effects"

// What the player's vehicle does to the world: ramming, driving over rubble, and the tricks on E: the trike's
// missiles, the monster truck's jump and the bulldozer's blade. Everything here is local prediction plus messages:
// damage is queued per object and sent to the server in `hit` batches, the server decides when something falls
// (Destructibles.apply), and `fire` tells the other players what to draw. Explosions also shove nearby cars.
const STEP = 1.5                     // metres a shot may travel between hit tests
const MISSILE = { speed: 60, life: 3, r: 6, dmg: 70 }
const JUMP = { v: 9, r: 4, dmg: 90 }
const BLADE = { lift: 0.35, tilt: 0.32, rate: 2.5, slam: 150 }   // the arms rise and pivot up (rad), per second, damage on the way
const shotMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d0, metalness: 0.5, roughness: 0.4 })
const noseMat = new THREE.MeshStandardMaterial({ color: 0xc8102e, roughness: 0.5 })
const finMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.8 })
let flameMat = null

export class Combat {
  constructor({ scene, index, effects, heightAt, car, send }) {
    this.scene = scene
    this.index = index
    this.effects = effects
    this.heightAt = heightAt
    this.car = car
    this.send = send
    this.pending = new Map()        // key → { damage, max } since the last flush
    this.lastRam = new WeakMap()    // object → time of the last ram, so a car resting against it does not hammer it
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
  collide(car, dt) {
    const spec = car.spec, f = car.forward(), rx = -f.z, rz = f.x
    const hl = spec.length / 2, ht = spec.track / 2, v = car.speed
    const probes = [[-1, hl], [1, hl], [0, hl], [-1, -hl], [1, -hl], [0, -hl], [-1, hl * 0.5], [-1, 0], [-1, -hl * 0.5], [1, hl * 0.5], [1, 0], [1, -hl * 0.5]]
    if (Math.abs(v) * dt > 1) probes.push([0, (v > 0 ? hl : -hl) - v * dt / 2])             // swept: a fast car skips no wall
    for (const [side, along] of probes) {
      const px = car.x + f.x * along + rx * side * ht, pz = car.z + f.z * along + rz * side * ht
      const hit = this.index.hitPoint(px, pz, 0.3)
      if (!hit) continue
      const { obj, nx, nz, depth } = hit
      if (car.vy !== null && !obj.rings) continue
      const flank = Math.abs(nx * rx + nz * rz) > Math.abs(nx * f.x + nz * f.z)               // the wall faces the side, not the nose
      if (obj.state === 1) { car.speed *= 1 - 2.5 * dt; this.queue(obj, spec.clear * Math.abs(v) * 4 * dt); break }
      if (spec.push && !flank && v > spec.pushMin && nx * f.x + nz * f.z < 0) { car.speed *= 1 - 1.5 * dt; this.queue(obj, spec.ram * v * 10 * dt); this.effects.shake(0.05); break }
      car.x += nx * depth; car.z += nz * depth
      const into = -(car.vx * nx + car.vz * nz)                                              // speed into the wall
      if (into <= 0) continue
      const wx = car.vx + nx * into * 1.2, wz = car.vz + nz * into * 1.2                    // that part reverses to a fifth
      car.speed = wx * f.x + wz * f.z; car.lateral = wx * rx + wz * rz; car.vx = wx; car.vz = wz
      if (into > 2 && this.rammed(obj)) {
        this.queue(obj, spec.ram * (flank ? spec.side ?? 1 : 1) * into * into)
        this.effects.dust(px, car.y + 0.6, pz, 1.5)
        this.effects.shake(Math.min(0.6, into / 30))
      }
      break
    }
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
    if (car.landed) { car.landed = false; this.explode(car.x, car.y + 0.5, car.z, JUMP.r, JUMP.dmg, true, false); this.effects.shake(0.5) }
    this.moveBlades(dt)
    const a = car.spec.ability
    if (a.kind === "none" || !input.ability || this.cd > 0) return
    switch (a.kind) {
      case "missile": { const f = car.forward(), rx = -f.z, rz = f.x, n = car.spec.length / 2 + 0.8; this.shoot(car.x + f.x * n + rx * 0.55, car.y + 1.05, car.z + f.z * n + rz * 0.55, f, true); break }
      case "jump":    if (car.vy !== null) return; car.jump(JUMP.v); break
      case "blade":   this.toggleBlade(car.mesh, true); break
    }
    this.cd = a.cooldown
    this.send("fire", { kind: a.kind, x: car.x, y: car.y, z: car.z, yaw: car.yaw })
  }

  get cooldownFraction() { const c = this.car?.spec.ability.cooldown; return c ? this.cd / c : 0 }

  // a missile: body, red nose, fins and a flame at the tail; it leaves a smoke trail while it flies
  shoot(x, y, z, f, own) {
    const mesh = new THREE.Group()
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 1.3, 10), shotMat); body.rotation.x = Math.PI / 2; mesh.add(body)
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.4, 10), noseMat); nose.rotation.x = -Math.PI / 2; nose.position.z = -0.85; mesh.add(nose)
    for (const [fx, fy] of [[0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]]) { const fin = new THREE.Mesh(new THREE.BoxGeometry(fx ? 0.45 : 0.04, fy ? 0.45 : 0.04, 0.3), finMat); fin.position.set(fx, fy, 0.5); mesh.add(fin) }
    flameMat ??= new THREE.SpriteMaterial({ map: softTexture(), color: 0xff9a2a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
    const flame = new THREE.Sprite(flameMat); flame.position.z = 0.95; flame.scale.setScalar(0.9); mesh.add(flame)
    mesh.position.set(x, y, z)
    mesh.lookAt(x + f.x, y, z + f.z)
    this.scene.add(mesh)
    this.shots.push({ mesh, flame, x, y, z, vx: f.x * MISSILE.speed, vy: 0, vz: f.z * MISSILE.speed, life: MISSILE.life, own, puff: 0 })
  }

  // every frame: shots fly in substeps no longer than STEP and burst on the first object or the ground
  projectiles(dt) {
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i]
      const n = Math.max(1, Math.ceil(Math.hypot(s.vx, s.vz) * dt / STEP)), h = dt / n
      let burst = false
      for (let k = 0; k < n && !burst; k++) {
        s.x += s.vx * h; s.z += s.vz * h
        const ground = this.heightAt(s.x, s.z)
        const hit = this.index.hitPoint(s.x, s.z, 0.5)
        if (s.y <= ground || (hit && s.y <= ground + (hit.obj.h ?? 3) + 0.5)) burst = true
      }
      if (burst) { this.explode(s.x, s.y, s.z, MISSILE.r, MISSILE.dmg, s.own); this.drop(i); continue }
      if ((s.life -= dt) <= 0) { this.drop(i); continue }
      s.mesh.position.set(s.x, s.y, s.z)
      s.flame.scale.setScalar(0.7 + 0.4 * Math.random())
      if ((s.puff += dt) > 0.05) {                                                             // the exhaust plume
        s.puff = 0
        const bx = s.x - s.vx / MISSILE.speed * 1.1, bz = s.z - s.vz / MISSILE.speed * 1.1
        this.effects.smoke.emit(bx, s.y, bz, (Math.random() - 0.5) * 2, 1.5 + Math.random(), (Math.random() - 0.5) * 2, 0.9, 0.5, 2.4, 0.55)
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
    const car = this.car
    if (!car || !shove) return
    const d = Math.hypot(car.x - x, car.z - z)
    if (d < 1.5 * r) {
      const k = (1 - d / (1.5 * r)) * Math.min(14, dmg / 10)
      car.kick((car.x - x) / (d || 1) * k, (car.z - z) / (d || 1) * k)
      if (k > 4 && car.vy === null) car.jump(Math.min(6, k * 0.5))
    }
  }

  // another player's trick, as seen from here
  remoteFire(msg, mesh) {
    const f = { x: -Math.sin(msg.yaw), z: -Math.cos(msg.yaw) }
    if (msg.kind === "missile") this.shoot(msg.x + f.x * 2.1 - f.z * 0.55, msg.y + 1.05, msg.z + f.z * 2.1 + f.x * 0.55, f, false)
    if (msg.kind === "blade" && mesh) this.toggleBlade(mesh, false)
  }

  // ---- the hit queue -----------------------------------------------------------------------------------------------

  queue(obj, dmg) {
    if (!this.enabled || dmg < 0.5 || obj.state === 2) return
    for (const key of obj.keys ?? [obj.key]) {
      const q = this.pending.get(key) ?? { damage: 0, max: obj.max }
      q.damage += dmg
      this.pending.set(key, q)
    }
  }

  // every 100 ms from game.js, next to the position update
  flush() {
    if (!this.pending.size) return
    const hits = [...this.pending].map(([key, h]) => ({ key, damage: Math.round(h.damage * 10) / 10, max: h.max }))
    this.pending.clear()
    for (let i = 0; i < hits.length; i += 32) this.send("hit", { hits: hits.slice(i, i + 32) })
  }

  reset() {
    this.pending.clear()
    while (this.shots.length) this.drop(this.shots.length - 1)
    this.cd = 0
  }
}
