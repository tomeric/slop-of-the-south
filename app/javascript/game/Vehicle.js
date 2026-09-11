import * as THREE from "three"
import { TUNING as T, expDamp } from "game/Tuning"
import { Suspension } from "game/Suspension"
import { makeVehicleMesh } from "game/Vehicles"

// Arcade car. yaw = 0 faces north (-z); positive yaw turns left. Velocity lives in the body frame: `speed` along the
// heading (the signed scalar Combat reads and writes) and `lateral` along the right-hand vector. Each step the nose
// turns, the world velocity is re-projected onto the new heading — which turns some forward speed into sideways
// speed — and grip bleeds the sideways part away. At full grip that is the old bicycle model; in a drift (handbrake
// while turning at speed, or a hard turn at high speed) the rear grip drops, the car slides at an angle and keeps
// rotating on its own; counter-steer trims the angle. Releasing a charged drift pays out a mini-turbo. Shift burns
// the nitro meter; road pads refill it. The frame runs integrate() (input → speed, heading, position), lets Combat
// push the car out of whatever it hit, then settle() (suspension: terrain contact and body attitude). The vehicle
// spec (Vehicles.js) sets the size, the physics constants and the mesh; setSpec swaps all of it in place.
// The car can leave the ground, arcade style: fast over a crest (it was climbing, now the ground descends) or off a
// ledge, it launches with the recent climb rate scaled up plus a pop that grows with speed; the monster truck jumps
// on command. In the air it keeps its velocity, throttle and steering do next to nothing, the nose follows the arc,
// and the landing compresses the suspension.
const SUBSTEP = 1 / 120
const GRAVITY = 10                   // m/s²: a touch lighter than Earth, for hang time
const JUMP = { minSpeed: 10, climb: 0.8, ledge: 0.3, gain: 1.8, pop: 0.08 }   // m/s of climb a crest needs, m of step, ×climb, ×speed

export class Vehicle {
  constructor(spawn, spec) {
    this.braking = false
    this.darkness = 0
    this.wheelWorld = []          // [{x, y, z}] ground contact of each wheel, filled by the suspension
    this.boostMeter = 0.5         // survives resets
    // two spotlights for the player's own car light up the road ahead at night
    this.spots = [-0.6, 0.6].map((x) => {
      const spot = new THREE.SpotLight(0xfff3d6, 0, 65, 0.5, 0.65, 1.7)
      spot.target.position.set(x * 0.7, -0.6, -24)
      return spot
    })
    this.setSpec(spec)
    this.reset(spawn)
  }

  // a new vehicle: returns the old mesh so the caller can take it out of the scene
  setSpec(spec) {
    const old = this.mesh
    this.spec = spec
    this.wheelbase = spec.wheelbase ?? 2.6
    this.track = spec.track ?? 1.6
    this.maxSpeed = spec.maxSpeed ?? T.car.maxSpeed
    this.accel = spec.accel ?? T.car.accel
    this.brakeForce = spec.brakeForce ?? T.car.brakeForce
    this.maxSteer = spec.maxSteer ?? T.car.maxSteer
    this.mesh = makeVehicleMesh(spec.id)
    this.lights = this.mesh.userData.lights
    this.susp = new Suspension(this.mesh)
    for (const spot of this.spots) { spot.position.set(spot.target.position.x / 0.7, 0.7, -spec.length / 2 + 0.1); this.mesh.add(spot, spot.target) }
    if (old) { this.speed = 0; this.lateral = 0; this.vx = 0; this.vz = 0; this.mesh.position.copy(old.position); this.mesh.rotation.copy(old.rotation) }
    this.setNight(this.darkness)
    return old
  }

  // darkness 0..1 (DayNight): headlights on in the dark, dim running lights by day
  setNight(darkness) {
    this.darkness = darkness
    // by day the spotlights are switched off entirely: an active light at intensity 0 still costs every lit material two
    // spot-light evaluations per fragment (the shaders recompile once at dusk and dawn)
    for (const spot of this.spots) { spot.intensity = 140 * darkness * darkness; spot.visible = darkness > 0.02 }
    this.lights.head.emissiveIntensity = 0.35 + 2.2 * darkness
    this.updateTail()
  }

  updateTail() { this.lights.tail.emissiveIntensity = this.braking ? 1.9 : 0.12 + 0.7 * this.darkness }

  reset(spawn) {
    this.x = spawn.x; this.z = spawn.z; this.y = 0
    this.yaw = spawn.yaw; this.speed = 0; this.steer = 0
    this.lateral = 0; this.vx = 0; this.vz = 0; this.yawRate = 0
    this.grip = 1; this.slip = 0
    this.drifting = false; this.driftDir = 0; this.driftMild = false; this.driftT = 0; this.chargeLevel = 0
    this.boosting = false; this.burstT = 0; this.boostPower = 0
    this.accLong = 0; this.accLat = 0; this.wheelAngle = 0
    this.vy = null; this.airY = 0; this.landed = false                 // airborne: vertical speed and height, null on the ground
    this.groundVy = 0; this.climbMax = 0; this.landImpact = 0           // how fast the ground rises under the car (smoothed), its recent peak, the last landing's speed
    this.kickX = 0; this.kickZ = 0                                      // knockback, world m/s, dies away in a second
    this._dt = 1 / 60; this._speedOut = 0
    this.susp.reset()
  }

  // leave the ground with vertical speed v (the monster truck's trick, and the hop an explosion gives)
  jump(v) { if (this.vy === null) { this.vy = v; this.airY = this.y } }

  kick(x, z) { this.kickX += x; this.kickZ += z }

  forward() { return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) } }

  update(dt, input, heightAt) { this.integrate(dt, input); this.settle(heightAt) }

  // fixed 120 Hz substeps so the slide model behaves the same at 30 and 144 fps; the car ends exactly dt ahead
  integrate(dt, input) {
    this._dt = dt
    if (this.speed !== this._speedOut) this.lateral *= 0.3          // Combat bounced or slowed us: kill most of the slide
    const n = Math.max(1, Math.ceil(dt / SUBSTEP)), h = dt / n, v0 = this.speed
    for (let i = 0; i < n; i++) this.step(h, input)
    this.x += this.kickX * dt; this.z += this.kickZ * dt
    const fade = Math.exp(-dt * 2.3)
    this.kickX *= fade; this.kickZ *= fade
    if (this.vy !== null) { this.vy -= GRAVITY * dt; this.airY += this.vy * dt }
    this.accLong = expDamp(this.accLong, (this.speed - v0) / dt, T.susp.accelSmooth, dt)
    this.accLat = expDamp(this.accLat, -this.speed * this.yawRate, T.susp.accelSmooth, dt)   // +right
    this._speedOut = this.speed
    const braking = (input.brake && this.speed > 0.5) || (input.handbrake && Math.abs(this.speed) > 0.5)
    if (braking !== this.braking) { this.braking = braking; this.updateTail() }
  }

  step(h, input) {
    const D = T.drift
    let f = this.forward(), rx = -f.z, rz = f.x
    const wx = f.x * this.speed + rx * this.lateral, wz = f.z * this.speed + rz * this.lateral   // world velocity

    this.updateBoost(h, input)
    const cap = this.maxSpeed * (1 + T.boost.speedBonus * this.boostPower)
    const accel = this.accel * (1 + T.boost.accelBonus * this.boostPower)

    // longitudinal
    let v = this.speed
    const drag = 0.35 * v * Math.abs(v) / this.maxSpeed + 0.8 * Math.sign(v)
    let a = input.throttle * accel - drag
    if (input.brake) a -= v > 0.5 ? this.brakeForce : this.accel * 0.6            // brake, then reverse
    if (input.handbrake) a -= (this.drifting ? D.handbrakeDecel : 12) * Math.sign(v)
    if (this.drifting) a -= D.slideDrag * Math.sign(v)
    if (this.vy !== null) a = -0.1 * drag                                            // wheels in the air: nothing to push against
    v += a * h
    if (v > cap) v = expDamp(v, cap, T.boost.overspeedBleed, h)
    v = Math.max(v, -this.maxSpeed * T.car.reverseFrac)
    if (Math.abs(v) < 0.05 && !input.throttle && !input.brake) v = 0

    // steering: less lock at speed, more in a drift, smoothed; the tyres can only supply maxLatAccel of cornering
    const lock = this.maxSteer * (this.drifting ? D.steerLockBonus : 1) / (1 + Math.abs(v) / 18) * (this.vy !== null ? 0.15 : 1)
    this.steer = expDamp(this.steer, input.steer * lock, T.car.steerRate, h)
    const kinFree = (v / this.wheelbase) * Math.tan(this.steer)                      // what the front wheels ask for
    const maxYaw = D.maxLatAccel / Math.max(Math.abs(v), 1)
    const kinYawRate = clamp(kinFree, -maxYaw, maxYaw)

    // drift state machine
    const fast = v > D.minSpeed, steering = input.steer !== 0
    const latDemand = Math.abs(v * kinFree)                                          // centripetal accel the tyres must supply
    if (!this.drifting) {
      if (fast && input.handbrake && steering) this.startDrift(Math.sign(input.steer), false)
      else if (v > D.naturalDrift.minSpeed && latDemand > D.naturalDrift.latAccel) this.startDrift(Math.sign(this.steer) || 1, true)
    } else if (!fast) this.endDrift(false)
    else if (!this.driftMild && !input.handbrake) this.endDrift(true)                // release → mini-turbo
    else if (this.driftMild && input.handbrake && steering) { this.driftMild = false; this.driftDir = Math.sign(input.steer); this.driftT = 0 }
    else if (this.driftMild && latDemand < D.naturalDrift.latAccel * 0.6) this.endDrift(false)

    const gripTarget = this.drifting ? (this.driftMild ? D.gripMild : D.gripDrift) : D.gripNormal
    this.grip = expDamp(this.grip, gripTarget, gripTarget < this.grip ? D.gripInRate : D.gripOutRate, h)

    // yaw: kinematic when gripping; in a drift the steer counts more and the car keeps rotating on its own, so
    // steering into the slide grows the angle and counter-steering shrinks it
    let yawTarget = kinYawRate
    if (this.drifting && !this.driftMild) yawTarget = clamp(kinFree * D.yawGain, -D.driftMaxYaw, D.driftMaxYaw) + this.driftDir * D.yawSustain * Math.min(1, v / 20)
    this.yawRate = expDamp(this.yawRate, yawTarget, this.drifting ? D.yawRateSmooth.drift : D.yawRateSmooth.grip, h)
    this.yaw += this.yawRate * h

    // re-project the world velocity onto the new heading; grip bleeds the sideways part away, and most of what it
    // bleeds is redirected forward (arcade: turning costs little speed, sliding costs some)
    f = this.forward(); rx = -f.z; rz = f.x
    const mag = Math.hypot(wx, wz)
    let vLong = wx * f.x + wz * f.z, vLat = wx * rx + wz * rz
    this.slip = Math.atan2(vLat, Math.max(Math.abs(vLong), 0.5))
    let damp = D.latDampMax * this.grip
    if (Math.abs(this.slip) > D.maxSlip) damp += 6                                   // spin-out guard
    vLat *= Math.max(0, 1 - damp * h)
    if (Math.abs(vLat) < 0.02) vLat = 0
    const lost = mag - Math.hypot(vLong, vLat)
    if (lost > 0) vLong += Math.sign(vLong || v || 1) * lost * (this.drifting ? D.redirect.drift : D.redirect.grip)
    vLong += v - this.speed                                                          // this step's longitudinal acceleration

    this.speed = vLong; this.lateral = vLat
    this.vx = f.x * vLong + rx * vLat; this.vz = f.z * vLong + rz * vLat
    this.x += this.vx * h; this.z += this.vz * h

    if (this.drifting && !this.driftMild && Math.abs(this.slip) > D.chargeSlip) {
      this.driftT += h
      this.chargeLevel = D.chargeLevels.filter((t) => this.driftT >= t).length
    }
    this.wheelAngle += (vLong / T.susp.wheelRadius) * h
  }

  startDrift(dir, mild) { this.drifting = true; this.driftDir = dir || 1; this.driftMild = mild; this.driftT = 0; this.chargeLevel = 0 }

  // payout: a released handbrake drift converts its charge into a free burst and meter; a slow-down or a hit does not
  endDrift(payout) {
    if (payout && this.chargeLevel > 0) this.addBoost(this.chargeLevel * T.boost.meterPerLevel, T.boost.burst[this.chargeLevel])
    this.drifting = false; this.driftMild = false; this.driftT = 0; this.chargeLevel = 0
  }

  addBoost(fill, burst = 0) { this.boostMeter = Math.min(1, this.boostMeter + fill); this.burstT = Math.max(this.burstT, burst) }

  // Shift drains the meter (with hysteresis so an empty meter does not flicker); bursts are free; refill when idle
  updateBoost(h, input) {
    const B = T.boost
    const wantHold = !!input.boost && (this.boosting ? this.boostMeter > 0 : this.boostMeter > B.reengage)
    if (wantHold) this.boostMeter = Math.max(0, this.boostMeter - h / B.drainTime)
    if (this.burstT > 0) this.burstT -= h
    this.boosting = wantHold || this.burstT > 0
    if (!this.boosting) this.boostMeter = Math.min(1, this.boostMeter + h / B.refillTime)
    this.boostPower = expDamp(this.boostPower, this.boosting ? 1 : 0, B.powerSmooth, h)
  }

  // Terrain contact and body attitude via the suspension; car.y stays the ground height under the centre. A grounded
  // car launches when the ground drops away below the arc its vertical speed would carry it on; an airborne car
  // floats its mesh above the ground, nose along the arc, until it comes back down onto the springs.
  settle(heightAt) {
    const dt = this._dt, prevY = this.y
    this.susp.update(this, heightAt, dt)
    if (this.vy === null) {
      const inst = (this.y - prevY) / dt, hspeed = Math.hypot(this.vx, this.vz), step = prevY - this.y
      const crest = inst < -0.2 && this.climbMax > JUMP.climb
      if (step < 5 && hspeed > JUMP.minSpeed && (crest || step > JUMP.ledge)) {
        this.vy = (crest ? this.climbMax : 0) * JUMP.gain + JUMP.pop * hspeed
        this.airY = prevY
        this.climbMax = 0
      } else {
        this.groundVy = expDamp(this.groundVy, inst, 8, dt)                          // a curb is one frame of spike: it barely registers
        if (inst > 0.05) this.climbMax = Math.max(this.climbMax, Math.min(this.groundVy, 5))   // the steepest part of the hill decides the jump
        else this.climbMax *= 1 - 1.5 * dt                                             // and fades on a plateau
      }
      return
    }
    if (this.airY <= this.y && this.vy < 0) {
      this.landImpact = -this.vy; this.vy = null; this.landed = true; this.groundVy = this.climbMax = 0
      this.susp.hv = Math.min(this.susp.hv, -this.landImpact * 0.6)                   // the springs take the hit
      return
    }
    this.mesh.position.y += this.airY - this.y
    this.mesh.rotation.x = Math.atan2(this.vy, Math.max(4, Math.hypot(this.vx, this.vz))) * 0.9
  }

  get smoking() { return this.drifting && Math.abs(this.slip) > T.fx.smokeSlip }

  state() {
    return { x: this.x, y: this.vy === null ? this.y : this.airY, z: this.z, yaw: this.yaw, speed: this.speed, brake: this.braking, drift: this.smoking, boost: this.boostPower > 0.3, vehicle: this.spec.id }
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }
