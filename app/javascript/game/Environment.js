import * as THREE from "three"
import { TUNING as T } from "game/Tuning"

// The ambient light of the scene, baked from the sky DayNight is already drawing: a small back-faced sphere shaded
// with the same horizon → zenith ramp, the ground bounce below it and a soft sun blob, run through PMREM whenever
// the sky has moved far enough to notice. No HDR file and no art — whatever the sky does, the light follows. In
// r186 Lambert and Phong read scene.environment as well, so this is an ambient upgrade at no material cost.
//
// 64² is deliberate: our world sits at roughness 0.9–1.0, so only the irradiance and the blurriest mips are ever
// read, and the GGX convolution at 256² would cost an order of magnitude more for nothing.
const VERTEX = /* glsl */`
  varying vec3 vDir;
  void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`

// no tone mapping and no colour-space include here: PMREM wants the light, not the picture
const FRAGMENT = /* glsl */`
  uniform vec3 zenith, horizon, ground, sunColor, sunDir;
  uniform float glare;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    vec3 col = d.y >= 0.0 ? mix(horizon, zenith, pow(d.y, 0.42))               // the ramp SKY_FRAGMENT draws
                          : mix(horizon, ground, smoothstep(0.0, 0.35, -d.y));  // what the ground bounces back up
    col += sunColor * glare * smoothstep(0.988, 0.9975, dot(d, sunDir));        // a ~6° disc: a highlight, not a light
    gl_FragColor = vec4(col, 1.0);
  }`

export class Environment {
  constructor(world) {
    this.world = world
    this.pmrem = new THREE.PMREMGenerator(world.renderer)
    this.uniforms = {
      zenith: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, ground: { value: new THREE.Color() },
      sunColor: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, glare: { value: 6 },
    }
    this.scene = new THREE.Scene()
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT, side: THREE.BackSide, depthWrite: false,
    })))
    this.target = null
    this.sig = -1e9
    this.at = -1e9
    this.bakes = 0
    this.lastMs = 0
  }

  // once a frame, after DayNight has moved the sky. Re-bakes when the colours have drifted past `step`, or when
  // `maxInterval` has passed (the sun keeps sweeping even while the colours hold), never twice within
  // `minInterval` and never on a frame that is already struggling.
  update(env, ground, elapsed, frameMs) {
    const E = T.light.env
    const scene = this.world.scene
    if (!E.on) {
      if (scene.environment) { scene.environment = null; this.target?.dispose(); this.target = null; this.sig = -1e9 }
      return
    }
    scene.environmentIntensity = E.intensity[0] + (E.intensity[1] - E.intensity[0]) * (1 - env.darkness)
    const c = env.zenith, h = env.horizon, s = env.sunColor
    const sig = c.r + c.g + c.b + h.r + h.g + h.b + s.r + s.g + s.b
    const due = Math.abs(sig - this.sig) > E.step || elapsed - this.at > E.maxInterval
    if (!due || elapsed - this.at < E.minInterval || frameMs > E.skipMs) return
    this.sig = sig
    this.at = elapsed
    this.uniforms.zenith.value.copy(c)
    this.uniforms.horizon.value.copy(h)
    this.uniforms.ground.value.copy(ground)
    this.uniforms.sunColor.value.copy(s)
    this.uniforms.sunDir.value.copy(env.sunDir)
    this.uniforms.glare.value = E.glare
    const t0 = performance.now()
    const next = this.pmrem.fromScene(this.scene, E.sigma, 0.1, 100, { size: E.size })
    this.target?.dispose()                       // fromScene allocates a fresh render target every call
    this.target = next
    scene.environment = next.texture
    this.lastMs = Math.round((performance.now() - t0) * 100) / 100
    this.bakes++
  }
}
