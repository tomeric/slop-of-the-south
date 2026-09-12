import * as THREE from "three"
import { TUNING as T, expDamp } from "game/Tuning"
import { Suspension } from "game/Suspension"
import { makeVehicleMesh } from "game/Vehicles"

// The car, as a rigid body. yaw = 0 faces north (-z); positive yaw turns left.
//
// This module used to integrate the car itself — body-frame velocity, a grip coefficient, a yaw-rate target and a
// heuristic that guessed when a hill had thrown it into the air. It does none of that now. The chassis is a dynamic
// body in the same Rapier world the debris falls in, held up by one raycast per wheel (game/Physics.js), and what is
// left here is the driver: throttle becomes engine force, brake becomes brake torque, the handbrake drops the rear
// tyres' grip until the back steps out, and drag is a force like any other. Dive, squat, roll, a wheel dropping into
// a gutter and landing on your roof are all consequences now rather than effects.
//
// The frame is in two halves, either side of the solver. `command()` says what the driver wants; `physics.update()`
// steps the world; `sync()` reads the chassis back into the fields the rest of the game knows (x, y, z, yaw, speed)
// and poses the mesh. Anything that moves the car without driving it — a teleport, R, the border burn — has to go
// through `place()`, or the solver reads the jump as a velocity.
//
// What survives from the arcade model is the part that was a scoring system rather than physics: the drift charge
// levels, the mini-turbo payout and the nitro meter. Those read the real slip angle now, but the numbers are the
// ones that were tuned.
const _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, "YXZ"), _v = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0), _upWorld = new THREE.Vector3(0, 1, 0)

export class Vehicle {
  constructor(spawn, spec, physics) {
    this.physics = physics
    this.braking = false
    this.darkness = 0
    this.wheelWorld = []          // [{x, y, z}] ground contact of each wheel, filled by the suspension
    this.boostMeter = 0.5         // survives resets
    this.st = {}                  // what physics.read fills in: pose, velocity, wheels down
    this.quat = new THREE.Quaternion()   // the chassis pose, kept between the two halves of the frame
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
    this.mass = spec.mass ?? 1400
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
    this.place(spawn.x, spawn.y ?? 0, spawn.z, spawn.yaw)
    this.steer = 0
    this.drifting = false; this.driftDir = 0; this.driftMild = false; this.driftT = 0; this.chargeLevel = 0
    this.boosting = false; this.burstT = 0; this.boostPower = 0
    this.slip = 0; this.wheelAngle = 0
    this.landed = false; this.landImpact = 0
    this.wasDown = 1
    this.susp.reset()
  }

  // The one way to move the car without driving it. A dynamic body has to be told, or the solver reads a teleport as
  // several hundred metres per second and fires the neighbourhood into orbit.
  place(x, y, z, yaw) {
    this.x = x; this.y = y; this.z = z; this.yaw = yaw
    this.pitch = 0; this.roll = 0
    this.speed = 0; this.lateral = 0; this.vx = 0; this.vz = 0; this.vy = 0; this.yawRate = 0
    this.groundY = y
    this.quat?.setFromAxisAngle(_upWorld, yaw)
    this.physics?.warp(x, y, z, yaw)
    this.susp?.reset()
  }

  kick(x, z) { this.physics?.impulse(x * this.mass, 0, z * this.mass) }

  // an instantaneous vertical metre-per-second, as an impulse (the monster truck's trick, and a rocket's shove)
  jump(v) { this.physics?.impulse(0, this.mass * v, 0) }

  // Back on your wheels. Real physics means you can end up on your roof, in a ditch or wedged against a wall, so
  // every vehicle can right itself where it stands: the heading is kept, the pitch and roll go, and it is set down
  // a little above the ground with no velocity left to carry the mess on.
  rightUp() {
    this.place(this.x, (this.groundY ?? this.y) + T.physics.car.dropIn, this.z, this.yaw)
  }

  // roughly which way is up, for deciding whether righting is worth offering
  get upright() {
    return Math.cos(this.pitch ?? 0) * Math.cos(this.roll ?? 0) > 0.35
  }

  forward() { return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) } }

  get airborne() { return this.st.wheelsDown === 0 }

  // ---- half one: what the driver is asking for ---------------------------------------------------------------

  command(dt, input) {
    const P = this.physics
    if (!P?.ctrl) return
    const D = T.drift
    P.clearForces()                                          // last frame's drag, or it piles up
    // the same hysteresis the boost has, or an empty meter flickers: refill a frame, thrust a frame, forever
    this.wantThrust = this.spec.ability?.kind === "thrust" && !!input.thrust &&
      (this.thrusting ? this.boostMeter > 0 : this.boostMeter > T.boost.reengage)
    this.updateBoost(dt, input)
    const v = this.speed, av = Math.abs(v)

    // Engine. Today's arcade model was drag-limited rather than cap-limited: `0.35 v²/maxSpeed + 0.8 = accel` set
    // the top speed. Multiply both sides by the mass and the accelerations become forces without moving the answer,
    // so the same numbers give the same 110/99/43 km/h. The nose is local -z, which is the way the controller calls
    // backwards, hence the sign.
    const boost = 1 + T.boost.accelBonus * this.boostPower
    let engine = -input.throttle * this.mass * this.accel * boost
    let brake = 0
    if (input.brake) {
      if (v > 0.5) brake = this.mass * this.brakeForce            // brake first
      else engine = this.mass * this.accel * T.car.reverseFrac * 2  // then reverse
    }
    if (input.handbrake) brake = Math.max(brake, this.mass * (this.drifting ? D.handbrakeDecel : 12))
    // A real car in neutral rolls down a hill, which is true but reads as the handbrake being broken. Hands off the
    // controls below walking pace and it holds where it is.
    if (!input.throttle && !input.brake && av < T.car.holdBelow) brake = Math.max(brake, this.mass * T.car.hold)

    // Drag, as a force on the chassis: the quadratic term that sets the top speed plus constant rolling resistance.
    // Only while a wheel is down — in the air there is nothing to roll on.
    if (!this.airborne && av > 0.01) {
      const f = this.forward()
      const d = this.mass * (T.car.drag * av * av / this.maxSpeed + T.car.roll + (this.drifting ? D.slideDrag : 0)) * Math.sign(v)
      P.force(-f.x * d, 0, -f.z * d)
    }

    // Steering: the same lock curve, less at speed and more in a drift. Input +1 is left (A), which is +yaw, and
    // that is the way the controller counts too.
    const lock = this.maxSteer * (this.drifting ? D.steerLockBonus : 1) / (1 + av / 18)
    this.steer = expDamp(this.steer, input.steer * lock, T.car.steerRate, dt)

    // The handbrake is the drift: drop what the rear tyres can hold and the back steps out for real.
    const grip = (this.spec.grip ?? 1) * T.physics.car.frictionSlip
    const rear = input.handbrake && av > D.minSpeed ? grip * T.physics.car.handbrakeSlip : grip

    this.thrusters(dt, input)
    P.drive({ engine, brake, steer: this.steer, slip: grip, rearSlip: rear })

    const braking = (input.brake && v > 0.5) || (input.handbrake && av > 0.5)
    if (braking !== this.braking) { this.braking = braking; this.updateTail() }
  }

  // Four thrusters under the chassis rail, held down rather than fired. They push along the body's own up axis at
  // four separate mounting points, which is the whole character of the thing: level, they lift; tilted, they shove
  // you sideways and roll you further over, so a bad landing can be saved or made much worse.
  //
  // The force has to taper, or it is a rocket rather than a jump: flat thrust at 1.7 times its own weight leaves
  // 11 m/s² of net climb, and six seconds of that is most of a kilometre. Tapering with the *climb rate* to exactly
  // hover force is no better — hover means zero net acceleration, so it settles into a constant 12 m/s ascent and
  // was measured ninety metres up. What gives a jump is a spring to a height: full thrust on the ground, nothing
  // left by `height`, and a damping term against the climb so it arrives rather than bounces. Hands off and it
  // falls; hold it and it sits at about `height × (1 − 1/ratio)` off the deck for as long as the meter lasts.
  thrusters(dt, input) {
    const spec = this.spec
    this.thrusting = false
    if (!this.wantThrust) return
    const TH = T.physics.thrust, b = spec.body
    this.boostMeter = Math.max(0, this.boostMeter - dt * TH.drainScale / T.boost.drainTime)
    this.thrusting = true

    _up.set(0, 1, 0).applyQuaternion(this.quat)               // the body's own up, not the world's
    const hover = this.mass * Math.abs(T.physics.gravity)
    const high = Math.max(0, this.y - (this.groundY ?? this.y))
    const lift = TH.ratio * Math.max(0, 1 - high / TH.height)
    const damp = TH.damp * Math.max(0, (this.vy ?? 0)) / TH.vMax
    const F = hover * Math.max(0, lift - damp) / 4
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      _v.set(sx * b.hx * TH.spread, b.y - b.hy, b.z + sz * b.hz * TH.spread).applyQuaternion(this.quat)
      this.physics.forceAt(_up.x * F, _up.y * F, _up.z * F, this.x + _v.x, this.y + _v.y, this.z + _v.z)
    }
  }

  // ---- half two: where the solver put it --------------------------------------------------------------------

  sync(dt, heightAt) {
    const P = this.physics
    if (!P?.ctrl) return
    const st = P.read(this.st)
    this.x = st.x; this.y = st.y; this.z = st.z
    this.quat.set(st.qx, st.qy, st.qz, st.qw)
    _e.setFromQuaternion(this.quat)
    this.yaw = _e.y; this.pitch = _e.x; this.roll = _e.z
    this.yawRate = st.wy

    const f = this.forward(), rx = -f.z, rz = f.x
    this.vx = st.vx; this.vz = st.vz; this.vy = st.vy
    this.speed = st.vx * f.x + st.vz * f.z
    this.lateral = st.vx * rx + st.vz * rz
    this.slip = Math.atan2(this.lateral, Math.max(Math.abs(this.speed), 0.5))
    this.groundY = heightAt ? heightAt(this.x, this.z) : this.y

    // Landing. Airborne is simply no wheel touching anything, so a jump, a ramp off a collapsing wall and being
    // flipped by a rocket all come out the same way, and the impact is the vertical speed the solver actually had.
    const down = st.wheelsDown
    if (down > 0 && this.wasDown === 0) {
      this.landImpact = Math.max(0, -this.fellAt)
      this.landed = true
    }
    if (down === 0) this.fellAt = st.vy
    this.wasDown = down

    // On your roof in a ditch with nothing to push against, there is nothing you can do but wait — so after a few
    // seconds of being both wrong way up and going nowhere, it picks itself up without being asked. Q does it on
    // demand; this is for when you have not worked out that Q exists yet.
    const still = Math.hypot(st.vx, st.vz) < T.physics.car.stuckSpeed && Math.abs(st.vy) < T.physics.car.stuckSpeed
    this.stuckT = (!this.upright && still) ? (this.stuckT ?? 0) + dt : 0
    if (this.stuckT > T.physics.car.rightAfter) { this.stuckT = 0; this.righted = true; this.rightUp() }

    this.drift(dt)
    this.susp.update(this, this.quat, dt)
  }

  // The drift state machine and its mini-turbo, kept as it was tuned — but reading the slip angle the tyres are
  // really running at instead of a bookkept one.
  drift(dt) {
    const D = T.drift, v = this.speed, slip = Math.abs(this.slip)
    const fast = v > D.minSpeed
    if (!fast || this.airborne) {
      if (this.drifting) this.endDrift(false)
    } else if (!this.drifting) {
      if (slip > D.chargeSlip) this.startDrift(Math.sign(this.slip) || 1, slip < D.mildSlip)
    } else if (slip < D.chargeSlip * 0.6) {
      this.endDrift(!this.driftMild)                                   // hooked up again: pay out if it was a real one
    } else if (this.driftMild && slip > D.mildSlip) {
      this.driftMild = false; this.driftT = 0
    }
    if (this.drifting && !this.driftMild && slip > D.chargeSlip) {
      this.driftT += dt
      this.chargeLevel = D.chargeLevels.filter((t) => this.driftT >= t).length
    }
  }

  startDrift(dir, mild) { this.drifting = true; this.driftDir = dir || 1; this.driftMild = mild; this.driftT = 0; this.chargeLevel = 0 }

  // payout: a released drift converts its charge into a free burst and meter; a slow-down or a hit does not
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
    // the thrusters spend the same meter, so it must not trickle back up underneath them
    if (!this.boosting && !this.wantThrust) this.boostMeter = Math.min(1, this.boostMeter + h / B.refillTime)
    this.boostPower = expDamp(this.boostPower, this.boosting ? 1 : 0, B.powerSmooth, h)
  }

  get smoking() { return this.drifting && Math.abs(this.slip) > T.fx.smokeSlip }

  state() {
    return { x: this.x, y: this.y, z: this.z, yaw: this.yaw, pitch: this.pitch, roll: this.roll,
             speed: this.speed, brake: this.braking, drift: this.smoking, boost: this.boostPower > 0.3,
             thrust: !!this.thrusting, vehicle: this.spec.id }
  }
}
