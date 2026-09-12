import * as THREE from "three"
import { TUNING as T } from "game/Tuning"

// Where the car is drawn. This used to be a simulation: four samples of the ground, a spring-damper for heave and
// two more for pitch and roll, with dive and squat faked from the car's own acceleration. All of that is real now —
// the chassis is a rigid body and each wheel is a raycast with a spring on it (game/Physics.js) — so this module
// only reads it back. The body takes the chassis pose exactly; each wheel pivot sits at the length its own spring
// has been compressed to, and spins at the rate its own radius says, which is also the end of the old bug where
// every wheel span at 0.33 m and the monster truck's metre-high tyres turned nearly three times too fast.
const _m = new THREE.Matrix4(), _v = new THREE.Vector3()

export class Suspension {
  constructor(mesh) {
    this.mesh = mesh
    this.wheels = mesh.userData.wheels ?? []
    this.reset()
  }

  reset() { this.spin = this.wheels.map(() => 0) }

  update(car, quat, dt) {
    const ctrl = car.physics?.ctrl
    this.mesh.position.set(car.x, car.y, car.z)
    this.mesh.quaternion.copy(quat)
    if (!ctrl) return
    this.mesh.updateMatrixWorld()
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]
      const r = w.r ?? T.susp.wheelRadius
      // the spring's current length puts the hub where the ray says the ground is; clamped, because a wheel over a
      // cliff edge reports the whole ray and would stretch the model out of its arches
      const len = ctrl.wheelSuspensionLength(i)
      const drop = Math.max(-T.susp.travel, Math.min(T.susp.travel, T.physics.car.rest - len))
      w.pivot.position.y = r + drop
      w.pivot.rotation.y = w.front ? (car.steer ?? 0) : 0
      this.spin[i] += (car.speed / r) * dt                       // its own radius, not one shared number
      w.mesh.rotation.x = -this.spin[i]
      if (car.wheelWorld) {
        w.pivot.getWorldPosition(_v)
        car.wheelWorld[i] = { x: _v.x, y: _v.y - r, z: _v.z }
      }
    }
    car.wheelAngle = this.spin[0] ?? 0
  }
}
