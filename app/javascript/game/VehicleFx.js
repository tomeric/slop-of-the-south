import * as THREE from "three"
import { TUNING as T, expDamp } from "game/Tuning"

// Per-car cosmetics: tyre smoke from the rear wheels while sliding and exhaust flames while boosting. Driven by a
// small duck-typed state so it serves the player's car (live values) and remote cars (flags from the network alike):
//   { smoking: bool, boostPower: 0..1, vx, vz, thrusting: bool }
export class VehicleFx {
  constructor(mesh, smokePool) {
    this.mesh = mesh
    this.pool = smokePool
    this.flames = mesh.userData.flames ?? []
    this.rear = (mesh.userData.wheels ?? []).filter((w) => !w.front)
    this.acc = 0
    this.power = 0
    this.jetAcc = 0
    this.jets = mesh.userData.jets ?? []
  }

  update(state, dt) {
    const F = T.fx
    // The monster truck's thrusters: a flame at each nozzle and a plume behind it, the same pair the trike's rockets
    // wear. The nozzles are children of the mesh, so their world positions come off the matrix once a frame.
    const lit = !!state.thrusting
    for (const s of this.jets) {
      s.visible = lit
      if (lit) s.scale.setScalar(0.9 + 0.5 * Math.random())
    }
    if (lit && this.pool && this.jets.length) {
      this.mesh.updateMatrixWorld()
      this.jetAcc += F.smokeRate * 1.4 * dt
      while (this.jetAcc >= 1) {
        this.jetAcc -= 1
        for (const s of this.jets) {
          s.getWorldPosition(_p)
          this.pool.emit(_p.x + (Math.random() - 0.5) * 0.3, _p.y - 0.2, _p.z + (Math.random() - 0.5) * 0.3,
            (Math.random() - 0.5) * 2, -5 - Math.random() * 4, (Math.random() - 0.5) * 2,
            0.55, 0.45, 2.6, 0.7)
        }
      }
    } else this.jetAcc = 0
    // smoke: a steady stream of puffs from each rear wheel, carried along a little with the car and rising
    if (state.smoking && this.pool) {
      this.acc += F.smokeRate * dt
      if (this.acc >= 1) this.mesh.updateMatrixWorld()
      while (this.acc >= 1) {
        this.acc -= 1
        for (const w of this.rear) {
          w.pivot.getWorldPosition(_p)
          const jx = (Math.random() - 0.5) * 0.6, jz = (Math.random() - 0.5) * 0.6
          this.pool.emit(_p.x + jx, _p.y - (w.r ?? T.susp.wheelRadius) + 0.15, _p.z + jz,
            (state.vx ?? 0) * 0.3 + jx, 0.7 + Math.random() * 0.5, (state.vz ?? 0) * 0.3 + jz,
            F.smokeLife, 0.5, 1.8, 0.4)
        }
      }
    } else this.acc = 0
    // flames: scale with the (smoothed) boost power and flicker
    this.power = expDamp(this.power, state.boostPower ?? 0, T.boost.powerSmooth, dt)
    const on = this.power > 0.05
    for (const s of this.flames) {
      s.visible = on
      if (on) s.scale.setScalar(this.power * (0.55 + F.flameFlicker * Math.random()))
    }
  }
}

const _p = new THREE.Vector3()
