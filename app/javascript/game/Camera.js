import * as THREE from "three"
import { TUNING as T, smoothDamp, smoothDampAngle, lerpAngle, expDamp, smoothstep } from "game/Tuning"

// Chase camera. Sits behind a direction blended between the car's nose and its velocity (so in a drift the nose swings
// across the frame while the camera keeps looking down the road), at a distance and height that grow with speed and
// boost, with the field of view widening as well. Position, look target and yaw are each critically damped springs,
// so nothing snaps and nothing overshoots; the look target is damped faster than the position so the car stays framed.
// Heights are relative to the ground under the car, and the camera never sinks below the terrain.
export class ChaseCamera {
  constructor(camera, heightAt = null) {
    this.camera = camera
    this.heightAt = heightAt
    this.pos = new THREE.Vector3(); this.posVel = [0, 0, 0]
    this.look = new THREE.Vector3(); this.lookVel = [0, 0, 0]
    this.yaw = 0; this.yawVel = [0]
    this.fov = T.camera.fov
    this.snapped = false
  }

  // desired camera yaw: behind the nose at rest, behind the velocity at speed (more so in a drift), behind the nose in reverse
  targetYaw(car) {
    const C = T.camera
    const speed = Math.hypot(car.vx ?? 0, car.vz ?? 0)
    if (speed < 0.5 || car.speed < -1) return car.yaw
    const velYaw = Math.atan2(-car.vx, -car.vz)
    const w = (car.drifting ? C.velBlendDrift : C.velBlend) * smoothstep(C.velBlendMinSpeed, C.velBlendFullSpeed, speed)
    return lerpAngle(car.yaw, velYaw, w)
  }

  place(car, yaw, out, look) {
    const C = T.camera
    const s = Math.min(1, Math.hypot(car.vx ?? 0, car.vz ?? 0) / car.maxSpeed), boost = car.boostPower ?? 0
    const cam = car.spec?.cam ?? { dist: 1, height: 1 }                                       // bigger vehicles push the camera back and up
    const dist = (C.dist + C.distPerSpeed * s + C.distBoost * boost) * cam.dist, height = (C.height + C.heightPerSpeed * s) * cam.height
    const cy = car.y                                                                             // the body's own height: it follows the car up when it flies
    out.set(car.x + Math.sin(yaw) * dist, cy + height, car.z + Math.cos(yaw) * dist)             // behind = opposite of forward (-sin, -cos)
    const f = car.forward()
    look.set(car.x + f.x * C.lookAhead, cy + C.lookHeight, car.z + f.z * C.lookAhead)
    return C.fov + C.fovPerSpeed * s + C.fovBoost * boost
  }

  // jump straight into place (spawn, teleport)
  snap(car) {
    this.yaw = this.targetYaw(car); this.yawVel[0] = 0
    const fov = this.place(car, this.yaw, this.pos, this.look)
    this.posVel.fill(0); this.lookVel.fill(0)
    this.fov = Math.min(T.camera.fovMax, fov)
    this.snapped = true
    this.apply()
  }

  update(car, dt) {
    if (!this.snapped) return this.snap(car)
    const C = T.camera
    this.yaw = smoothDampAngle(this.yaw, this.targetYaw(car), this.yawVel, 0, C.yawSmooth, dt)
    const fov = this.place(car, this.yaw, _target, _lookTarget)
    this.pos.x = smoothDamp(this.pos.x, _target.x, this.posVel, 0, C.posSmooth, dt)
    this.pos.y = smoothDamp(this.pos.y, _target.y, this.posVel, 1, C.posSmooth, dt)
    this.pos.z = smoothDamp(this.pos.z, _target.z, this.posVel, 2, C.posSmooth, dt)
    if (this.heightAt) {
      const minY = this.heightAt(this.pos.x, this.pos.z) + C.groundClearance
      if (this.pos.y < minY) { this.pos.y = minY; this.posVel[1] = Math.max(0, this.posVel[1]) }
    }
    this.look.x = smoothDamp(this.look.x, _lookTarget.x, this.lookVel, 0, C.lookSmooth, dt)
    this.look.y = smoothDamp(this.look.y, _lookTarget.y, this.lookVel, 1, C.lookSmooth, dt)
    this.look.z = smoothDamp(this.look.z, _lookTarget.z, this.lookVel, 2, C.lookSmooth, dt)
    this.fov = expDamp(this.fov, Math.min(C.fovMax, fov), 1 / C.fovSmooth, dt)
    this.apply()
  }

  apply() {
    this.camera.position.copy(this.pos)
    this.camera.lookAt(this.look)
    if (Math.abs(this.camera.fov - this.fov) > 0.01) { this.camera.fov = this.fov; this.camera.updateProjectionMatrix() }
  }
}

const _target = new THREE.Vector3(), _lookTarget = new THREE.Vector3()
