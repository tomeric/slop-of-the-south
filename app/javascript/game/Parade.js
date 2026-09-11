import * as THREE from "three"
import { makeBeacon, placeBeacon, showBeacon } from "game/Beacon"
import { casts } from "game/Shadows"

// The vastelaovend parade: one praalwagen rolling in a straight line across the town. Its position is a pure
// function of the server clock (Round.floatAt), so every client sees the same float without any messages. A red
// ribbon on the ground marks the whole route, a beacon in the sky marks the float.
const RIBBON_STEP = 10, RIBBON_HW = 1.5, RIBBON_LIFT = 0.3
const ribbonMat = new THREE.MeshBasicMaterial({ color: 0xe0241a, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4 })
ribbonMat.__shared = true

export class Parade {
  constructor(scene) {
    this.scene = scene
    this.mesh = casts(makeFloatMesh())
    this.beacon = makeBeacon(scene, 0xe0241a)
    this.ribbon = new THREE.Mesh(new THREE.BufferGeometry(), ribbonMat)
    this.ribbon.frustumCulled = false
    scene.add(this.mesh, this.ribbon)
    this.state = null
    this.y = 0
    this.ribbonTimer = 1
    this.show(false)
  }

  // state: the Round instance; the float waits at the start during the intermission and is gone once the round is over
  setRound(state) {
    this.state = state
    const r = state.round
    if (r && r.id !== this.roundId) { this.roundId = r.id; this.buildRibbon(r.path); this.ribbonTimer = 1 }
    this.show(!!r && r.status !== "ended")
  }

  show(visible) {
    this.mesh.visible = this.ribbon.visible = visible
    showBeacon(this.beacon, visible)
  }

  hide() { this.show(false) }

  get x() { return this.mesh.position.x }
  get z() { return this.mesh.position.z }

  update(now, dt, chunks, local, camera) {
    if (!this.mesh.visible) return
    const [x, z] = this.state.floatAt(now)
    if (chunks.ready(x, z)) this.y += (chunks.heightAt(x, z) - this.y) * Math.min(1, dt * 8)   // onto the ground once its tile is in
    this.mesh.position.set(x, this.y, z)
    this.mesh.rotation.y = this.state.heading
    const t = now / 1000
    this.mesh.userData.head.rotation.y = Math.sin(t * 1.3) * 0.5                                // the giant looks left and right
    this.mesh.userData.head.position.y = 5.6 + Math.sin(t * 2.6) * 0.12                          // and bobs to the beat
    for (const [i, flag] of this.mesh.userData.flags.entries()) flag.rotation.y = Math.sin(t * 3 + i) * 0.35
    placeBeacon(this.beacon, x, this.y, z, "Optocht", local, camera)
    if ((this.ribbonTimer += dt) > 1) { this.ribbonTimer = 0; this.updateRibbon(chunks) }
  }

  // a flat strip along the route, RIBBON_STEP metres per segment; y is filled in from the loaded tiles
  buildRibbon(path) {
    const n = Math.ceil(path.length / RIBBON_STEP)
    const dx = (path.x1 - path.x0) / n, dz = (path.z1 - path.z0) / n
    const len = Math.hypot(dx, dz) || 1, lx = -dz / len * RIBBON_HW, lz = dx / len * RIBBON_HW
    const pos = new Float32Array((n + 1) * 6), idx = []
    for (let i = 0; i <= n; i++) {
      const x = path.x0 + dx * i, z = path.z0 + dz * i
      pos.set([x + lx, 0, z + lz, x - lx, 0, z - lz], i * 6)
      if (i) { const a = 2 * (i - 1); idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3) }
    }
    this.ribbon.geometry.dispose()
    const g = new THREE.BufferGeometry()
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
    g.setIndex(idx)
    this.ribbon.geometry = g
    this.ribbonKnown = new Uint8Array(n + 1)
  }

  // ground the strip where tiles are loaded; the rest keeps the float's height until its tile comes in
  updateRibbon(chunks) {
    const pos = this.ribbon.geometry.attributes.position
    for (let i = 0; i < pos.count / 2; i++) {
      const x = (pos.getX(2 * i) + pos.getX(2 * i + 1)) / 2, z = (pos.getZ(2 * i) + pos.getZ(2 * i + 1)) / 2
      let y
      if (chunks.ready(x, z)) { y = chunks.heightAt(x, z) + RIBBON_LIFT; this.ribbonKnown[i] = 1 }
      else if (!this.ribbonKnown[i]) y = this.y + RIBBON_LIFT
      else continue
      pos.setY(2 * i, y); pos.setY(2 * i + 1, y)
    }
    pos.needsUpdate = true
  }
}

// A praalwagen: a tractor unit pulling a flatbed with a tiered build-up in the vastelaovend colours (red, yellow,
// green), a giant papier-mâché head with a pointed hat on top, flags on the corners and streamers down the sides.
function makeFloatMesh() {
  const g = new THREE.Group()
  const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...extra })
  const red = mat(0xe0241a), yellow = mat(0xf2c14e), green = mat(0x2a9d3a), blue = mat(0x2b4a8a), dark = mat(0x1a1a1a, { roughness: 0.9 })
  const skin = mat(0xf3c9a0), white = mat(0xf4f4f0)
  const add = (geo, m, x, y, z, parent = g) => { const mesh = new THREE.Mesh(geo, m); mesh.position.set(x, y, z); parent.add(mesh); return mesh }
  add(new THREE.BoxGeometry(3.4, 0.4, 8.6), blue, 0, 1.0, 1.5)                  // flatbed
  add(new THREE.BoxGeometry(3.2, 2.2, 2.8), red, 0, 1.9, -4.4)                  // tractor cab
  add(new THREE.BoxGeometry(3.0, 0.9, 0.2), dark, 0, 2.3, -5.7)                 // windscreen
  add(new THREE.BoxGeometry(3.0, 1.2, 5.6), red, 0, 1.8, 1.6)                   // tiers
  add(new THREE.BoxGeometry(2.4, 1.0, 4.4), yellow, 0, 2.9, 1.6)
  add(new THREE.BoxGeometry(1.8, 0.9, 3.2), green, 0, 3.85, 1.6)
  const head = new THREE.Group(); head.position.set(0, 5.6, 1.6); g.add(head)   // the giant
  add(new THREE.SphereGeometry(1.15, 18, 14), skin, 0, 0, 0, head)
  add(new THREE.SphereGeometry(0.28, 10, 8), red, 0, -0.1, -1.05, head)         // nose
  for (const x of [-0.45, 0.45]) add(new THREE.SphereGeometry(0.14, 8, 6), dark, x, 0.3, -1.0, head)
  add(new THREE.ConeGeometry(0.8, 1.7, 14), red, 0, 1.75, 0, head)               // pointed hat
  add(new THREE.SphereGeometry(0.2, 8, 6), yellow, 0, 2.65, 0, head)
  add(new THREE.TorusGeometry(0.95, 0.12, 8, 20), yellow, 0, 0.85, 0, head).rotation.x = Math.PI / 2   // brim
  const flags = []
  for (const [x, z, m] of [[-1.5, -2.8, red], [1.5, -2.8, yellow], [-1.5, 5.6, green], [1.5, 5.6, red]]) {
    add(new THREE.CylinderGeometry(0.04, 0.04, 3.2, 6), white, x, 2.8, z)
    const flag = add(new THREE.PlaneGeometry(0.9, 0.55), m, x, 4.1, z)
    flag.material.side = THREE.DoubleSide
    flag.geometry.translate(0.45, 0, 0)
    flags.push(flag)
  }
  for (const z of [-1.4, 0.6, 2.6, 4.6]) for (const [x, m] of [[-1.72, yellow], [1.72, green]]) add(new THREE.BoxGeometry(0.08, 0.9, 0.5), m, x, 1.1, z)   // streamers
  const wheel = new THREE.CylinderGeometry(0.55, 0.55, 0.4, 14); wheel.rotateZ(Math.PI / 2)
  for (const z of [-4.2, 1.2, 3.6]) for (const x of [-1.5, 1.5]) add(wheel, dark, x, 0.55, z)
  const headLamp = new THREE.MeshStandardMaterial({ color: 0xfff8e6, emissive: 0xfff3cc, emissiveIntensity: 0.6 })
  const tailLamp = new THREE.MeshStandardMaterial({ color: 0x7a1010, emissive: 0xff1a12, emissiveIntensity: 0.4 })
  for (const x of [-1.2, 1.2]) { add(new THREE.BoxGeometry(0.4, 0.2, 0.06), headLamp, x, 1.4, -5.83); add(new THREE.BoxGeometry(0.4, 0.2, 0.06), tailLamp, x, 1.1, 5.83) }
  g.userData.head = head
  g.userData.flags = flags
  g.userData.lights = { head: headLamp, tail: tailLamp }
  return g
}
