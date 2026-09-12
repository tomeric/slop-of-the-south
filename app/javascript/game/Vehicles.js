import * as THREE from "three"
import { TUNING as T } from "game/Tuning"
import { softTexture } from "game/Effects"
import { casts } from "game/Shadows"

// The three vehicles, each with its own trick, plus the plain car everyone drove before. The numbers feed Vehicle.js
// (physics), Combat.js (ram and side for collision damage, clear for rubble, push to grind through) and Camera.js
// (cam scales the chase distance and height).
// The mesh builders honour the contract the suspension and the effects expect: userData.wheels (a pivot per wheel
// at its corner, with its radius), userData.lights (head and tail materials) and userData.flames (exhaust sprites).
export const VEHICLES = [
  { id: "trike", naam: "Trike", blurb: "Snel en wendbaar, maar hij deukt alleen zichzelf bij een botsing. Eén raketwerper, een raket om de 2,5 seconde.",
    maxSpeed: 32, accel: 11, brakeForce: 20, maxSteer: 0.6, wheelbase: 1.9, track: 1.4, length: 2.6,
    ram: 0.02, side: 1, clear: 0.4, push: false, pushMin: 0, cam: { dist: 0.95, height: 0.95 },
    mass: 350, com: 0.45, grip: 1.0, bite: 0.25,           // kg, centre of mass above the contact patch
    body: { hx: 0.6, hy: 0.42, hz: 1.1, y: 0.76, z: 0.2 }, // the hull, clear of the ground: the wheels carry the car
    smashMin: 13, smashPanels: 2, smashLoss: 1.4,          // it takes a proper run-up, and the wall takes it out of you
    ability: { kind: "missile", cooldown: 2.5, hint: "E raket" } },
  { id: "monster", naam: "Monstertruck", blurb: "Even snel, hoog op de wielen. Springt en verplettert wat eronder ligt; drift met je flank tegen een huis voor de meeste schade.",
    maxSpeed: 32, accel: 9, brakeForce: 18, maxSteer: 0.5, wheelbase: 3.4, track: 2.4, length: 5.0,
    ram: 0.4, side: 2.5, clear: 1.0, push: false, pushMin: 0, cam: { dist: 1.25, height: 1.3 },
    mass: 4000, com: 1.15, grip: 1.0, bite: 0.4,
    body: { hx: 0.95, hy: 0.75, hz: 2.1, y: 1.9, z: 0.1 },
    smashMin: 6, smashPanels: 4, smashLoss: 0.7,
    ability: { kind: "jump", cooldown: 2.5, hint: "E springen" } },
  { id: "bulldozer", naam: "Bulldozer", blurb: "Traag, maar ramt op snelheid dwars door alles heen en veegt puin in één keer weg. Het blad op en neer beukt een huis extra.",
    maxSpeed: 12, accel: 5, brakeForce: 14, maxSteer: 0.6, wheelbase: 3.2, track: 2.4, length: 5.5,
    ram: 3.0, side: 1, clear: 50, push: true, pushMin: 2, cam: { dist: 1.3, height: 1.3 },
    mass: 12000, com: 0.85, grip: 1.1, bite: 1.0,
    body: { hx: 1.2, hy: 0.6, hz: 1.8, y: 1.3, z: 0.3 },   // the hull only: the tracks are drawn to y 0.1 and would scrape
    smashMin: 1.5, smashPanels: 7, smashLoss: 0.2,         // it is a bulldozer: it walks through walls
    ability: { kind: "blade", cooldown: 1.0, hint: "E blad op/neer" } },
]
const AUTO = { id: "auto", naam: "Auto", length: 4.1, wheelbase: 2.6, track: 1.6, ram: 0.1, clear: 0.4, push: false, pushMin: 0, smashMin: 13, smashPanels: 2, smashLoss: 1.4, cam: { dist: 1, height: 1 },
  mass: 1400, com: 0.5, grip: 1.0, bite: 0.3, body: { hx: 0.9, hy: 0.51, hz: 2.05, y: 0.79, z: 0 },
  ability: { kind: "none", cooldown: 0, hint: "" } }

export const vehicleSpec = (id) => VEHICLES.find((v) => v.id === id) ?? (id === "auto" ? AUTO : VEHICLES[0])

export function makeVehicleMesh(id, color = 0xd7412b) {
  return casts((BUILDERS[id] ?? makeCarMesh)(color))
}

// ---- shared parts ------------------------------------------------------------------------------------------------

let flameMat = null
const flameMaterial = () => flameMat ??= new THREE.SpriteMaterial({ map: softTexture(), color: 0xff8a2a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })

function materials(color) {
  return {
    paint: new THREE.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.4 }),
    dark:  new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x6b6f76, metalness: 0.6, roughness: 0.45 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x2a3540, roughness: 0.2, metalness: 0.4 }),
    yellow: new THREE.MeshStandardMaterial({ color: 0xf2b21e, roughness: 0.5 }),
    head:  new THREE.MeshStandardMaterial({ color: 0xfff8e6, emissive: 0xfff3cc, emissiveIntensity: 0.35, roughness: 0.3 }),
    tail:  new THREE.MeshStandardMaterial({ color: 0x7a1010, emissive: 0xff1a12, emissiveIntensity: 0.12, roughness: 0.4 }),
  }
}

function box(g, mat, w, h, d, x, y, z) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); g.add(m); return m }

// a wheel on a pivot at its corner; the suspension moves the pivot up and down and steers the front ones
function wheel(g, mat, lx, lz, r, width, visible = true) {
  const pivot = new THREE.Group(); pivot.position.set(lx, r, lz)
  const geo = new THREE.CylinderGeometry(r, r, width, 14); geo.rotateZ(Math.PI / 2)
  const mesh = new THREE.Mesh(geo, mat); mesh.visible = visible
  pivot.add(mesh); g.add(pivot)
  return { pivot, mesh, lx, lz, front: lz < 0, r }
}

// headlights at the nose, tail lights at the back
function lamps(g, m, zFront, zBack, y, xs, w = 0.34) {
  const lamp = new THREE.BoxGeometry(w, 0.16, 0.06)
  for (const x of xs) {
    const h = new THREE.Mesh(lamp, m.head); h.position.set(x, y, zFront); g.add(h)
    const t = new THREE.Mesh(lamp, m.tail); t.position.set(x, y + 0.04, zBack); g.add(t)
  }
}

function flames(g, xs, y, z) {
  return xs.map((x) => { const s = new THREE.Sprite(flameMaterial()); s.position.set(x, y, z); s.scale.setScalar(0); s.visible = false; g.add(s); return s })
}

function finish(g, m, wheels, fl = []) {
  g.userData.lights = { head: m.head, tail: m.tail }
  g.userData.wheels = wheels
  g.userData.flames = fl
  return g
}

// ---- the meshes ----------------------------------------------------------------------------------------------------

// The plain car: everyone's ride before the vastelaovend mode, still the fallback for remotes without a vehicle.
export function makeCarMesh(color = 0xd7412b) {
  const g = new THREE.Group(), m = materials(color)
  box(g, m.paint, 1.8, 0.55, 4.1, 0, 0.55, 0)
  box(g, m.paint, 1.6, 0.5, 1.9, 0, 1.05, -0.2)
  const r = T.susp.wheelRadius
  const wheels = [[-0.85, -1.3], [0.85, -1.3], [-0.85, 1.3], [0.85, 1.3]].map(([lx, lz]) => wheel(g, m.dark, lx, lz, r, 0.25))
  lamps(g, m, -2.06, 2.06, 0.62, [-0.6, 0.6])
  return finish(g, m, wheels, flames(g, [-0.45, 0.45], 0.42, 2.25))
}

// a three-wheeler: one wheel up front, a low pod, a single rocket launcher on the right
function makeTrike(color) {
  const g = new THREE.Group(), m = materials(color)
  box(g, m.paint, 1.2, 0.5, 2.2, 0, 0.6, 0.2)
  box(g, m.glass, 0.9, 0.35, 0.8, 0, 1.0, -0.2)
  box(g, m.steel, 0.14, 0.14, 1.2, 0, 0.9, -0.6)                  // fork
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.5, 12), m.steel); tube.rotation.x = Math.PI / 2; tube.position.set(0.55, 1.05, -0.3); g.add(tube)
  box(g, m.dark, 0.1, 0.3, 0.3, 0.55, 0.85, 0.1)                   // launcher mount
  const wheels = [wheel(g, m.dark, 0, -1.05, 0.34, 0.2), wheel(g, m.dark, -0.7, 0.9, 0.36, 0.3), wheel(g, m.dark, 0.7, 0.9, 0.36, 0.3)]
  lamps(g, m, -1.3, 1.3, 0.7, [0], 0.3)
  return finish(g, m, wheels, flames(g, [-0.35, 0.35], 0.5, 1.35))
}

// a pickup on giant wheels
function makeMonster(color) {
  const g = new THREE.Group(), m = materials(color)
  box(g, m.paint, 1.9, 0.6, 4.2, 0, 1.75, 0.1)
  box(g, m.paint, 1.7, 0.6, 1.6, 0, 2.35, -0.6)
  box(g, m.glass, 1.5, 0.4, 0.15, 0, 2.4, -1.42)
  box(g, m.steel, 0.9, 0.3, 3.6, 0, 1.3, 0)                       // chassis
  for (const [x, z] of [[-1.2, -1.7], [1.2, -1.7], [-1.2, 1.7], [1.2, 1.7]]) box(g, m.steel, 0.2, 0.9, 0.2, x * 0.7, 1.15, z)   // axles
  const wheels = [[-1.2, -1.7], [1.2, -1.7], [-1.2, 1.7], [1.2, 1.7]].map(([lx, lz]) => wheel(g, m.dark, lx, lz, 0.9, 0.7))
  lamps(g, m, -2.12, 2.12, 1.85, [-0.6, 0.6])
  return finish(g, m, wheels, flames(g, [-0.5, 0.5], 1.5, 2.3))
}

// a bulldozer: a squat hull on tracks, a cab, and a blade on two arms out front
function makeBulldozer(color) {
  const g = new THREE.Group(), m = materials(color)
  box(g, m.yellow, 2.4, 1.2, 3.6, 0, 1.3, 0.3)
  box(g, m.paint, 1.8, 1.2, 1.6, 0, 2.5, 0.5)
  box(g, m.glass, 1.6, 0.6, 0.15, 0, 2.6, -0.32)
  for (const x of [-1.35, 1.35]) box(g, m.dark, 0.7, 1.0, 4.0, x, 0.6, 0.2)
  const blade = new THREE.Group(); g.add(blade)                                                     // lifts on E
  for (const x of [-1.2, 1.2]) box(blade, m.steel, 0.16, 0.16, 2.2, x, 0.9, -1.7)                  // arms
  box(blade, m.steel, 3.4, 1.2, 0.25, 0, 0.75, -2.85)                                              // the blade
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.0, 8), m.dark); pipe.position.set(0.8, 2.4, 1.0); g.add(pipe)
  const wheels = [[-1.35, -1.5], [1.35, -1.5], [-1.35, 1.5], [1.35, 1.5]].map(([lx, lz]) => wheel(g, m.dark, lx, lz, 0.5, 0.5, false))
  lamps(g, m, -2.98, 2.1, 2.7, [-0.6, 0.6], 0.3)
  g.userData.anim = { blade }
  return finish(g, m, wheels)
}

const BUILDERS = { auto: makeCarMesh, trike: makeTrike, monster: makeMonster, bulldozer: makeBulldozer }
