import * as THREE from "three"
import { makeVehicleMesh } from "game/Vehicles"
import { makeBeacon, placeBeacon, disposeBeacon } from "game/Beacon"
import { VehicleFx } from "game/VehicleFx"
import { TUNING as T, lerpAngle, wrapAngle } from "game/Tuning"

const DELAY_MS = 120         // render slightly in the past so we can interpolate
const TIMEOUT_MS = 6000

// Keeps a short buffer of positions per remote player and interpolates between them. Every other player carries a
// sky beacon (Beacon.js) with their name and distance. Their wheels spin and steer from the interpolated motion, and
// the drift/boost flags in the move messages light their tyre smoke and exhaust flames. The mesh follows the vehicle
// named in the move messages and is swapped when the player picks another.
export class RemoteCars {
  constructor(scene, smokePool = null) {
    this.scene = scene
    this.pool = smokePool
    this.cars = new Map()    // id → { mesh, color, buf: [{t, x, y, z, yaw, speed}], lastSeen, brake, drift, boost, name, beacon, fx, wheelAngle }
    this.darkness = 0
    this.lastT = performance.now()
  }

  get count() { return this.cars.size }

  // darkness 0..1 (DayNight): headlights and tail lights of everyone else
  setNight(darkness) {
    this.darkness = darkness
    for (const car of this.cars.values()) this.relight(car)
  }

  relight(car) {
    car.mesh.userData.lights.head.emissiveIntensity = 0.35 + 2.2 * this.darkness
    car.mesh.userData.lights.tail.emissiveIntensity = car.brake ? 1.9 : 0.12 + 0.7 * this.darkness
  }

  receive(msg) {
    if (msg.type === "leave") return this.remove(msg.id)
    if (msg.type !== "move") return
    let car = this.cars.get(msg.id)
    const vehicle = msg.vehicle || "auto"
    if (!car) {
      const color = colorFor(msg.id)
      car = { mesh: null, vehicle: null, color, buf: [], lastSeen: 0, brake: false, drift: false, boost: false, name: "", beacon: makeBeacon(this.scene, color), fx: null, wheelAngle: 0 }
      this.cars.set(msg.id, car)
    }
    if (car.vehicle !== vehicle) {
      if (car.mesh) this.scene.remove(car.mesh)
      car.vehicle = vehicle
      car.mesh = makeVehicleMesh(vehicle, car.color)
      car.fx = new VehicleFx(car.mesh, this.pool)
      this.scene.add(car.mesh)
      this.relight(car)
    }
    car.name = msg.name || "Chauffeur"
    if (!!msg.brake !== car.brake) { car.brake = !!msg.brake; this.relight(car) }
    car.drift = !!msg.drift; car.boost = !!msg.boost; car.thrust = !!msg.thrust
    car.lastSeen = performance.now()
    car.buf.push({ t: performance.now(), x: msg.x, y: msg.y, z: msg.z, yaw: msg.yaw,
                   pitch: msg.pitch ?? 0, roll: msg.roll ?? 0, speed: msg.speed ?? 0 })
    if (car.buf.length > 20) car.buf.shift()
  }

  // local: the player's own car (for the distance); camera: to keep the labels a constant size on screen
  update(local, camera) {
    const now = performance.now(), renderT = now - DELAY_MS
    const dt = Math.min(0.05, (now - this.lastT) / 1000); this.lastT = now
    for (const [id, car] of this.cars) {
      if (now - car.lastSeen > TIMEOUT_MS) { this.remove(id); continue }
      const b = car.buf
      if (!b.length) continue
      let i = b.length - 1
      while (i > 0 && b[i - 1].t > renderT) i--
      const a = b[Math.max(i - 1, 0)], c = b[i]
      const k = c.t === a.t ? 1 : THREE.MathUtils.clamp((renderT - a.t) / (c.t - a.t), 0, 1)
      const x = a.x + (c.x - a.x) * k, y = a.y + (c.y - a.y) * k, z = a.z + (c.z - a.z) * k
      const yaw = lerpAngle(a.yaw, c.yaw, k), speed = a.speed + (c.speed - a.speed) * k
      // a real chassis rolls over, so the attitude travels with the position or everyone else drives about flat
      const pitch = lerpAngle(a.pitch ?? 0, c.pitch ?? 0, k), roll = lerpAngle(a.roll ?? 0, c.roll ?? 0, k)
      car.mesh.position.set(x, y, z)
      car.mesh.rotation.set(pitch, yaw, roll, "YXZ")
      // wheels: spin with the reported speed, front wheels turned by the yaw rate between the two samples
      car.wheelAngle += speed / T.susp.wheelRadius * dt
      const yawRate = c.t === a.t ? 0 : wrapAngle(c.yaw - a.yaw) / ((c.t - a.t) / 1000)
      const steer = Math.abs(speed) > 1 ? THREE.MathUtils.clamp(Math.atan(yawRate * 2.6 / speed), -0.6, 0.6) : 0
      for (const w of car.mesh.userData.wheels ?? []) { w.mesh.rotation.x = -car.wheelAngle; w.pivot.rotation.y = w.front ? steer : 0 }
      const f = { x: -Math.sin(yaw), z: -Math.cos(yaw) }
      car.fx.update({ smoking: car.drift, boostPower: car.boost ? 1 : 0, vx: f.x * speed, vz: f.z * speed, thrusting: car.thrust }, dt)
      if (local && camera) placeBeacon(car.beacon, x, y, z, car.name, local, camera)
    }
  }

  get(id) { return this.cars.get(id) }

  remove(id) {
    const car = this.cars.get(id)
    if (!car) return
    this.scene.remove(car.mesh)
    disposeBeacon(car.beacon)
    this.cars.delete(id)
  }
}

function colorFor(id) {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return new THREE.Color().setHSL((h % 360) / 360, 0.65, 0.5).getHex()
}
