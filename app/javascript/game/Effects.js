import * as THREE from "three"
import { TUNING as T } from "game/Tuning"

// Short-lived visuals: explosion flashes, flying debris, dust clouds and a camera shake, plus a fixed pool of sprites
// for continuous emitters (tyre smoke). Everything here is cosmetic and local; the world state comes from the server.
const MAX_LIVE = 40
const flashGeo = new THREE.SphereGeometry(1, 12, 8)
const debrisGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5)
const debrisMat = new THREE.MeshStandardMaterial({ color: 0x8a8078, roughness: 1 })
const confettiGeo = new THREE.PlaneGeometry(0.35, 0.25)
const CONFETTI = [0xe0241a, 0xf2c14e, 0x2a9d3a].map((color) => new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }))
let dustTex = null

export class Effects {
  constructor(scene) {
    this.scene = scene
    this.live = []
    this.shakeAmt = 0
    this.smoke = new SpritePool(scene, T.fx.smokePool, 0xd8d8d8)
  }

  // a flash growing to r, debris flying out of it, dust spreading on the ground
  explosion(x, y, z, r) {
    this.flash(x, y, z, r)
    this.debris(x, y, z, r * 0.6, 10)
    this.dust(x, y, z, r * 2)
  }

  // a building came down: debris over its footprint and a dust sheet the size of the house
  collapse(obj, ground) {
    const cx = (obj.minX + obj.maxX) / 2, cz = (obj.minZ + obj.maxZ) / 2
    const size = Math.max(obj.maxX - obj.minX, obj.maxZ - obj.minZ, 3)
    this.debris(cx, ground + (obj.h ?? 6) / 2, cz, size / 2, THREE.MathUtils.clamp(Math.round(size), 6, 24))
    this.dust(cx, ground, cz, size)
    this.shake(0.3)
  }

  flash(x, y, z, r) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffb040, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    const mesh = new THREE.Mesh(flashGeo, mat)
    mesh.position.set(x, y, z)
    this.add({ mesh, life: 0.35, t: 0, step: (e, k) => { e.mesh.scale.setScalar(r * (0.3 + 0.7 * k)); mat.opacity = 0.9 * (1 - k) } })
  }

  debris(x, y, z, r, n) {
    for (let i = 0; i < n; i++) {
      const mesh = new THREE.Mesh(debrisGeo, debrisMat)
      mesh.castShadow = mesh.receiveShadow = true
      mesh.position.set(x + (Math.random() - 0.5) * r, y, z + (Math.random() - 0.5) * r)
      mesh.scale.setScalar(0.6 + Math.random() * 1.2)
      const v = new THREE.Vector3((Math.random() - 0.5) * r * 1.5, 4 + Math.random() * r, (Math.random() - 0.5) * r * 1.5)
      const spin = new THREE.Vector3(Math.random(), Math.random(), Math.random()).multiplyScalar(6)
      this.add({ mesh, life: 1.4, t: 0, shared: true, step: (e, k, dt) => { v.y -= 20 * dt; e.mesh.position.addScaledVector(v, dt); e.mesh.rotation.x += spin.x * dt; e.mesh.rotation.z += spin.z * dt } })
    }
  }

  dust(x, y, z, r) {
    const mat = new THREE.SpriteMaterial({ map: dustTexture(), transparent: true, opacity: 0.7, depthWrite: false, color: 0xbfb6a8 })
    const mesh = new THREE.Sprite(mat)
    mesh.position.set(x, y + r * 0.25, z)
    this.add({ mesh, life: 1.3, t: 0, step: (e, k) => { e.mesh.scale.setScalar(r * (0.5 + k)); mat.opacity = 0.7 * (1 - k) } })
  }

  // the parade's finale, or its undoing: a burst of paper in the vastelaovend colours
  confetti(x, y, z) {
    const group = new THREE.Group(), bits = []
    for (let i = 0; i < 120; i++) {
      const m = new THREE.Mesh(confettiGeo, CONFETTI[i % CONFETTI.length])
      m.position.set(x, y, z)
      m.rotation.set(Math.random() * 3, Math.random() * 3, 0)
      const a = Math.random() * Math.PI * 2, r = 4 + Math.random() * 14
      bits.push({ m, v: new THREE.Vector3(Math.cos(a) * r, 9 + Math.random() * 12, Math.sin(a) * r), spin: 4 + Math.random() * 8 })
      group.add(m)
    }
    this.add({ mesh: group, life: 4, t: 0, shared: true, step: (e, k, dt) => {
      for (const b of bits) { b.v.y -= 9 * dt; b.v.multiplyScalar(1 - 1.2 * dt); b.m.position.addScaledVector(b.v, dt); b.m.rotation.x += b.spin * dt; b.m.rotation.y += b.spin * 0.7 * dt }
    } })
    this.shake(0.3)
  }

  shake(a) { this.shakeAmt = Math.max(this.shakeAmt, a) }

  add(e) {
    if (this.live.length >= MAX_LIVE) this.dispose(this.live.shift())
    this.scene.add(e.mesh)
    this.live.push(e)
  }

  dispose(e) {
    this.scene.remove(e.mesh)
    if (!e.shared) e.mesh.material.dispose()
  }

  // once per frame, after the camera has moved
  update(dt, camera) {
    this.smoke.update(dt)
    for (let i = this.live.length - 1; i >= 0; i--) {
      const e = this.live[i]
      e.t += dt
      if (e.t >= e.life) { this.dispose(e); this.live.splice(i, 1); continue }
      e.step(e, e.t / e.life, dt)
    }
    if (this.shakeAmt > 0.001) {
      camera.position.x += (Math.random() - 0.5) * this.shakeAmt
      camera.position.y += (Math.random() - 0.5) * this.shakeAmt
      this.shakeAmt *= Math.exp(-dt * 6)
    }
  }
}

// A fixed number of sprites that are reused round-robin: no allocation per puff, and no pressure on MAX_LIVE.
// Each sprite owns its material once (opacity is per material). emit() takes the oldest slot.
export class SpritePool {
  constructor(scene, n, color) {
    this.items = []
    this.next = 0
    this.color = color
    for (let i = 0; i < n; i++) {
      const mat = new THREE.SpriteMaterial({ map: dustTexture(), transparent: true, opacity: 0, depthWrite: false, color })
      const sprite = new THREE.Sprite(mat)
      sprite.visible = false
      scene.add(sprite)
      this.items.push({ sprite, mat, life: 0, t: 0, vx: 0, vy: 0, vz: 0, s0: 1, s1: 1, a0: 1 })
    }
  }

  emit(x, y, z, vx, vy, vz, life, s0, s1, a0, color = this.color) {
    const e = this.items[this.next]; this.next = (this.next + 1) % this.items.length
    e.sprite.position.set(x, y, z); e.sprite.visible = true
    e.mat.color.set(color)
    e.vx = vx; e.vy = vy; e.vz = vz; e.life = life; e.t = 0; e.s0 = s0; e.s1 = s1; e.a0 = a0
    e.sprite.scale.setScalar(s0); e.mat.opacity = a0
  }

  update(dt) {
    for (const e of this.items) {
      if (!e.sprite.visible) continue
      e.t += dt
      if (e.t >= e.life) { e.sprite.visible = false; continue }
      const k = e.t / e.life
      e.sprite.position.x += e.vx * dt; e.sprite.position.y += e.vy * dt; e.sprite.position.z += e.vz * dt
      e.sprite.scale.setScalar(e.s0 + (e.s1 - e.s0) * k)
      e.mat.opacity = e.a0 * (1 - k)
    }
  }
}

// soft radial blob, shared by dust, smoke and flames
export function softTexture() { return dustTexture() }

function dustTexture() {
  if (dustTex) return dustTex
  const c = document.createElement("canvas"); c.width = c.height = 128
  const ctx = c.getContext("2d")
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  g.addColorStop(0, "rgba(255,255,255,0.9)"); g.addColorStop(0.5, "rgba(255,255,255,0.35)"); g.addColorStop(1, "rgba(255,255,255,0)")
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128)
  dustTex = new THREE.CanvasTexture(c)
  return dustTex
}
