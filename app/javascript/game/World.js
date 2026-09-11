import * as THREE from "three"
import { ChaseCamera } from "game/Camera"

// Renderer, camera, light and atmosphere. Nothing game-specific lives here.
export class World {
  constructor(container) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))   // 2× on a Retina screen quadruples the fill cost for little gain with MSAA on
    this.renderer.setSize(innerWidth, innerHeight)
    this.renderer.toneMapping = THREE.NeutralToneMapping   // ACES crushed the greens; Neutral keeps the palette (DayNight drives the exposure)
    container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    const sky = new THREE.Color(0x9fb8cf)
    this.scene.background = sky
    this.scene.fog = new THREE.Fog(sky, 600, 2200)   // hides tiles popping in at the horizon

    this.camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 4000)

    this.hemi = new THREE.HemisphereLight(0xdfe9f3, 0x5b6b4a, 0.9)
    this.sun  = new THREE.DirectionalLight(0xfff2dc, 1.6)
    this.sun.position.set(-300, 500, -200)           // afternoon sun from the south-west; DayNight moves it
    this.scene.add(this.hemi, this.sun)

    this.chase = new ChaseCamera(this.camera)
    addEventListener("resize", () => this.resize())
  }

  // ground height function so the camera never sinks into the terrain
  setHeightAt(fn) { this.chase.heightAt = fn }

  resize() {
    this.camera.aspect = innerWidth / innerHeight
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(innerWidth, innerHeight)
  }

  // Spring-damped chase camera (game/Camera). A huge dt (spawn, teleport) snaps it straight into place.
  followCamera(car, dt) { dt >= 10 ? this.chase.snap(car) : this.chase.update(car, dt) }
  snapCamera(car) { this.chase.snap(car) }

  render() { this.renderer.render(this.scene, this.camera) }
}
