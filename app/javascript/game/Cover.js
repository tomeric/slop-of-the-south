import * as THREE from "three"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"
import { TUNING as T, mulberry32 } from "game/Tuning"

// BGT land cover per tile: painted into a canvas texture that the terrain tile wears, plus water surfaces. Every
// polygon gets its class colour and, when big enough, a detail pattern clipped to it (mottling, crop rows, forest
// floor, heather, a wet band along the water); the terrain material multiplies a tiling grain over it up close.
// Tile format: cover = [[code, outerRing, holeRing, ...], ...] with rings as flat decimetre offsets [dx, dz, ...]
// from the tile's north-west corner (0..5000). Codes match LandCover::CODES on the server. Water entries carry their
// surface level first: [30, level | null, outerRing, ...] — a level means a flat surface over a carved bed (lakes,
// the Maas, canals), null means a thin watercourse draped on the terrain.
export const TEXTURE_SIZE = 512
const BASE = "#7fa15a"
const COLORS = {
  1: ["#78a049", "#6f9a44", "#7ea64d"],                              // grasland agrarisch (meadow)
  2: ["#86a44f", "#7fa04a"],                                         // grasland overig
  3: ["#6e9448", "#739a4b"],                                         // groenvoorziening (urban green)
  4: ["#b69b63", "#c9b077", "#a48a58", "#9ea653", "#bfa76a", "#8d9b4c", "#d1b97d"],  // bouwland: soil, stubble, crops
  5: ["#7aa04a", "#74994a"],                                         // fruitteelt (orchard grass)
  6: ["#7f9d4f"],                                                    // boomteelt
  7: ["#4f7a38", "#557f3c"],                                         // loofbos floor
  8: ["#8b7d5b"], 9: ["#6d8b45"], 10: ["#88915a"], 11: ["#d8c8a2"], 12: ["#9a9468"],
  13: ["#3c5f34", "#426a38"], 14: ["#48723a", "#4e7a3e"], 15: ["#4d7c3c"],   // naaldbos, gemengd bos, houtwal
  16: ["#7e8a52"], 17: ["#8d9660"], 18: ["#e0d2a8"],                 // moeras, kwelder, duin
  19: ["#3d6b2c"],                                                   // haag (hedge)
  20: ["#b3a795", "#ada08d", "#b8ad9b"],                             // erf (yards)
  21: ["#5b5b5e"], 22: ["#8d7d72"], 23: ["#a89c86"], 24: ["#9d8b6c"],  // pavement grades
  25: ["#84a353", "#7e9e4e"],                                        // berm (road verge)
  30: ["#25393c"]                                                    // water bed (seen through the surface)
}
const WATER = 30
// which detail patterns each class gets, laid over the flat fill
const DETAIL = { 1: ["mottle"], 2: ["mottle"], 3: ["mottle"], 4: ["rows"], 5: ["mottle", "mown"], 6: ["mown"], 7: ["mottle", "floor"],
                 8: ["mottle", "heath"], 9: ["mottle", "shrub"], 10: ["marsh"], 11: ["sand"], 13: ["mottle", "floor"], 14: ["mottle", "floor"],
                 15: ["mottle", "shrub"], 16: ["marsh"], 17: ["mottle"], 18: ["sand"], 19: ["shrub"], 20: ["mottle"], 21: ["asphalt"],
                 22: ["grid"], 23: ["asphalt"], 24: ["mottle"], 25: ["mottle"] }
// What BGT records about a polygon beyond its class (cover_sub, LandCover::DETAILS): a shade and a pattern that beat
// the class default. Only part of the map carries one, so the defaults above have to look right on their own.
const SUB = {
  1:  { detail: ["mottle"] },                                        // gras- en kruidachtigen
  2:  { shade: -0.10, detail: ["mottle", "shrub"] },                  // heesters
  3:  { shade: -0.04, detail: ["mottle"] },                           // bodembedekkers, planten
  4:  { shade: -0.16, detail: ["mottle", "shrub"] },                  // bosplantsoen
  5:  { detail: ["rows"] },                                           // akkerbouw
  6:  { detail: ["mottle", "mown"] }, 7: { detail: ["mown"] },        // hoogstam, laagstam boomgaard
  8:  { detail: ["klinker"] }, 9: { detail: ["grid"] }, 10: { shade: -0.04, detail: ["asphalt"] },
  11: { detail: ["gravel"] }, 12: { shade: 0.08, detail: ["sand"] }, 13: { detail: ["grasgrid"] }, 14: { shade: -0.08, detail: ["bark"] },
}

// darken (< 0) or lighten (> 0) a hex colour
function shade(hex, amount) {
  if (!amount) return hex
  const n = parseInt(hex.slice(1), 16), f = amount < 0 ? 1 + amount : 1 - amount, t = amount < 0 ? 0 : 255
  return "#" + [16, 8, 0].map((sh) => Math.round(((n >> sh) & 255) * f + t * (1 - f)).toString(16).padStart(2, "0")).join("")
}

export function paintCover(cover, subs = []) {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = TEXTURE_SIZE
  const ctx = canvas.getContext("2d")
  ctx.fillStyle = BASE
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE)
  const k = TEXTURE_SIZE / 5000, P = T.ground.paint, pats = patternsFor(ctx), t0 = performance.now()
  let detailed = 0
  for (let e = 0; e < cover.length; e++) {
    const entry = cover[e], code = entry[0], palette = COLORS[code], over = SUB[subs[e]]
    if (!palette) continue
    const start = waterLevel(entry) === undefined ? 1 : 2          // water: [code, level, rings…]
    const h = hash(entry[start])
    ctx.fillStyle = shade(palette[h % palette.length], over?.shade)   // stable per polygon: fields keep their colour
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity
    ctx.beginPath()
    for (let r = start; r < entry.length; r++) {
      const ring = entry[r]
      for (let i = 0; i < ring.length; i += 2) {
        const x = ring[i] * k, y = ring[i + 1] * k
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y)
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y
      }
      ctx.closePath()
    }
    if (code === WATER) { ctx.lineWidth = 4; ctx.strokeStyle = "rgba(35,45,25,.45)"; ctx.stroke() }   // the fill covers the inner half: a wet band stays on the land
    ctx.fill("evenodd")
    const names = over?.detail ?? DETAIL[code]
    if (names && detailed < P.maxPolys && bx1 - bx0 >= P.minPx && by1 - by0 >= P.minPx && performance.now() - t0 < P.budgetMs) {
      detailed++
      ctx.save()
      ctx.clip("evenodd")
      ctx.translate((bx0 + bx1) / 2, (by0 + by1) / 2)
      ctx.rotate(((h >>> 8) % 360) * Math.PI / 180)                // crop rows and streaks get a direction per field
      const R = Math.hypot(bx1 - bx0, by1 - by0) / 2 + 2
      for (const name of names) { ctx.fillStyle = pats[name]; ctx.fillRect(-R - (h % 128), -R - ((h >>> 7) % 128), 2 * R + 128, 2 * R + 128) }
      ctx.restore()
    }
    if (code === WATER) { ctx.save(); ctx.clip("evenodd"); ctx.lineWidth = 3; ctx.strokeStyle = "rgba(120,140,110,.35)"; ctx.stroke(); ctx.restore() }   // shallows along the shore
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

// ---- detail patterns: 128 px tiles drawn so they wrap, turned into repeating patterns per canvas --------------------

const PATTERN = 128
let patternCanvases = null

function patternsFor(ctx) {
  patternCanvases ??= {
    mottle:  tile((g, rnd, at) => { for (let i = 0; i < 60; i++) blob(g, rnd, at, 8 + rnd() * 16, i % 2 ? "rgba(255,255,255,.10)" : "rgba(0,0,0,.10)") }),
    rows:    tile((g) => { g.fillStyle = "rgba(0,0,0,.14)"; for (let y = 0; y < PATTERN; y += 3) g.fillRect(0, y, PATTERN, 1.5) }),
    mown:    tile((g) => { g.fillStyle = "rgba(0,0,0,.09)"; for (let y = 0; y < PATTERN; y += 6) g.fillRect(0, y, PATTERN, 2) }),
    floor:   tile((g, rnd, at) => { dots(g, rnd, at, 500, 1, 2, "rgba(0,0,0,.25)"); dots(g, rnd, at, 150, 1, 2, "rgba(255,255,255,.12)") }),
    heath:   tile((g, rnd, at) => { for (let i = 0; i < 12; i++) blob(g, rnd, at, 12 + rnd() * 18, "rgba(110,70,90,.35)") }),
    marsh:   tile((g, rnd, at) => { g.lineWidth = 3; for (let i = 0; i < 60; i++) { g.strokeStyle = i % 2 ? "rgba(200,180,110,.25)" : "rgba(80,100,40,.25)"; const x = rnd() * PATTERN, y = rnd() * PATTERN, l = 20 + rnd() * 20; at(x, y, () => { g.beginPath(); g.moveTo(x, y); g.lineTo(x + l, y + (rnd() - 0.5) * 4); g.stroke() }) } }),
    sand:    tile((g, rnd, at) => { dots(g, rnd, at, 900, 1, 1, "rgba(255,250,235,.12)"); dots(g, rnd, at, 400, 1, 1, "rgba(120,100,70,.10)") }),
    grid:    tile((g) => { g.fillStyle = "rgba(0,0,0,.10)"; for (let i = 0; i < PATTERN; i += 4) { g.fillRect(0, i, PATTERN, 1); g.fillRect(i, 0, 1, PATTERN) } }),
    asphalt: tile((g, rnd, at) => { dots(g, rnd, at, 300, 1, 2, "rgba(255,255,255,.06)"); dots(g, rnd, at, 300, 1, 2, "rgba(0,0,0,.06)") }),
    shrub:   tile((g, rnd, at) => { for (let i = 0; i < 22; i++) blob(g, rnd, at, 7 + rnd() * 9, i % 3 ? "rgba(20,45,15,.30)" : "rgba(150,180,110,.22)") }),
    klinker: tile((g, rnd) => { g.strokeStyle = "rgba(0,0,0,.13)"; g.lineWidth = 1; for (let y = 0; y < PATTERN; y += 6) { g.beginPath(); g.moveTo(0, y); g.lineTo(PATTERN, y); g.stroke(); const off = (y / 6) % 2 ? 0 : 6; for (let x = off; x < PATTERN; x += 12) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 6); g.stroke() } } }),
    gravel:  tile((g, rnd, at) => { dots(g, rnd, at, 700, 1, 2, "rgba(255,250,240,.16)"); dots(g, rnd, at, 500, 1, 2, "rgba(60,50,40,.14)") }),
    grasgrid: tile((g, rnd, at) => { g.fillStyle = "rgba(90,130,60,.30)"; for (let i = 0; i < PATTERN; i += 8) { g.fillRect(0, i, PATTERN, 2); g.fillRect(i, 0, 2, PATTERN) } }),
    bark:    tile((g, rnd, at) => { dots(g, rnd, at, 400, 2, 4, "rgba(70,45,25,.30)"); dots(g, rnd, at, 200, 2, 3, "rgba(150,110,70,.20)") }),
  }
  return Object.fromEntries(Object.entries(patternCanvases).map(([name, c]) => [name, ctx.createPattern(c, "repeat")]))
}

// a transparent PATTERN² canvas; `at(x, y, draw)` repeats a drawing at the eight wrapped positions so the tile has no seam
function tile(draw) {
  const c = document.createElement("canvas")
  c.width = c.height = PATTERN
  const g = c.getContext("2d"), rnd = mulberry32(5)
  const at = (x, y, fn) => { for (const dx of [-PATTERN, 0, PATTERN]) for (const dy of [-PATTERN, 0, PATTERN]) { g.save(); g.translate(dx, dy); fn(); g.restore() } }
  draw(g, rnd, at)
  return c
}

function blob(g, rnd, at, r, color) {
  const x = rnd() * PATTERN, y = rnd() * PATTERN
  at(x, y, () => { const grad = g.createRadialGradient(x, y, 0, x, y, r); grad.addColorStop(0, color); grad.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = grad; g.fillRect(x - r, y - r, 2 * r, 2 * r) })
}

function dots(g, rnd, at, n, min, max, color) {
  g.fillStyle = color
  for (let i = 0; i < n; i++) { const x = rnd() * PATTERN, y = rnd() * PATTERN, s = min + rnd() * (max - min); at(x, y, () => g.fillRect(x, y, s, s)) }
}

// ---- the terrain material: the cover map with a tiling grain multiplied in up close -----------------------------------

let detailTex = null
function detailTexture() {                   // 256², mean grey, seamless: soft blobs and short blade-like strokes; a multiplier, so no colour space
  if (detailTex) return detailTex
  const c = document.createElement("canvas")
  c.width = c.height = 256
  const g = c.getContext("2d"), rnd = mulberry32(11)
  const at = (fn) => { for (const dx of [-256, 0, 256]) for (const dy of [-256, 0, 256]) { g.save(); g.translate(dx, dy); fn(); g.restore() } }
  g.fillStyle = "#808080"; g.fillRect(0, 0, 256, 256)
  for (let i = 0; i < 300; i++) {
    const x = rnd() * 256, y = rnd() * 256, r = 6 + rnd() * 14, light = rnd() > 0.5
    at(() => { const grad = g.createRadialGradient(x, y, 0, x, y, r); grad.addColorStop(0, light ? "rgba(255,255,255,.16)" : "rgba(0,0,0,.16)"); grad.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = grad; g.fillRect(x - r, y - r, 2 * r, 2 * r) })
  }
  g.lineWidth = 1.5
  for (let i = 0; i < 900; i++) {
    const x = rnd() * 256, y = rnd() * 256, a = rnd() * Math.PI, l = 4 + rnd() * 6
    g.strokeStyle = rnd() > 0.5 ? "rgba(255,255,255,.22)" : "rgba(0,0,0,.22)"
    at(() => { g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke() })
  }
  detailTex = new THREE.CanvasTexture(c)
  detailTex.wrapS = detailTex.wrapT = THREE.RepeatWrapping
  detailTex.anisotropy = 4
  return detailTex
}

const groundU = { strength: { value: 0.35 }, repeat: { value: 125 }, fade: { value: new THREE.Vector2(120, 300) } }   // shared by every tile's material

// one function for every tile material, so three compiles the program once
function groundShader(shader) {
  shader.uniforms.detailMap = { value: detailTexture() }
  shader.uniforms.detailStrength = groundU.strength
  shader.uniforms.detailRepeat = groundU.repeat
  shader.uniforms.detailFade = groundU.fade
  shader.fragmentShader = "uniform sampler2D detailMap; uniform float detailStrength, detailRepeat; uniform vec2 detailFade;\n" +
    shader.fragmentShader.replace("#include <map_fragment>", `#include <map_fragment>
      float dk = detailStrength * (1.0 - smoothstep(detailFade.x, detailFade.y, length(vViewPosition)));
      diffuseColor.rgb *= mix(1.0, texture2D(detailMap, vMapUv * detailRepeat).r * 2.0, dk);`)
}

export function groundMaterial(texture) {
  const m = new THREE.MeshStandardMaterial({ map: texture, roughness: 1 })
  m.onBeforeCompile = groundShader
  return m
}

// once per frame: the live knobs into the shared uniforms
export function updateGround(G = T.ground.detail) {
  groundU.strength.value = G.strength
  groundU.repeat.value = G.repeat
  groundU.fade.value.set(G.fadeNear, G.fadeFar)
}

const LIFT = 0.12, MAX_EDGE = 40

// The water surface: rippling normals from a few sine waves, the sky reflected by Fresnel (horizon ↔ zenith from
// DayNight), the sun's glitter, and transparency so the carved bed shows through. One shared material; updateWater()
// feeds it the time and the sky every frame.
const waterMat = new THREE.ShaderMaterial({
  uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    time: { value: 0 }, daylight: { value: 1 }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunColor: { value: new THREE.Color(0xfff2dc) },
    zenith: { value: new THREE.Color(0x4f8fd2) }, horizon: { value: new THREE.Color(0xbfd4e6) }, deep: { value: new THREE.Color(0x14333d) }, shallow: { value: new THREE.Color(0x2f6f78) }
  }]),
  vertexShader: /* glsl */`
    #include <fog_pars_vertex>
    varying vec3 vWorld;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      vec4 mvPosition = viewMatrix * wp;
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }`,
  fragmentShader: /* glsl */`
    #include <fog_pars_fragment>
    uniform float time, daylight;
    uniform vec3 sunDir, sunColor, zenith, horizon, deep, shallow;
    varying vec3 vWorld;
    void main() {
      vec2 p = vWorld.xz;
      // three wave trains; the surface normal follows their slopes
      vec2 k1 = vec2(0.9, 0.35) * 0.9, k2 = vec2(-0.4, 0.8) * 1.8, k3 = vec2(0.25, -1.0) * 3.4;
      float far = smoothstep(20.0, 240.0, distance(cameraPosition, vWorld));   // ripples fade out before they alias into bands
      float a1 = 0.032 * (1.0 - 0.75 * far), a2 = 0.024 * (1.0 - far), a3 = 0.012 * (1.0 - far);
      float c1 = cos(dot(p, k1) + time * 1.2), c2 = cos(dot(p, k2) + time * 1.9), c3 = cos(dot(p, k3) + time * 2.8);
      vec2 slope = a1 * k1 * c1 + a2 * k2 * c2 + a3 * k3 * c3;
      vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
      vec3 V = normalize(cameraPosition - vWorld);
      if (dot(n, V) < 0.0) n = -n;                                 // seen from below
      vec3 R = reflect(-V, n);
      float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
      vec3 sky = mix(horizon, zenith, clamp(R.y * 1.4, 0.0, 1.0));
      vec3 body = mix(deep, shallow, 0.35 + 0.25 * c2) * (0.12 + 0.88 * daylight);
      float glitter = pow(max(dot(R, normalize(sunDir)), 0.0), 220.0);
      vec3 col = mix(body, sky, fres) + sunColor * glitter * 0.8;
      gl_FragColor = vec4(col, 0.62 + 0.34 * fres);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      #include <fog_fragment>
    }`,
  transparent: true, fog: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2
})
waterMat.__shared = true

// darkness / sky / sun from DayNight.env, once per frame
export function updateWater(env, t) {
  const u = waterMat.uniforms
  u.time.value = t
  u.daylight.value = 1 - env.darkness
  u.sunDir.value.copy(env.sunDir); u.sunColor.value.copy(env.sunColor)
  u.zenith.value.copy(env.zenith); u.horizon.value.copy(env.horizon)
}

// Water polygons → surfaces: flat at their level over the carved bed, or draped just above the terrain for thin
// watercourses (level null).
export function buildWater(cover, heightAt, origin) {
  const [ox, oz] = origin
  const geos = []
  for (const entry of cover) {
    if (entry[0] !== WATER) continue
    const level = waterLevel(entry)
    const rings = []
    for (let r = level === undefined ? 1 : 2; r < entry.length; r++) {
      const flat = entry[r], ring = []
      for (let i = 0; i + 1 < flat.length; i += 2) ring.push(new THREE.Vector2(ox + flat[i] / 10, oz + flat[i + 1] / 10))
      if (ring.length >= 3) rings.push(ring)
    }
    if (!rings.length) continue
    let tris
    try { tris = THREE.ShapeUtils.triangulateShape(rings[0], rings.slice(1)) } catch { continue }
    const pts = rings.flat()
    const verts = []
    if (level === null || level === undefined) {
      const push = (p) => verts.push(p.x, heightAt(p.x, p.y) + LIFT, p.y)
      for (const [a, b, c] of tris) subdivide(pts[a], pts[b], pts[c], push, 0)
    } else {
      for (const [a, b, c] of tris) for (const i of [a, b, c]) verts.push(pts[i].x, level + 0.02, pts[i].y)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3))
    geos.push(g)
  }
  if (!geos.length) return null
  const merged = mergeGeometries(geos, false)
  geos.forEach((g) => g.dispose())
  const mesh = new THREE.Mesh(merged, waterMat)
  mesh.renderOrder = 5
  return mesh
}

// the level slot of a water entry: a number (flat surface), null (draped), or undefined for tiles built before levels existed
function waterLevel(entry) {
  if (entry[0] !== WATER) return undefined
  return Array.isArray(entry[1]) ? undefined : entry[1]
}

// split long triangles so wide water follows the terrain instead of cutting through it
function subdivide(a, b, c, push, depth) {
  const ab = a.distanceTo(b), bc = b.distanceTo(c), ca = c.distanceTo(a)
  const longest = Math.max(ab, bc, ca)
  if (longest < MAX_EDGE || depth > 6) { push(a); push(b); push(c); return }
  if (longest === ab) { const m = a.clone().lerp(b, 0.5); subdivide(a, m, c, push, depth + 1); subdivide(m, b, c, push, depth + 1) }
  else if (longest === bc) { const m = b.clone().lerp(c, 0.5); subdivide(a, b, m, push, depth + 1); subdivide(a, m, c, push, depth + 1) }
  else { const m = c.clone().lerp(a, 0.5); subdivide(a, b, m, push, depth + 1); subdivide(m, b, c, push, depth + 1) }
}

function hash(ring) {
  let h = 2166136261
  for (let i = 0; i < Math.min(ring.length, 12); i++) h = Math.imul(h ^ ring[i], 16777619)
  return h >>> 0
}
