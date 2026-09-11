import * as THREE from "three"
import { TUNING as T } from "game/Tuning"
import { noOutline } from "game/Outline"

// A full day every 6 minutes, on the wall clock so every player shares the same time of day. Sunrise at 04:30,
// solar noon at 13:00, sunset at 21:30 game time. The sun light swings east → south → west and fades out; the sky,
// fog and hemisphere light darken to a moonlit blue; `darkness` (0 day … 1 night) drives street lamps, headlights
// and sign reflectivity. ?time=23 in the URL freezes the clock at that hour (handy for looking at the night).
export const DAY_SECONDS = 360
export const SUNRISE = 4.5, SUNSET = 21.5
const SKY_DISTANCE = 3200                                    // inside the camera's far plane, beyond the loaded tiles

const DAY_SKY = new THREE.Color(0x9fb8cf), DUSK_SKY = new THREE.Color(0xe39a6c), NIGHT_SKY = new THREE.Color(0x0a0f1d)
// sky dome palette: zenith / horizon by phase, plus the glow banked around the sun at dawn and dusk
const DAY_ZENITH = new THREE.Color(0x4f8fd2), DAY_HORIZON = new THREE.Color(0xbfd4e6)
const DUSK_ZENITH = new THREE.Color(0x22305e), DUSK_HORIZON = new THREE.Color(0xf2a868), DUSK_GLOW = new THREE.Color(0xff6a28)
const NIGHT_ZENITH = new THREE.Color(0x03050f), NIGHT_HORIZON = new THREE.Color(0x0e1729)
const DAY_HEMI = new THREE.Color(0xdfe9f3), NIGHT_HEMI = new THREE.Color(0x2a3552)
const DAY_GROUND = new THREE.Color(0x5b6b4a), NIGHT_GROUND = new THREE.Color(0x0b0d12)
const SUN_DAY = new THREE.Color(0xfff2dc), SUN_LOW = new THREE.Color(0xffb070), MOON = new THREE.Color(0x9fb4ff)

export class DayNight {
  constructor(world) {
    this.world = world
    const fixed = Number(new URLSearchParams(location.search).get("time"))
    this.fixedHours = Number.isFinite(fixed) && location.search.includes("time=") ? ((fixed % 24) + 24) % 24 : null
    this.darkness = 0
    this.env = { darkness: 0, sunDir: new THREE.Vector3(0, 1, 0), sunColor: new THREE.Color(), zenith: new THREE.Color(), horizon: new THREE.Color() }
    this._sky = new THREE.Color()
    this._c = new THREE.Color()
    this._dir = new THREE.Vector3()
    // the sun and the moon: sprites far out along the light directions, moved with the camera, outside the fog
    this.sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: discTexture("sun"), transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending }))
    this.sunSprite.scale.setScalar(SKY_DISTANCE * 0.16)
    this.moonSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: discTexture("moon"), transparent: true, depthWrite: false, fog: false }))
    this.moonSprite.scale.setScalar(SKY_DISTANCE * 0.07)
    this.sunSprite.renderOrder = this.moonSprite.renderOrder = -1
    world.scene.add(this.sunSprite, this.moonSprite)
    // the sky: a dome around the camera shaded from horizon to zenith, with the dusk glow and the stars
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(SKY_DISTANCE * 1.1, 32, 16), noOutline(new THREE.ShaderMaterial({
      uniforms: { zenith: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, glow: { value: DUSK_GLOW.clone() },
                  sunDir: { value: new THREE.Vector3(1, 0, 0) }, glowStrength: { value: 0 }, stars: { value: 0 } },
      vertexShader: SKY_VERTEX, fragmentShader: SKY_FRAGMENT, side: THREE.BackSide, depthWrite: false, fog: false
    })))
    this.sky.renderOrder = -10
    this.sky.frustumCulled = false
    world.scene.add(this.sky)
  }

  // game hours 0..24
  hours() {
    if (this.fixedHours !== null) return this.fixedHours
    return ((Date.now() / 1000) % DAY_SECONDS) / DAY_SECONDS * 24
  }

  // wind the clock an hour on (vrij rijden): freezes it where it lands, like ?time= does
  stepHours(d) { this.fixedHours = (((this.hours() + d) % 24) + 24) % 24 }

  clock() {
    const h = this.hours()
    return `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")}`
  }

  // returns darkness 0..1
  update() {
    const w = this.world
    const a = sunAngle(this.hours())
    const elev = Math.sin(a)                                  // sun elevation, -1..1
    const daylight = smoothstep(-0.22, 0.30, elev)             // twilight lingers ~30 game minutes after sunset
    const dusk = (1 - smoothstep(0, 0.35, Math.abs(elev))) * smoothstep(-0.35, -0.05, elev)   // warm glow around the horizon

    this._sky.copy(NIGHT_SKY).lerp(DAY_SKY, daylight).lerp(DUSK_SKY, dusk * 0.5)
    w.scene.background.copy(this._sky)
    const u = this.sky.material.uniforms
    u.zenith.value.copy(NIGHT_ZENITH).lerp(DAY_ZENITH, daylight).lerp(DUSK_ZENITH, dusk)
    u.horizon.value.copy(NIGHT_HORIZON).lerp(DAY_HORIZON, daylight).lerp(DUSK_HORIZON, dusk)
    u.glowStrength.value = dusk * 1.3
    u.stars.value = smoothstep(0.16, 0.42, -elev)              // stars only once the sun is well below the horizon
    w.scene.fog.color.copy(u.horizon.value)                     // the ground fades into the horizon, not into a flat sky
    w.scene.fog.near = 600 - 300 * (1 - daylight); w.scene.fog.far = 2200 - 900 * (1 - daylight)

    // the sun: east at sunrise, high in the south at noon, west at sunset; at night a faint moon from the other side
    const up = Math.max(elev, 0.02)
    if (elev > -0.05) w.sun.position.set(Math.cos(a) * 600, up * 600, Math.sin(a) * 300 + 80)
    else w.sun.position.set(-Math.cos(a) * 400, 500, -Math.sin(a) * 200 + 150)

    // sun disc: along the sun's compass direction, reddening and fading as it touches the horizon. The chase camera
    // only sees ~20° above the horizon, so the disc rides a flattened arc (2° at the horizon, 18° at noon) instead
    // of the true elevation the light uses
    const cam = w.camera.position
    const sunAlt = THREE.MathUtils.degToRad(2 + 16 * elev)
    this._dir.set(Math.cos(a), 0, Math.sin(a) * 0.5 + 0.13).normalize().multiplyScalar(Math.cos(sunAlt)).setY(Math.sin(sunAlt))
    this.sunSprite.position.copy(cam).addScaledVector(this._dir, SKY_DISTANCE)
    u.sunDir.value.copy(this._dir)
    this.sky.position.copy(cam)
    this.sunSprite.material.opacity = smoothstep(-0.03, 0.06, elev)
    this.sunSprite.material.color.copy(this._c.copy(SUN_DAY).lerp(SUN_LOW, dusk))
    // moon: opposite the sun, up all night, gone by day
    const moonAlt = THREE.MathUtils.degToRad(3 + 13 * Math.max(-elev, 0))                      // same flattened arc for the moon
    this._dir.set(-Math.cos(a), 0, -Math.sin(a) * 0.5 + 0.2).normalize().multiplyScalar(Math.cos(moonAlt)).setY(Math.sin(moonAlt))
    this.moonSprite.position.copy(cam).addScaledVector(this._dir, SKY_DISTANCE)
    this.moonSprite.material.opacity = smoothstep(0.02, 0.2, -elev)
    w.sun.color.copy(daylight > 0.02 ? this._c.copy(SUN_DAY).lerp(SUN_LOW, dusk) : MOON)
    w.sun.intensity = (1.6 * daylight + 0.12 * (1 - daylight)) * T.light.sun
    w.hemi.color.copy(this._c.copy(NIGHT_HEMI).lerp(DAY_HEMI, daylight))
    w.hemi.groundColor.copy(this._c.copy(NIGHT_GROUND).lerp(DAY_GROUND, daylight))
    w.hemi.intensity = (0.22 + 0.68 * daylight) * T.light.hemi          // the environment map is a sky light too: do not count it twice
    w.renderer.toneMappingExposure = T.light.exposure + T.light.nightExposure * (1 - daylight)

    this.darkness = 1 - daylight
    this.env.darkness = this.darkness
    this.env.sunDir.copy(w.sun.position).normalize()
    this.env.sunColor.copy(w.sun.color).multiplyScalar(w.sun.intensity)
    this.env.zenith.copy(u.zenith.value); this.env.horizon.copy(u.horizon.value)
    return this.darkness
  }
}

const SKY_VERTEX = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = (modelMatrix * vec4(position, 1.0)).xyz - cameraPosition;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`
const SKY_FRAGMENT = /* glsl */`
  uniform vec3 zenith, horizon, glow, sunDir;
  uniform float glowStrength, stars;
  varying vec3 vDir;
  float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  void main() {
    vec3 d = normalize(vDir);
    float h = clamp(d.y, 0.0, 1.0);
    vec3 col = mix(horizon, zenith, pow(h, 0.42));
    // dawn/dusk: a warm band along the horizon, strongest towards the sun
    float toSun = max(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(sunDir.x, 0.0, sunDir.z))), 0.0);
    col += glow * glowStrength * exp(-h * 7.0) * (0.15 + 0.85 * pow(toSun, 4.0));
    col += glow * glowStrength * 0.35 * exp(-h * 2.5) * pow(toSun, 12.0);
    if (d.y < 0.0) col = horizon;
    // stars: a sparse hash on the direction; each lit cell holds one soft dot, fading out towards the horizon.
    // The dome covers every pixel, so skip the six hashes per fragment while there are no stars to show.
    if (stars > 0.001 && d.y > 0.0) {
      vec3 cell = floor(d * 420.0);
      float r = hash(cell);
      vec3 f = fract(d * 420.0) - 0.5;
      float dot_ = smoothstep(0.28, 0.05, length(f + (vec3(hash(cell + 3.0), hash(cell + 5.0), hash(cell + 7.0)) - 0.5) * 0.4));
      float star = step(0.9985, r) * dot_ * (0.45 + 0.55 * hash(cell + 1.0)) * smoothstep(0.02, 0.22, d.y);
      col += mix(vec3(1.0), vec3(0.8, 0.9, 1.0), hash(cell + 9.0)) * star * stars * 1.5;
    }
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`

// sun: white core with a warm halo (additive); moon: pale disc with a few maria and a faint glow
function discTexture(kind) {
  const c = document.createElement("canvas"); c.width = c.height = 256
  const ctx = c.getContext("2d")
  if (kind === "sun") {
    const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128)
    g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.16, "rgba(255,250,225,1)"); g.addColorStop(0.2, "rgba(255,235,180,0.55)")
    g.addColorStop(0.45, "rgba(255,200,120,0.14)"); g.addColorStop(1, "rgba(255,180,100,0)")
    ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 256)
  } else {
    const halo = ctx.createRadialGradient(128, 128, 60, 128, 128, 128)
    halo.addColorStop(0, "rgba(200,210,235,0.35)"); halo.addColorStop(1, "rgba(200,210,235,0)")
    ctx.fillStyle = halo; ctx.fillRect(0, 0, 256, 256)
    ctx.fillStyle = "#e6e9f0"; ctx.beginPath(); ctx.arc(128, 128, 62, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = "rgba(150,158,180,0.55)"
    for (const [x, y, r] of [[108, 112, 16], [140, 100, 10], [150, 140, 14], [118, 150, 9], [96, 138, 7]]) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill() }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
  return t
}

// 0 at sunrise, π/2 at solar noon, π at sunset, 2π at the next sunrise: the daylight hours are stretched over the
// upper half of the circle and the night hours squeezed into the lower half
function sunAngle(hours) {
  const t = (hours - SUNRISE + 24) % 24, day = SUNSET - SUNRISE
  return t < day ? t / day * Math.PI : Math.PI + (t - day) / (24 - day) * Math.PI
}

function smoothstep(a, b, x) { const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t) }
