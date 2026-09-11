import * as THREE from "three"
import { TUNING as T, hash32, mulberry32 } from "game/Tuning"
import { nearRoad } from "game/ChunkManager"

// What grows on the ground, in two layers. Bushes and the reeds along the water are placed per tile when the tile
// arrives: they read from far away and there are few of them. The grass itself is a carpet of crossed-quad tufts in
// a window of cells that follows the car — a 500 m tile is far too big to cover in grass at a density anyone would
// notice, so the tufts live where the player is looking and fade out at the rim. Both layers are pure functions of
// position (the cell or the tile key seeds the RNG, the grid runs in a fixed order), so every player sees the same
// ground. Bushes squash on this screen when a grounded car drives through one; nothing is told to the server.
const ID_N = 512, BLOCKED = 31                         // the class raster: one cell per metre, 31 marks a building footprint
const SHRUB_BED = new Set([ 2, 4 ])                     // heesters and bosplantsoen: urban green that is really a bush bed
const URBAN = new Set(["stad", "woonwijk", "dorp"])
const CELL_PX = 128, ATLAS_W = 512, ATLAS_H = 256, MARGIN = 4
const KINDS = ["grass", "dry", "flower", "heather", "reed", "dune", "fern"]
const HEIGHT = { grass: [0.5, 0.85], dry: [0.45, 0.8], flower: [0.55, 0.9], heather: [0.35, 0.55], reed: [1.5, 2.1], dune: [0.6, 1.0], fern: [0.6, 0.95] }
const LOOK = {                                          // dark root, light tip, blades, relative height
  grass: ["#41702f", "#79a845", 11, 0.8], dry: ["#8a7c44", "#b8a566", 10, 0.75], flower: ["#41702f", "#77a244", 11, 0.7],
  heather: ["#55663a", "#8a6f8a", 12, 0.5], reed: ["#66753a", "#b0a065", 5, 1.0], dune: ["#94996a", "#d8d4aa", 12, 0.85], fern: ["#37622b", "#5a8a39", 6, 0.75],
}
const BUSH_GREENS = [0x3f6b2f, 0x4a7a35, 0x557f3c, 0x6b8a3a]
const CELL_U = CELL_PX / ATLAS_W, CELL_V = CELL_PX / ATLAS_H, MU = MARGIN / ATLAS_W, MV = MARGIN / ATLAS_H
const CELL_UV = {}                                      // kind → the cell's lower-left corner in texture space
KINDS.forEach((kind, i) => { CELL_UV[kind] = [(i % 4) * CELL_U, 1 - (Math.floor(i / 4) + 1) * CELL_V] })

// ---- the tuft atlas ----------------------------------------------------------------------------------------------

let atlas = null
function tuftAtlas() {
  if (atlas) return atlas
  const c = document.createElement("canvas")
  c.width = ATLAS_W; c.height = ATLAS_H
  const ctx = c.getContext("2d", { willReadFrequently: true }), rnd = mulberry32(23)
  KINDS.forEach((kind, i) => paintTuft(ctx, (i % 4) * CELL_PX, Math.floor(i / 4) * CELL_PX, kind, rnd))
  // the transparent texels get the kind's own green: a canvas stores them black, and the mipmaps would bleed that
  // darkness into every blade seen from more than a few metres away. Canvas keeps colours premultiplied, so the
  // pixels have to be repaired by hand and handed to a data texture, rows flipped the way the UVs expect.
  const px = ctx.getImageData(0, 0, ATLAS_W, ATLAS_H).data
  KINDS.forEach((kind, i) => {
    const [dark, light] = LOOK[kind], x0 = (i % 4) * CELL_PX, y0 = Math.floor(i / 4) * CELL_PX
    const rgb = [1, 3, 5].map((k) => (parseInt(dark.slice(k, k + 2), 16) + parseInt(light.slice(k, k + 2), 16)) >> 1)
    for (let y = y0; y < y0 + CELL_PX; y++) for (let x = x0; x < x0 + CELL_PX; x++) {
      const o = (y * ATLAS_W + x) * 4
      if (px[o + 3] === 0) { px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2] }
    }
  })
  const flipped = new Uint8ClampedArray(px.length)
  for (let y = 0; y < ATLAS_H; y++) flipped.set(px.subarray((ATLAS_H - 1 - y) * ATLAS_W * 4, (ATLAS_H - y) * ATLAS_W * 4), y * ATLAS_W * 4)
  atlas = new THREE.DataTexture(flipped, ATLAS_W, ATLAS_H)
  atlas.colorSpace = THREE.SRGBColorSpace
  atlas.generateMipmaps = true
  atlas.minFilter = THREE.LinearMipmapLinearFilter
  atlas.magFilter = THREE.LinearFilter
  atlas.anisotropy = 4
  atlas.needsUpdate = true
  atlas.__shared = true
  c.width = 0
  return atlas
}

// a fan of tapered blades, dark at the root and light at the tip, with the kind's extras on top
function paintTuft(ctx, x0, y0, kind, rnd) {
  const [dark, light, blades, tall] = LOOK[kind], cx = x0 + CELL_PX / 2, base = y0 + CELL_PX - 3
  for (let i = 0; i < blades; i++) {
    const spread = (i / (blades - 1) - 0.5) * 80 + (rnd() - 0.5) * 12, h = (80 + rnd() * 40) * tall * (1 - Math.abs(spread) / 160)
    const tipX = cx + spread * 1.15, tipY = base - h, ctlX = cx + spread * 0.5, ctlY = base - h * 0.55, w = kind === "reed" ? 3 : 5 + rnd() * 3
    const g = ctx.createLinearGradient(0, base, 0, tipY); g.addColorStop(0, dark); g.addColorStop(1, light)
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.moveTo(cx + spread * 0.15 - w, base)
    ctx.quadraticCurveTo(ctlX - w * 0.6, ctlY, tipX, tipY)
    ctx.quadraticCurveTo(ctlX + w * 0.6, ctlY, cx + spread * 0.15 + w, base)
    ctx.fill()
    if (kind === "reed") { ctx.fillStyle = "#6b4a2e"; ctx.beginPath(); ctx.ellipse(tipX, tipY + 8, 3, 9, 0, 0, Math.PI * 2); ctx.fill() }
    if (kind === "fern") { ctx.strokeStyle = light; ctx.lineWidth = 2; for (let s = 0.3; s < 0.9; s += 0.15) { const px = cx + spread * 0.15 + (tipX - cx - spread * 0.15) * s, py = base + (tipY - base) * s; ctx.beginPath(); ctx.moveTo(px - 7, py + 3); ctx.lineTo(px + 7, py + 3); ctx.stroke() } }
  }
  if (kind === "flower") for (let i = 0; i < 6; i++) {
    const fx = cx + (rnd() - 0.5) * 60, fy = base - 60 - rnd() * 40
    ctx.strokeStyle = light; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(cx + (fx - cx) * 0.2, base); ctx.quadraticCurveTo(cx + (fx - cx) * 0.4, fy + 20, fx, fy); ctx.stroke()
    ctx.fillStyle = rnd() > 0.5 ? "#f6f2e6" : "#f2d24a"; ctx.beginPath(); ctx.arc(fx, fy, 4.5, 0, Math.PI * 2); ctx.fill()
  }
  if (kind === "heather") { ctx.fillStyle = "#9a5f9c"; for (let i = 0; i < 40; i++) ctx.fillRect(cx + (rnd() - 0.5) * 70, base - 10 - rnd() * 34, 3, 3) }
}

// ---- geometry: two quads crossed at right angles, 0.8 wide and 1 tall, root at y 0 --------------------------------

// normals point up so a tuft is lit like the ground it stands in; the vertex colour darkens the root, which stands
// in for a contact shadow
function crossedQuads(u0, v0, u1, v1, w) {
  const pos = [], uv = [], color = [], normal = [], index = []
  for (const [dx, dz] of [[w, 0], [0, w]]) {
    const b = pos.length / 3
    pos.push(-dx, 0, -dz, dx, 0, dz, dx, 1, dz, -dx, 1, -dz)
    uv.push(u0, v0, u1, v0, u1, v1, u0, v1)
    color.push(0.72, 0.72, 0.72, 0.72, 0.72, 0.72, 1, 1, 1, 1, 1, 1)
    normal.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0)
    index.push(b, b + 1, b + 2, b, b + 2, b + 3)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2))
  g.setAttribute("color", new THREE.Float32BufferAttribute(color, 3))
  g.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3))
  g.setIndex(index)
  return g
}

const tuftGeometries = {}
function tuftGeometry(kind) {                           // one kind baked in, for the per-tile reeds
  if (tuftGeometries[kind]) return tuftGeometries[kind]
  const [cu, cv] = CELL_UV[kind]
  const g = crossedQuads(cu + MU, cv + MV, cu + CELL_U - MU, cv + CELL_V - MV, kind === "reed" ? 0.28 : 0.4)
  g.__shared = true
  return tuftGeometries[kind] = g
}

function nearGeometry(cap) {                            // the carpet: the atlas cell comes per instance
  const g = crossedQuads(MU, MV, CELL_U - MU, CELL_V - MV, 0.4)
  g.setAttribute("aCell", new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2))
  return g
}

// ---- materials ---------------------------------------------------------------------------------------------------

// Wind bends the tip with the square of the height so roots stay pinned; a second harmonic keeps whole fields from
// breathing in unison. Two fixes for billboards: the alpha is boosted with distance, since mipmapping thins the
// blades to nothing a few metres out, and a double-sided material flips the normal on back faces, which would light
// half the blades from below (black), so the up normal goes back.
const swayTime = { value: 0 }, swayAmp = { value: 0.18 }, swaySpeed = { value: 1.7 }
const nearFade = { value: new THREE.Vector2(38, 48) }, wake = { value: new THREE.Vector3(2.6, 0.55, 0) }, carAt = { value: new THREE.Vector2() }
const SWAY = `
  #ifdef USE_INSTANCING
    vec2 rootXZ = instanceMatrix[3].xz;
  #else
    vec2 rootXZ = vec2(0.0);
  #endif
  float swayPh = time * swaySpeed + rootXZ.x * 0.8 + rootXZ.y * 0.6;
  float sway = position.y * position.y * swayAmp * (sin(swayPh) + 0.35 * sin(swayPh * 2.3 + 1.0));
  transformed.x += sway; transformed.z += sway * 0.6;`

function patchTuft(shader, carpet) {
  shader.uniforms.time = swayTime; shader.uniforms.swayAmp = swayAmp; shader.uniforms.swaySpeed = swaySpeed
  let head = "uniform float time, swayAmp, swaySpeed;\n", body = SWAY
  if (carpet) {
    shader.uniforms.nearFade = nearFade; shader.uniforms.wake = wake; shader.uniforms.carAt = carAt
    head += "uniform vec2 nearFade, carAt;\nuniform vec3 wake;\nattribute vec2 aCell;\n"
    body += `
      transformed *= 1.0 - smoothstep(nearFade.x, nearFade.y, distance(cameraPosition.xz, rootXZ));
      vec2 away = rootXZ - carAt;
      float run = 1.0 - smoothstep(wake.x * 0.35, wake.x, length(away));
      transformed.xz += normalize(away + vec2(1e-4, 0.0)) * wake.y * run * position.y;
      transformed.y *= 1.0 - 0.5 * run;`
  }
  shader.vertexShader = head + shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>" + body)
  if (carpet) shader.vertexShader = shader.vertexShader.replace("#include <uv_vertex>", "#include <uv_vertex>\n  vMapUv += aCell;")
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <normal_fragment_begin>", "#include <normal_fragment_begin>\n  normal = normalize( vNormal );")
    .replace("#include <alphatest_fragment>", "diffuseColor.a = min(1.0, diffuseColor.a * (1.0 + 0.05 * length(vViewPosition)));\n  #include <alphatest_fragment>")
}

function tuftMaterial(carpet) {
  const m = new THREE.MeshStandardMaterial({ map: tuftAtlas(), alphaTest: 0.35, alphaToCoverage: true, side: THREE.DoubleSide, vertexColors: true, roughness: 1 })
  m.onBeforeCompile = carpet ? (shader) => { patchTuft(shader, true); m.userData.shader = shader } : (shader) => { patchTuft(shader, false); m.userData.shader = shader }
  m.__shared = true
  return m
}
let reedMat = null
const reedMaterial = () => reedMat ??= tuftMaterial(false)

// ---- bushes: a few squashed blobs each, flat shaded ---------------------------------------------------------------

const bushMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 })
bushMat.__shared = true
const bushGeometries = [0, 1, 2, 3].map((v) => bushVariant(400 + 13 * v, v === 3))

function bushVariant(seed, berries) {
  const rnd = mulberry32(seed), pos = [], col = [], c = new THREE.Color()
  const blobs = 2 + (rnd() < 0.5 ? 1 : 0)
  for (let b = 0; b < blobs; b++) {
    const s = 0.45 + rnd() * 0.3, ox = (rnd() - 0.5) * 0.7, oz = (rnd() - 0.5) * 0.7, oy = 0.35 + rnd() * 0.25
    const g = new THREE.IcosahedronGeometry(1, 0).scale(s, s * 0.8, s).translate(ox, oy, oz)
    const p = g.attributes.position, base = new THREE.Color(BUSH_GREENS[Math.floor(rnd() * BUSH_GREENS.length)])
    for (let f = 0; f < p.count; f += 3) {
      c.copy(base).multiplyScalar(0.85 + rnd() * 0.3)
      if (berries && rnd() < 0.12) c.setHex(0xb8302a)
      for (let k = 0; k < 3; k++) { pos.push(p.getX(f + k), p.getY(f + k), p.getZ(f + k)); col.push(c.r, c.g, c.b) }
    }
    g.dispose()
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3))
  g.computeVertexNormals()
  g.__shared = true
  return g
}

// ---- the class raster: which land cover is under (x, z), 0 where nothing grows -----------------------------------

function rasterIds(tile) {
  const c = document.createElement("canvas")
  c.width = c.height = ID_N
  const ctx = c.getContext("2d", { willReadFrequently: true })
  const k = ID_N / 5000
  for (let e = 0; e < tile.cover.length; e++) {
    const entry = tile.cover[e], sub = tile.coverSub[e] ?? 0
    const code = entry[0] === 3 && SHRUB_BED.has(sub) ? 9 : entry[0]
    const start = entry[0] === 30 && !Array.isArray(entry[1]) ? 2 : 1
    ctx.fillStyle = ctx.strokeStyle = `rgb(${code * 8},0,0)`
    ctx.beginPath()
    for (let r = start; r < entry.length; r++) { const ring = entry[r]; ctx.moveTo(ring[0] * k, ring[1] * k); for (let i = 2; i < ring.length; i += 2) ctx.lineTo(ring[i] * k, ring[i + 1] * k); ctx.closePath() }
    ctx.fill("evenodd")
    if (code === 19 || code === 25) { ctx.lineWidth = 1.6; ctx.stroke() }     // hedges and verges are a metre wide: without this they are all edge and nothing survives
  }
  const m = ID_N / tile.terrain.size, { ox, oz } = tile.terrain          // building footprints (game metres) block everything
  ctx.setTransform(m, 0, 0, m, -ox * m, -oz * m)
  ctx.fillStyle = `rgb(${BLOCKED * 8},0,0)`
  for (const h of tile.objects.values()) if (h.rings) { ctx.beginPath(); for (const ring of h.rings) { ctx.moveTo(ring[0], ring[1]); for (let i = 2; i < ring.length; i += 2) ctx.lineTo(ring[i], ring[i + 1]); ctx.closePath() } ctx.fill("evenodd") }
  const px = ctx.getImageData(0, 0, ID_N, ID_N).data, ids = new Uint8Array(ID_N * ID_N)
  for (let i = 0; i < ids.length; i++) { const v = px[i * 4]; ids[i] = v & 7 ? 0 : v >> 3 }   // blended edge texels miss the ×8 lattice: nothing grows there
  c.width = 0
  return ids
}

function codeAt(entry, x, z) {
  const t = entry.tile.terrain, u = (x - t.ox) * ID_N / t.size | 0, v = (z - t.oz) * ID_N / t.size | 0
  return u < 0 || v < 0 || u >= ID_N || v >= ID_N ? 0 : entry.ids[v * ID_N + u]
}

const margin = (cls, tile) => cls.margin ?? (URBAN.has(tile.biome) ? T.ground.urbanMargin : T.ground.roadMargin)

// ---- per tile: bushes, and reeds along the water ------------------------------------------------------------------

function placeBushes(tile, ids, P = T.ground) {
  const rnd = mulberry32(hash32(`${tile.key}|struik`)), { ox, oz, size } = tile.terrain, entry = { tile, ids }
  const texel = size / ID_N, bushes = [], hedges = []
  for (const [codeStr, cls] of Object.entries(P.classes)) {
    if (!cls.bush) continue
    const code = +codeStr
    const take = (px, pz, r1, r2, r3, r4) => {
      if (nearRoad(tile.roadIndex, px, pz, margin(cls, tile))) return
      ;(cls.hedge ? hedges : bushes).push({ x: px, z: pz, v: cls.hedge ? 1 + Math.floor(r1 * 2) : Math.floor(r1 * 4), r: (cls.hedge ? 0.5 : 0.6) + (cls.hedge ? 0.25 : 0.5) * r2,
                    tall: cls.hedge ? 1.4 : 0.9, spin: r3 * Math.PI * 2, tint: cls.hedge ? 0.8 + 0.1 * r4 : 0.85 + 0.3 * r4, gorse: !!cls.gorse })
    }
    if (cls.bush < 4) {                                   // a hedge is a metre wide: walk the raster instead of the tile
      for (let v = 0; v < ID_N; v++) for (let u = 0; u < ID_N; u++) {
        if (ids[v * ID_N + u] !== code) continue
        const r0 = rnd(), r1 = rnd(), r2 = rnd(), r3 = rnd(), r4 = rnd(), r5 = rnd()
        if (r0 * cls.bush > texel * texel) continue
        take(ox + (u + r5) * texel, oz + (v + r1) * texel, r2, r3, r4, r0)
      }
    } else {
      const cell = Math.sqrt(cls.bush)
      for (let z = oz + cell * rnd(); z < oz + size; z += cell) for (let x = ox + cell * rnd(); x < ox + size; x += cell) {
        const px = x + (rnd() - 0.5) * cell * 0.9, pz = z + (rnd() - 0.5) * cell * 0.9, r1 = rnd(), r2 = rnd(), r3 = rnd(), r4 = rnd()
        if (codeAt(entry, px, pz) === code) take(px, pz, r1, r2, r3, r4)
      }
    }
  }
  return thin(bushes, P.bushCap).concat(thin(hedges, P.hedgeCap))   // a hedge row must not eat the tile's other bushes
}

function placeReeds(tile, ids, P = T.ground) {
  const rnd = mulberry32(hash32(`${tile.key}|riet`)), reeds = [], entry = { tile, ids }
  for (const water of tile.cover) if (water[0] === 30) for (let r = Array.isArray(water[1]) ? 1 : 2; r < water.length; r++) {
    const ring = water[r], { ox, oz } = tile.terrain, R = P.reeds
    for (let i = 0; i < ring.length; i += 2) {
      const j = (i + 2) % ring.length
      const ax = ox + ring[i] / 10, az = oz + ring[i + 1] / 10, bx = ox + ring[j] / 10, bz = oz + ring[j + 1] / 10
      const len = Math.hypot(bx - ax, bz - az)
      if (len < 0.5) continue
      const nx = -(bz - az) / len, nz = (bx - ax) / len
      for (let d = R.spacing * rnd(); d < len; d += R.spacing * (0.7 + 0.6 * rnd())) {
        const t = d / len, x = ax + (bx - ax) * t, z = az + (bz - az) * t, off = R.offsetMin + (R.offsetMax - R.offsetMin) * rnd()
        const s = 0.8 + 0.4 * rnd(), spin = rnd() * Math.PI, tint = 0.85 + 0.3 * rnd()
        for (const side of [1, -1]) {                                   // whichever bank is land
          const px = x + nx * off * side, pz = z + nz * off * side, code = codeAt(entry, px, pz)
          if (code === 0 || code === 30 || code >= 20 || nearRoad(tile.roadIndex, px, pz, 0.5)) continue
          reeds.push({ x: px, z: pz, s, spin, tint })
          break
        }
      }
    }
  }
  return thin(reeds, P.bushCap * 2)
}

// over the cap, keep an even spread rather than the first ones the grid happened to reach
const thin = (list, cap) => list.length <= cap ? list : Array.from({ length: cap }, (_, i) => list[Math.floor(i * list.length / cap)])

// ---- the scatter itself -------------------------------------------------------------------------------------------

const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _c = new THREE.Color()
const _zero = new THREE.Matrix4().makeScale(0, 0, 0)
const mod = (a, n) => ((a % n) + n) % n

export class Scatter {
  constructor(scene, effects, world) {
    this.scene = scene
    this.effects = effects
    this.world = world                       // { heightAt, tileIndex }
    this.tiles = new Map()                   // key → { key, tile, ids, group, bushes }
    this.queue = []
    this.stats = []                          // build times of the last tiles, for the console
    this.carpet = null                       // the grass around the car
    this.cells = []                          // slot block → cell key
  }

  addTile(tile) { this.queue.push(tile) }

  dropTile(tile) {
    const entry = this.tiles.get(tile.key)
    this.tiles.delete(tile.key)
    const i = this.queue.indexOf(tile)
    if (i >= 0) this.queue.splice(i, 1)
    if (entry) this.forget(tile)
  }

  update(dt, t, car) {
    const G = T.ground
    swayTime.value = t; swayAmp.value = G.sway.amp; swaySpeed.value = G.sway.speed
    nearFade.value.set(G.near.fadeStart, G.near.fadeEnd)
    wake.value.set(G.wake.radius, G.wake.push, 0)
    carAt.value.set(car.x, car.z)
    if (this.queue.length) this.buildTile(this.queue.shift())
    this.grow(car, G.near)
  }

  buildTile(tile) {
    const t0 = performance.now()
    const ids = rasterIds(tile)
    const group = new THREE.Group(), kept = []
    const bushes = placeBushes(tile, ids), reeds = placeReeds(tile, ids)
    for (const [v, list] of Map.groupBy(bushes, (b) => b.v)) {
      const mesh = new THREE.InstancedMesh(bushGeometries[v], bushMat, list.length)
      list.forEach((b, i) => {
        b.y = this.world.heightAt(b.x, b.z) - 0.05
        mesh.setMatrixAt(i, _m.compose(_p.set(b.x, b.y, b.z), _q.setFromAxisAngle(_up, b.spin), _s.set(b.r, b.r * b.tall, b.r)))
        mesh.setColorAt(i, b.gorse ? _c.setRGB(0.95 * b.tint, b.tint, 0.55 * b.tint) : _c.setScalar(b.tint))
        kept.push({ x: b.x, y: b.y, z: b.z, r: b.r, tall: b.tall, spin: b.spin, mesh, i, flat: false })
      })
      mesh.instanceMatrix.needsUpdate = mesh.instanceColor.needsUpdate = true
      mesh.computeBoundingSphere()
      group.add(mesh)
    }
    if (reeds.length) {
      const mesh = new THREE.InstancedMesh(tuftGeometry("reed"), reedMaterial(), reeds.length), [h0, h1] = HEIGHT.reed
      reeds.forEach((r, i) => {
        mesh.setMatrixAt(i, _m.compose(_p.set(r.x, this.world.heightAt(r.x, r.z) - 0.05, r.z), _q.setFromAxisAngle(_up, r.spin), _s.set(r.s, h0 + (h1 - h0) * (r.s - 0.8) / 0.4, r.s)))
        mesh.setColorAt(i, _c.setScalar(r.tint))
      })
      mesh.instanceMatrix.needsUpdate = mesh.instanceColor.needsUpdate = true
      mesh.computeBoundingSphere()
      group.add(mesh)
    }
    tile.group.add(group)
    this.tiles.set(tile.key, { key: tile.key, tile, ids, group, bushes: kept })
    this.forget(tile)                                    // grass cells over this tile were grown without it
    this.stats.push(Math.round((performance.now() - t0) * 10) / 10)
    if (this.stats.length > 30) this.stats.shift()
  }

  // ---- the grass carpet: a window of cells that scrolls with the car ----------------------------------------------

  // Cell (cx, cz) always owns the same block of instances: the window is smaller than the wrap, so a cell scrolling
  // in overwrites one that scrolled out. No allocation, no gaps, and a cell keeps its slots while it is in view.
  grow(car, N) {
    const side = N.radius * 2 + 1, cap = side * side * N.perCell
    if (!this.carpet || this.carpet.count !== cap) this.plant(cap, side)
    const ccx = Math.floor(car.x / N.cell), ccz = Math.floor(car.z / N.cell)
    const stale = []
    for (let dz = -N.radius; dz <= N.radius; dz++) for (let dx = -N.radius; dx <= N.radius; dx++) {
      const cx = ccx + dx, cz = ccz + dz, block = mod(cx, side) * side + mod(cz, side), key = `${cx},${cz}`
      if (this.cells[block] !== key) stale.push([dx * dx + dz * dz, cx, cz, block, key])
    }
    if (!stale.length) return
    stale.sort((a, b) => a[0] - b[0])
    for (const [, cx, cz, block, key] of stale.slice(0, N.perFrame)) { this.growCell(cx, cz, block, N); this.cells[block] = key }
  }

  plant(cap, side) {
    if (this.carpet) { this.scene.remove(this.carpet); this.carpet.geometry.dispose() }
    const mesh = new THREE.InstancedMesh(nearGeometry(cap), this.carpetMat ??= tuftMaterial(true), cap)
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3)
    for (let i = 0; i < cap; i++) mesh.setMatrixAt(i, _zero)
    mesh.frustumCulled = false                           // it lives around the camera anyway
    mesh.renderOrder = 1
    this.scene.add(mesh)
    this.carpet = mesh
    this.cells = new Array(side * side).fill(null)
  }

  growCell(cx, cz, block, N) {
    const mesh = this.carpet, cells = mesh.geometry.attributes.aCell, base = block * N.perCell
    const rnd = mulberry32(hash32(`${cx},${cz}|gras`))
    const g = Math.ceil(Math.sqrt(N.perCell)), step = N.cell / g, area = step * step
    let n = 0
    for (let j = 0; j < g && n < N.perCell; j++) for (let i = 0; i < g && n < N.perCell; i++) {
      const x = cx * N.cell + (i + rnd()) * step, z = cz * N.cell + (j + rnd()) * step
      const r1 = rnd(), r2 = rnd(), r3 = rnd(), r4 = rnd(), r5 = rnd()    // always drawn: a client missing this tile stays in step
      const [tx, ty] = this.world.tileIndex(x, z), entry = this.tiles.get(`${tx}_${ty}`)
      if (!entry) continue
      const cls = T.ground.classes[codeAt(entry, x, z)]
      if (!cls?.dens || r1 * cls.dens > area || nearRoad(entry.tile.roadIndex, x, z, margin(cls, entry.tile))) continue
      const kind = cls.mix[Math.floor(r2 * cls.mix.length)], [h0, h1] = HEIGHT[kind], w = 0.75 + 0.5 * r3
      const slot = base + n++
      mesh.setMatrixAt(slot, _m.compose(_p.set(x, this.world.heightAt(x, z) - 0.05, z), _q.setFromAxisAngle(_up, r4 * Math.PI), _s.set(w, h0 + (h1 - h0) * r3, w)))
      mesh.setColorAt(slot, _c.setRGB(0.9 + 0.2 * r5, 0.88 + 0.24 * r5, 0.86 + 0.2 * r5))
      cells.setXY(slot, CELL_UV[kind][0], CELL_UV[kind][1])
    }
    for (let i = n; i < N.perCell; i++) mesh.setMatrixAt(base + i, _zero)
    mesh.instanceMatrix.addUpdateRange(base * 16, N.perCell * 16); mesh.instanceMatrix.needsUpdate = true
    mesh.instanceColor.addUpdateRange(base * 3, N.perCell * 3); mesh.instanceColor.needsUpdate = true
    cells.addUpdateRange(base * 2, N.perCell * 2); cells.needsUpdate = true
  }

  // a tile arrived or left: the grass grown over it has to be grown again
  forget(tile) {
    const N = T.ground.near, { ox, oz, size } = tile.terrain
    for (let b = 0; b < this.cells.length; b++) {
      const key = this.cells[b]
      if (!key) continue
      const [cx, cz] = key.split(",")
      const x = (+cx + 0.5) * N.cell, z = (+cz + 0.5) * N.cell
      if (x >= ox && x < ox + size && z >= oz && z < oz + size) this.cells[b] = null
    }
  }

  // a grounded car driving through a bush squashes it once, with a few leafy puffs; nothing leaves this screen
  flatten(car) {
    if (car.vy !== null) return
    const F = T.ground.flatten, [cx, cy] = this.world.tileIndex(car.x, car.z)
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const e = this.tiles.get(`${cx + dx}_${cy + dy}`)
      if (!e) continue
      for (const b of e.bushes) {
        if (b.flat) continue
        const ddx = b.x - car.x, ddz = b.z - car.z
        if (Math.abs(ddx) > 3 || Math.abs(ddz) > 3 || ddx * ddx + ddz * ddz > (b.r + F.pad) ** 2) continue
        b.flat = true
        b.mesh.setMatrixAt(b.i, _m.compose(_p.set(b.x, b.y, b.z), _q.setFromAxisAngle(_up, b.spin), _s.set(b.r * F.squashXZ, b.r * F.squashY, b.r * F.squashXZ)))
        b.mesh.instanceMatrix.addUpdateRange(b.i * 16, 16)
        b.mesh.instanceMatrix.needsUpdate = true
        for (let k = 0; k < F.puffs; k++) this.effects.smoke.emit(b.x + (Math.random() - 0.5) * b.r, b.y + b.r * 0.7, b.z + (Math.random() - 0.5) * b.r,
          car.vx * 0.25 + (Math.random() - 0.5) * 1.5, 1.2 + Math.random(), car.vz * 0.25 + (Math.random() - 0.5) * 1.5, 0.5, 0.5, 1.4, 0.45, F.puffColor)
      }
    }
  }
}
