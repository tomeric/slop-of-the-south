import * as THREE from "three"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"
import { pointKey, collapseRange } from "game/Destructibles"
import { noOutline } from "game/Outline"

// NDW traffic signs drawn from the RVV sign catalogue. Every sign face is painted procedurally on a canvas from its RVV
// code (A1 speed limit, B6 yield, G11 cycle path …) plus the value on it (black code) or its text, cached per look.
// Tile entries: [x, z, face, code, black?, text?] with face the compass direction the sign face points to. Signs at the
// same spot share a pole and hang below each other (main sign at 2.3 m, onderborden beneath). With `reg` every pole
// registers one destructible handle carrying the keys of all its signs; knocking it down collapses every part.
const RED = "#c8102e", BLUE = "#0d4f9e", WHITE = "#f4f4f0", YELLOW = "#f7c600", BLACK = "#111111", GREY = "#8c8c8c", GREEN = "#1a8a3a"
const FONT = "Arial, Helvetica, sans-serif"

const poleMat = Object.assign(new THREE.MeshStandardMaterial({ color: 0x9a9a98, roughness: 0.6, metalness: 0.3 }), { __shared: true })
const backMat = Object.assign(new THREE.MeshStandardMaterial({ color: 0x7d7f80, roughness: 0.7, metalness: 0.4 }), { __shared: true })
const materials = new Map()

export function buildSigns(signs, heightAt, reg) {
  if (!signs?.length) return null
  // group signs on one pole: same spot (60 cm), main signs first so onderborden hang below them
  const sorted = [...signs].sort((a, b) => rank(a[3]) - rank(b[3]))
  const poles = []
  for (const s of sorted) {
    let pole = poles.find((p) => Math.hypot(p.x - s[0], p.z - s[1]) < 0.6)
    if (!pole) { pole = { x: s[0], z: s[1], face: s[2], list: [] }; poles.push(pole) }
    pole.list.push(s)
  }
  const byMat = new Map(), handles = []
  const add = (mat, geo) => { if (!byMat.has(mat)) byMat.set(mat, []); byMat.get(mat).push(geo); return { mat, idx: byMat.get(mat).length - 1 } }
  for (const pole of poles) {
    const parts = []
    const base = heightAt(pole.x, pole.z)
    const rotY = Math.PI - pole.face * Math.PI / 180              // plane normal → compass `face`
    const nx = Math.sin(pole.face * Math.PI / 180), nz = -Math.cos(pole.face * Math.PI / 180)
    let top = null, y = 2.3
    for (const [, , , code, black, text] of pole.list) {
      const look = lookOf(code, black, text)
      if (!look) continue
      const { w, h } = look
      if (top === null) top = y + h / 2
      else y -= h / 2
      const face = new THREE.PlaneGeometry(w, h)
      face.rotateY(rotY); face.translate(pole.x + nx * 0.05, base + y, pole.z + nz * 0.05)
      parts.push(add(material(look), face))
      const back = new THREE.PlaneGeometry(w, h)
      back.rotateY(rotY + Math.PI); back.translate(pole.x + nx * 0.03, base + y, pole.z + nz * 0.03)
      parts.push(add(backMat, back))
      y -= h / 2 + 0.06
    }
    if (top === null) continue
    const pg = new THREE.CylinderGeometry(0.035, 0.04, top, 6)
    pg.translate(pole.x, base + top / 2, pole.z)
    parts.push(add(poleMat, pg))
    handles.push({ pole, parts })
  }
  if (!byMat.size) return null
  const group = new THREE.Group(), merged = new Map()
  for (const [mat, geos] of byMat) {
    const starts = [], counts = []
    for (const g of geos) { starts.push(starts.length ? starts.at(-1) + counts.at(-1) : 0); counts.push(g.attributes.position.count) }
    const geo = mergeGeometries(geos, false); geos.forEach((g) => g.dispose())
    group.add(new THREE.Mesh(geo, mat))
    merged.set(mat, { geo, starts, counts })
  }
  if (reg) for (const { pole, parts } of handles) {
    let removed = false
    const remove = () => { if (removed) return; removed = true; for (const { mat, idx } of parts) { const m = merged.get(mat); collapseRange(m.geo.attributes.position, m.starts[idx], m.counts[idx]) } }
    const keys = [...new Set(pole.list.map((s) => pointKey("s", s[0], s[1])))]
    reg(keys[0], { kind: "s", keys, x: pole.x, z: pole.z, r: 0.3, h: 2.5, max: 6, remove })
  }
  return group
}

function rank(code) { return code.startsWith("OB") ? 1 : 0 }

// sign sheeting is retro-reflective: faces stay readable in the dark
export function setSignsNight(d) { for (const m of materials.values()) m.emissiveIntensity = 0.45 * d }

function material(look) {
  if (materials.has(look.key)) return materials.get(look.key)
  const tex = new THREE.CanvasTexture(look.canvas)
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4
  // one material per sign face, so hundreds of them; an outline around each would double that many draw calls for
  // a flat quad usually seen edge-on. The poles keep theirs.
  const mat = noOutline(Object.assign(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, metalness: 0.05, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0 }), { __shared: true }))   // opaque canvases: keep them out of the sorted transparent pass
  materials.set(look.key, mat)
  return mat
}

// ---- the catalogue ---------------------------------------------------------------------------------------------

const looks = new Map()
// { key, canvas, w, h } for a sign, or null for signs we don't draw
function lookOf(code, black, text) {
  const key = `${code}|${black ?? ""}|${text ?? ""}`
  if (looks.has(key)) return looks.get(key)
  const look = paint(code, black ?? "", text ?? "")
  if (look) look.key = key
  looks.set(key, look)
  return look
}

function paint(code, black, text) {
  const wide = /^(H|K|OB)/.test(code) || (/^A[1-3]/.test(code) && /zone/.test(black)) || /^E1[0-3]|^E9/.test(code)
  const c = document.createElement("canvas"); c.width = wide ? 256 : 128; c.height = 128
  const ctx = c.getContext("2d")
  const W = c.width, H = c.height, cx = W / 2, cy = H / 2
  const g = glyphs(ctx)
  // shapes
  const disc = (fill, ring, rw = 12) => { ctx.beginPath(); ctx.arc(cx, cy, 60, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); if (ring) { ctx.lineWidth = rw; ctx.strokeStyle = ring; ctx.beginPath(); ctx.arc(cx, cy, 60 - rw / 2, 0, Math.PI * 2); ctx.stroke() } }
  const square = (fill, r = 10) => { ctx.fillStyle = fill; roundRect(ctx, 4, 4, W - 8, H - 8, r); ctx.fill() }
  const triangle = (up = true) => {
    ctx.beginPath()
    if (up) { ctx.moveTo(cx, 6); ctx.lineTo(W - 4, H - 10); ctx.lineTo(4, H - 10) } else { ctx.moveTo(4, 10); ctx.lineTo(W - 4, 10); ctx.lineTo(cx, H - 6) }
    ctx.closePath(); ctx.fillStyle = WHITE; ctx.fill(); ctx.lineWidth = 11; ctx.lineJoin = "round"; ctx.strokeStyle = RED; ctx.stroke()
  }
  const diamond = (inner) => { ctx.beginPath(); ctx.moveTo(cx, 2); ctx.lineTo(W - 2, cy); ctx.lineTo(cx, H - 2); ctx.lineTo(2, cy); ctx.closePath(); ctx.fillStyle = WHITE; ctx.fill()
    ctx.beginPath(); ctx.moveTo(cx, 18); ctx.lineTo(W - 18, cy); ctx.lineTo(cx, H - 18); ctx.lineTo(18, cy); ctx.closePath(); ctx.fillStyle = inner; ctx.fill() }
  const octagon = () => { ctx.beginPath(); for (let i = 0; i < 8; i++) { const a = Math.PI / 8 + i * Math.PI / 4; ctx.lineTo(cx + 62 * Math.cos(a), cy + 62 * Math.sin(a)) } ctx.closePath(); ctx.fillStyle = RED; ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = WHITE; ctx.stroke() }
  const slash = (color = RED, w = 10) => { ctx.strokeStyle = color; ctx.lineWidth = w; ctx.lineCap = "butt"; ctx.beginPath(); ctx.moveTo(cx - 38, cy - 38); ctx.lineTo(cx + 38, cy + 38); ctx.stroke() }
  const cross = (color = RED, w = 10) => { slash(color, w); ctx.beginPath(); ctx.moveTo(cx + 38, cy - 38); ctx.lineTo(cx - 38, cy + 38); ctx.stroke() }
  const label = (str, size, color = BLACK, y = cy, weight = "bold", maxW = W - 24) => {
    ctx.fillStyle = color; ctx.textAlign = "center"; ctx.textBaseline = "middle"
    let px = size; do { ctx.font = `${weight} ${px}px ${FONT}`; px -= 2 } while (ctx.measureText(str).width > maxW && px > 8)
    ctx.fillText(str, cx, y)
  }
  const lines = (str, size, color, maxLines = 3) => {
    const words = str.split(/\s+/), out = []
    let cur = ""
    ctx.font = `${size}px ${FONT}`
    for (const w of words) { const t = cur ? `${cur} ${w}` : w; if (ctx.measureText(t).width > W - 20 && cur) { out.push(cur); cur = w } else cur = t }
    if (cur) out.push(cur)
    const shown = out.slice(0, maxLines)
    shown.forEach((l, i) => label(l, size, color, cy + (i - (shown.length - 1) / 2) * (size + 4), "normal"))
  }
  const value = black.replace(/\s*zone$/, "")
  const zone = /zone$/.test(black)
  let w = 0.7, h = 0.7
  const family = code.match(/^[A-Z]+\d*/)?.[0] ?? code
  const dirSuffix = code.slice(family.length)                     // l / r / a / b variants

  ctx.clearRect(0, 0, W, H)
  if (zone && /^A[1-3]/.test(code)) {                              // zone sign: white plate with the disc and "zone"
    ctx.fillStyle = WHITE; roundRect(ctx, 2, 2, W - 4, H - 4, 8); ctx.fill()
    ctx.save(); ctx.translate(-56, 0); disc(WHITE, RED, 11); label(value, 54, BLACK, cy, "bold", 84); ctx.restore()
    label("zone", 40, BLACK, cy, "bold", 100); ctx.save(); ctx.translate(60, 0); ctx.restore()
    ctx.fillStyle = BLACK; ctx.font = `bold 40px ${FONT}`; ctx.textAlign = "left"; ctx.fillText("zone", cx + 12, cy)
    ctx.clearRect(cx - 4, 0, 16, 0)
    w = 1.2; h = 0.6
    return finish(c, w, h)
  }
  switch (family) {
    case "A1": case "A3": disc(WHITE, RED, 11); label(value || "50", 56); break
    case "A2": disc(WHITE, GREY, 6); label(value || "50", 52, "#666"); ctx.strokeStyle = BLACK; ctx.lineWidth = 4; for (const d of [-10, 0, 10]) { ctx.beginPath(); ctx.moveTo(cx - 40 + d, cy + 40); ctx.lineTo(cx + 40 + d, cy - 40); ctx.stroke() } break
    case "A4": case "A5": square(BLUE); label(value || "30", 56, WHITE); break
    case "B1": diamond(YELLOW); break
    case "B2": diamond(YELLOW); ctx.strokeStyle = BLACK; ctx.lineWidth = 12; ctx.beginPath(); ctx.moveTo(cx - 36, cy + 36); ctx.lineTo(cx + 36, cy - 36); ctx.stroke(); break
    case "B3": case "B4": case "B5": triangle(true); ctx.strokeStyle = BLACK; ctx.lineCap = "butt"; ctx.lineWidth = 12; ctx.beginPath(); ctx.moveTo(cx, cy - 8); ctx.lineTo(cx, cy + 40); ctx.stroke(); ctx.lineWidth = 5
      ctx.beginPath(); if (family === "B3") { ctx.moveTo(cx - 24, cy + 14); ctx.lineTo(cx + 24, cy + 14) } else if (family === "B4") { ctx.moveTo(cx, cy + 14); ctx.lineTo(cx + 26, cy + 14) } else { ctx.moveTo(cx, cy + 14); ctx.lineTo(cx - 26, cy + 14) } ctx.stroke(); break
    case "B6": triangle(false); break
    case "B7": octagon(); label("STOP", 40, WHITE); break
    case "C1": disc(WHITE, RED, 11); break
    case "C2": disc(RED); ctx.fillStyle = WHITE; ctx.fillRect(cx - 40, cy - 9, 80, 18); break
    case "C3": square(BLUE); g.arrow(cx, cy, 44, -Math.PI / 2, WHITE, 14); break
    case "C4": square(BLUE); g.arrow(cx, cy, 44, dirSuffix === "l" ? Math.PI : 0, WHITE, 14); break
    case "C6": disc(WHITE, RED, 11); g.car(cx, cy + 4, 70, BLACK); break
    case "C7": case "C7a": case "C7b": disc(WHITE, RED, 11); g.lorry(cx, cy + 2, 70, BLACK); break
    case "C8": case "C9": case "C10": case "C11": case "C12": disc(WHITE, RED, 11); g.car(cx - 14, cy + 6, 50, BLACK); g.bicycle(cx + 18, cy + 4, 46, BLACK); break
    case "C13": case "C14": case "C15": disc(WHITE, RED, 11); g.bicycle(cx, cy + 4, 74, BLACK); break
    case "C16": disc(WHITE, RED, 11); g.pedestrian(cx, cy, 78, BLACK); break
    case "C17": case "C18": case "C19": case "C20": case "C21": disc(WHITE, RED, 11); label(value || "", 34); break
    case "D1": disc(BLUE); g.roundabout(cx, cy, 36, WHITE); break
    case "D2": disc(BLUE); g.arrow(cx + (dirSuffix === "l" ? -6 : 6), cy, 48, dirSuffix === "l" ? Math.PI * 0.75 : Math.PI * 0.25, WHITE, 14); break
    case "D3": disc(BLUE); g.arrow(cx - 18, cy, 42, Math.PI * 0.75, WHITE, 12); g.arrow(cx + 18, cy, 42, Math.PI * 0.25, WHITE, 12); break
    case "D4": disc(BLUE); g.arrow(cx, cy, 48, -Math.PI / 2, WHITE, 14); break
    case "D5": disc(BLUE); g.arrow(cx, cy, 48, dirSuffix === "l" ? Math.PI : 0, WHITE, 14); break
    case "D6": disc(BLUE); g.arrow(cx - 10, cy, 44, -Math.PI / 2, WHITE, 12); g.arrow(cx + 10, cy + 10, 36, dirSuffix === "l" ? Math.PI : 0, WHITE, 12); break
    case "D7": disc(BLUE); g.arrow(cx - 14, cy, 36, Math.PI, WHITE, 12); g.arrow(cx + 14, cy, 36, 0, WHITE, 12); break
    case "E1": disc(BLUE, RED, 11); slash(); break
    case "E2": disc(BLUE, RED, 11); cross(); break
    case "E3": disc(BLUE, RED, 11); g.bicycle(cx, cy + 4, 60, WHITE); slash(); break
    case "E4": case "E5": case "E8": square(BLUE); label("P", 92, WHITE, cy + 2); break
    case "E6": square(BLUE); label("P", 72, WHITE, cy - 10); g.wheelchair(cx + 30, cy + 34, 30, WHITE); break
    case "E7": square(BLUE); g.lorry(cx, cy - 6, 60, WHITE); g.arrow(cx - 30, cy + 40, 24, -Math.PI / 2, WHITE, 6); g.arrow(cx + 30, cy + 40, 24, Math.PI / 2, WHITE, 6); break
    case "E9": w = 1.0; h = 0.5; ctx.fillStyle = BLUE; roundRect(ctx, 2, 2, W - 4, H - 4, 10); ctx.fill(); ctx.textAlign = "left"; ctx.fillStyle = WHITE; ctx.font = `bold 80px ${FONT}`; ctx.fillText("P", 22, cy); ctx.font = `bold 26px ${FONT}`; ctx.fillText("vergunning-", 90, cy - 16); ctx.fillText("houders", 90, cy + 16); break
    case "E10": case "E11": w = 1.0; h = 0.5; ctx.fillStyle = BLUE; roundRect(ctx, 2, 2, W - 4, H - 4, 10); ctx.fill(); ctx.textAlign = "left"; ctx.fillStyle = WHITE; ctx.font = `bold 80px ${FONT}`; ctx.fillText("P", 22, cy); ctx.font = `bold 28px ${FONT}`; ctx.fillText("zone", 90, cy - 16); ctx.fillText("schijf", 90, cy + 16); if (family === "E11") { ctx.strokeStyle = RED; ctx.lineWidth = 8; ctx.beginPath(); ctx.moveTo(20, H - 20); ctx.lineTo(W - 20, 20); ctx.stroke() } break
    case "E12": case "E13": w = 1.0; h = 0.5; ctx.fillStyle = BLUE; roundRect(ctx, 2, 2, W - 4, H - 4, 10); ctx.fill(); label(family === "E12" ? "P+R" : "P carpool", 60, WHITE); break
    case "F1": disc(WHITE, RED, 11); g.car(cx - 20, cy + 4, 46, RED); g.car(cx + 20, cy + 4, 46, BLACK); break
    case "F2": disc(WHITE, GREY, 6); g.car(cx - 20, cy + 4, 46, "#666"); g.car(cx + 20, cy + 4, 46, "#666"); slash(BLACK, 5); break
    case "F3": disc(WHITE, RED, 11); g.lorry(cx - 20, cy + 2, 46, RED); g.car(cx + 22, cy + 6, 44, BLACK); break
    case "F4": disc(WHITE, GREY, 6); g.lorry(cx - 20, cy + 2, 46, "#666"); g.car(cx + 22, cy + 6, 44, "#666"); slash(BLACK, 5); break
    case "F5": disc(RED); g.arrow(cx - 16, cy, 50, -Math.PI / 2, WHITE, 14); g.arrow(cx + 16, cy, 40, Math.PI / 2, BLACK, 10); break
    case "F6": square(BLUE); g.arrow(cx - 16, cy, 50, -Math.PI / 2, WHITE, 14); g.arrow(cx + 16, cy, 40, Math.PI / 2, RED, 10); break
    case "F7": square(BLUE); label("BUS", 40, WHITE); break
    case "F8": disc(WHITE, GREY, 6); ctx.strokeStyle = BLACK; ctx.lineWidth = 4; for (const d of [-16, 0, 16]) { ctx.beginPath(); ctx.moveTo(cx - 40 + d, cy + 40); ctx.lineTo(cx + 40 + d, cy - 40); ctx.stroke() } break
    case "G1": square(BLUE); g.motorway(cx, cy, WHITE); break
    case "G2": square(BLUE); g.motorway(cx, cy, WHITE); slash(RED, 8); break
    case "G3": square(BLUE); g.car(cx, cy + 2, 76, WHITE); break
    case "G4": square(BLUE); g.car(cx, cy + 2, 76, WHITE); slash(RED, 8); break
    case "G5": square(BLUE); g.erf(cx, cy, WHITE); break
    case "G6": square(BLUE); g.erf(cx, cy, WHITE); slash(RED, 8); break
    case "G7": disc(BLUE); g.pedestrian(cx - 8, cy, 74, WHITE); g.pedestrian(cx + 20, cy + 12, 46, WHITE); break
    case "G8": disc(BLUE); g.pedestrian(cx, cy, 74, WHITE); slash(RED, 8); break
    case "G9": disc(BLUE); g.rider(cx, cy, 70, WHITE); break
    case "G10": disc(BLUE); g.rider(cx, cy, 70, WHITE); slash(RED, 8); break
    case "G11": disc(BLUE); g.bicycle(cx, cy + 4, 78, WHITE); break
    case "G12": disc(BLUE); g.bicycle(cx, cy + 4, 78, WHITE); if (dirSuffix === "a") { g.bicycle(cx + 22, cy + 18, 40, WHITE) } if (dirSuffix === "b") slash(RED, 8); break
    case "G13": square(BLUE); g.bicycle(cx, cy + 4, 78, WHITE); break
    case "G14": square(BLUE); g.bicycle(cx, cy + 4, 78, WHITE); slash(RED, 8); break
    case "H1": case "H2": w = 1.0; h = 0.5; ctx.fillStyle = BLUE; roundRect(ctx, 2, 2, W - 4, H - 4, 8); ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = WHITE; roundRect(ctx, 8, 8, W - 16, H - 16, 6); ctx.stroke(); label(text || "", 44, WHITE, cy, "bold", W - 36); if (family === "H2") { ctx.strokeStyle = RED; ctx.lineWidth = 8; ctx.beginPath(); ctx.moveTo(16, H - 16); ctx.lineTo(W - 16, 16); ctx.stroke() } break
    case "J1": triangle(true); g.bumps(cx, cy + 22, BLACK); break
    case "J2": case "J3": triangle(true); g.bend(cx, cy + 22, family === "J2" ? -1 : 1, BLACK); break
    case "J4": case "J5": triangle(true); g.bend(cx, cy + 22, family === "J4" ? -1 : 1, BLACK, true); break
    case "J8": triangle(true); ctx.strokeStyle = BLACK; ctx.lineWidth = 12; ctx.beginPath(); ctx.moveTo(cx, cy - 6); ctx.lineTo(cx, cy + 46); ctx.moveTo(cx - 26, cy + 20); ctx.lineTo(cx + 26, cy + 20); ctx.stroke(); break
    case "J9": triangle(true); g.roundabout(cx, cy + 22, 22, BLACK); break
    case "J10": case "J11": case "J12": case "J13": case "J14": triangle(true); g.train(cx, cy + 22, BLACK); break
    case "J15": case "J34": case "J37": triangle(true); label("!", 60, BLACK, cy + 22); break
    case "J16": triangle(true); g.worker(cx, cy + 22, BLACK); break
    case "J17": case "J18": case "J19": triangle(true); ctx.strokeStyle = BLACK; ctx.lineWidth = 8; ctx.beginPath(); ctx.moveTo(cx - 22, cy + 46); ctx.lineTo(cx - 12, cy + 4); ctx.moveTo(cx + 22, cy + 46); ctx.lineTo(cx + 12, cy + 4); ctx.stroke(); break
    case "J20": triangle(true); g.car(cx, cy + 22, 50, BLACK); ctx.strokeStyle = BLACK; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(cx - 20, cy + 44); ctx.quadraticCurveTo(cx - 30, cy + 34, cx - 34, cy + 46); ctx.moveTo(cx + 20, cy + 44); ctx.quadraticCurveTo(cx + 30, cy + 34, cx + 34, cy + 46); ctx.stroke(); break
    case "J21": triangle(true); g.pedestrian(cx - 12, cy + 24, 44, BLACK); g.pedestrian(cx + 12, cy + 26, 38, BLACK); break
    case "J22": case "J23": triangle(true); g.pedestrian(cx, cy + 22, 52, BLACK); if (family === "J22") { ctx.fillStyle = BLACK; for (let i = 0; i < 4; i++) ctx.fillRect(cx - 30 + i * 16, cy + 44, 8, 6) } break
    case "J24": triangle(true); g.bicycle(cx, cy + 22, 50, BLACK); break
    case "J27": case "J28": triangle(true); g.animal(cx, cy + 22, BLACK); break
    case "J29": triangle(true); g.arrow(cx - 12, cy + 22, 40, -Math.PI / 2, BLACK, 8); g.arrow(cx + 12, cy + 22, 40, Math.PI / 2, RED, 8); break
    case "J32": triangle(true); g.trafficLight(cx, cy + 22); break
    case "J33": triangle(true); g.car(cx - 22, cy + 30, 34, BLACK); g.car(cx, cy + 26, 34, BLACK); g.car(cx + 22, cy + 22, 34, BLACK); break
    case "J38": triangle(true); ctx.fillStyle = BLACK; ctx.beginPath(); ctx.moveTo(cx - 36, cy + 42); ctx.quadraticCurveTo(cx, cy - 6, cx + 36, cy + 42); ctx.closePath(); ctx.fill(); break
    case "L2": square(BLUE); ctx.beginPath(); ctx.moveTo(cx, 16); ctx.lineTo(W - 12, H - 14); ctx.lineTo(12, H - 14); ctx.closePath(); ctx.fillStyle = WHITE; ctx.fill(); g.pedestrian(cx, cy + 20, 50, BLACK); ctx.fillStyle = BLACK; for (let i = 0; i < 4; i++) ctx.fillRect(cx - 28 + i * 15, cy + 42, 7, 5); break
    case "L3": case "L4": square(BLUE); g.bus(cx, cy, WHITE); break
    case "L8": square(BLUE); ctx.fillStyle = WHITE; ctx.fillRect(cx - 9, cy - 22, 18, 72); ctx.fillStyle = RED; ctx.fillRect(cx - 34, cy - 40, 68, 18); break
    case "L9": square(BLUE); ctx.fillStyle = WHITE; ctx.fillRect(cx - 9, cy - 34, 18, 84); ctx.fillRect(cx, cy - 6, 40, 14); ctx.fillStyle = RED; ctx.fillRect(cx + 30, cy - 26, 14, 50); break
    case "L10": case "L11": case "L12": case "L13": case "L14": case "L15": case "L16": case "L17": case "L18": case "L19": case "L20": case "L21": square(BLUE); label(code, 40, WHITE); break
    default:
      if (code.startsWith("OB")) {
        w = 0.6; h = 0.3
        ctx.fillStyle = WHITE; roundRect(ctx, 2, 2, W - 4, H - 4, 6); ctx.fill(); ctx.strokeStyle = BLACK; ctx.lineWidth = 3; roundRect(ctx, 6, 6, W - 12, H - 12, 4); ctx.stroke()
        if (text) lines(text, 30, BLACK); else { g.arrow(cx, cy, 60, -Math.PI / 2, BLACK, 10) }
      } else if (code.startsWith("K") || code.startsWith("BW")) {
        w = 1.4; h = 0.7
        ctx.fillStyle = BLUE; roundRect(ctx, 2, 2, W - 4, H - 4, 8); ctx.fill(); ctx.strokeStyle = WHITE; ctx.lineWidth = 3; roundRect(ctx, 8, 8, W - 16, H - 16, 6); ctx.stroke()
        if (text) { ctx.textAlign = "left"; ctx.fillStyle = WHITE; ctx.font = `bold 32px ${FONT}`; ctx.textBaseline = "middle"; ctx.fillText(text.slice(0, 18), 62, cy); g.arrow(34, cy, 36, 0, WHITE, 8) } else { g.arrow(cx, cy, 120, 0, WHITE, 12) }
      } else if (/^A/.test(code)) { disc(WHITE, RED, 11); label(value || "", 40) }
      else if (/^[CF]/.test(code)) { disc(WHITE, RED, 11); label(value || code, 30) }
      else if (/^D/.test(code)) { disc(BLUE); g.arrow(cx, cy, 44, -Math.PI / 2, WHITE, 12) }
      else if (/^E/.test(code)) { square(BLUE); label("P", 80, WHITE) }
      else if (/^G/.test(code)) { square(BLUE); label(code, 40, WHITE) }
      else if (/^J/.test(code)) { triangle(true); label("!", 60, BLACK, cy + 22) }
      else if (/^L/.test(code)) { square(BLUE); label(code, 36, WHITE) }
      else return null
  }
  return finish(c, w, h)
}

function finish(canvas, w, h) { return { canvas, w, h } }

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath()
}

// pictograms, drawn in a box of size s around (cx, cy)
function glyphs(ctx) {
  const stroke = (color, w) => { ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = w; ctx.lineCap = "round"; ctx.lineJoin = "round" }
  return {
    arrow(x, y, len, angle, color, w) {                        // angle 0 = right, -π/2 = up
      stroke(color, w)
      const dx = Math.cos(angle), dy = Math.sin(angle)
      const x0 = x - dx * len / 2, y0 = y - dy * len / 2, x1 = x + dx * len / 2, y1 = y + dy * len / 2
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke()
      const hl = Math.max(10, w * 1.6)
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 - dx * hl - dy * hl * 0.8, y1 - dy * hl + dx * hl * 0.8); ctx.lineTo(x1 - dx * hl + dy * hl * 0.8, y1 - dy * hl - dx * hl * 0.8); ctx.closePath(); ctx.fill()
    },
    bicycle(x, y, s, color) {
      stroke(color, s * 0.07)
      const r = s * 0.2, ax = x - s * 0.28, bx = x + s * 0.28, wy = y + s * 0.18
      ctx.beginPath(); ctx.arc(ax, wy, r, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.arc(bx, wy, r, 0, Math.PI * 2); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(ax, wy); ctx.lineTo(x - s * 0.05, y - s * 0.16); ctx.lineTo(bx, wy); ctx.lineTo(x + s * 0.12, y - s * 0.2); ctx.lineTo(x - s * 0.05, y - s * 0.16); ctx.moveTo(x - s * 0.05, y - s * 0.16); ctx.lineTo(x + s * 0.02, wy); ctx.lineTo(ax, wy); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(x - s * 0.16, y - s * 0.22); ctx.lineTo(x - s * 0.02, y - s * 0.22); ctx.moveTo(x + s * 0.12, y - s * 0.2); ctx.lineTo(x + s * 0.2, y - s * 0.3); ctx.stroke()
    },
    pedestrian(x, y, s, color) {
      stroke(color, s * 0.12)
      ctx.beginPath(); ctx.arc(x, y - s * 0.36, s * 0.09, 0, Math.PI * 2); ctx.fill()
      ctx.beginPath(); ctx.moveTo(x, y - s * 0.24); ctx.lineTo(x + s * 0.02, y + s * 0.02); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(x + s * 0.02, y + s * 0.02); ctx.lineTo(x - s * 0.14, y + s * 0.4); ctx.moveTo(x + s * 0.02, y + s * 0.02); ctx.lineTo(x + s * 0.16, y + s * 0.4); ctx.stroke()
      ctx.lineWidth = s * 0.08; ctx.beginPath(); ctx.moveTo(x - s * 0.02, y - s * 0.2); ctx.lineTo(x - s * 0.18, y); ctx.moveTo(x, y - s * 0.2); ctx.lineTo(x + s * 0.18, y - s * 0.02); ctx.stroke()
    },
    car(x, y, s, color) {                                        // front view
      ctx.fillStyle = color
      roundRect(ctx, x - s * 0.42, y - s * 0.1, s * 0.84, s * 0.3, s * 0.05); ctx.fill()
      roundRect(ctx, x - s * 0.28, y - s * 0.34, s * 0.56, s * 0.28, s * 0.06); ctx.fill()
      ctx.fillRect(x - s * 0.38, y + s * 0.18, s * 0.16, s * 0.1); ctx.fillRect(x + s * 0.22, y + s * 0.18, s * 0.16, s * 0.1)
    },
    lorry(x, y, s, color) {
      ctx.fillStyle = color
      roundRect(ctx, x - s * 0.36, y - s * 0.4, s * 0.72, s * 0.62, s * 0.05); ctx.fill()
      ctx.fillRect(x - s * 0.42, y + s * 0.1, s * 0.84, s * 0.14)
      ctx.fillRect(x - s * 0.36, y + s * 0.24, s * 0.14, s * 0.1); ctx.fillRect(x + s * 0.22, y + s * 0.24, s * 0.14, s * 0.1)
    },
    bus(x, y, color) {
      ctx.fillStyle = color; roundRect(ctx, x - 40, y - 30, 80, 50, 8); ctx.fill()
      ctx.fillStyle = BLUE; ctx.fillRect(x - 32, y - 22, 20, 18); ctx.fillRect(x - 8, y - 22, 20, 18); ctx.fillRect(x + 16, y - 22, 16, 18)
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x - 24, y + 24, 8, 0, Math.PI * 2); ctx.arc(x + 24, y + 24, 8, 0, Math.PI * 2); ctx.fill()
    },
    roundabout(x, y, r, color) {
      stroke(color, r * 0.3); ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke()
      for (let i = 0; i < 3; i++) { const a = -Math.PI / 2 + i * 2 * Math.PI / 3; const px = x + r * Math.cos(a), py = y + r * Math.sin(a); const tx = -Math.sin(a), ty = Math.cos(a)
        ctx.beginPath(); ctx.moveTo(px + tx * r * 0.45, py + ty * r * 0.45); ctx.lineTo(px - tx * r * 0.2 + Math.cos(a) * r * 0.45, py - ty * r * 0.2 + Math.sin(a) * r * 0.45); ctx.lineTo(px - tx * r * 0.2 - Math.cos(a) * r * 0.45, py - ty * r * 0.2 - Math.sin(a) * r * 0.45); ctx.closePath(); ctx.fill() }
    },
    motorway(x, y, color) {
      stroke(color, 9)
      ctx.beginPath(); ctx.moveTo(x - 10, y - 40); ctx.lineTo(x - 22, y + 44); ctx.moveTo(x + 10, y - 40); ctx.lineTo(x + 22, y + 44); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(x - 44, y - 4); ctx.lineTo(x + 44, y - 4); ctx.stroke(); ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(x - 40, y - 4); ctx.lineTo(x - 40, y - 24); ctx.moveTo(x + 40, y - 4); ctx.lineTo(x + 40, y - 24); ctx.stroke()
    },
    erf(x, y, color) {
      ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(x - 40, y - 4); ctx.lineTo(x - 18, y - 34); ctx.lineTo(x + 4, y - 4); ctx.closePath(); ctx.fill(); ctx.fillRect(x - 32, y - 4, 28, 26)
      this.car(x + 26, y + 26, 40, color); this.pedestrian(x + 30, y - 14, 34, color)
    },
    wheelchair(x, y, s, color) {
      stroke(color, s * 0.12); ctx.beginPath(); ctx.arc(x, y + s * 0.15, s * 0.3, 0, Math.PI * 2); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(x - s * 0.1, y - s * 0.45); ctx.lineTo(x - s * 0.1, y); ctx.lineTo(x + s * 0.3, y); ctx.lineTo(x + s * 0.45, y + s * 0.3); ctx.stroke(); ctx.beginPath(); ctx.arc(x - s * 0.1, y - s * 0.55, s * 0.1, 0, Math.PI * 2); ctx.fill()
    },
    rider(x, y, s, color) {
      ctx.fillStyle = color; roundRect(ctx, x - s * 0.36, y, s * 0.6, s * 0.22, s * 0.08); ctx.fill()
      stroke(color, s * 0.08); ctx.beginPath(); ctx.moveTo(x - s * 0.3, y + s * 0.2); ctx.lineTo(x - s * 0.34, y + s * 0.44); ctx.moveTo(x + s * 0.18, y + s * 0.2); ctx.lineTo(x + s * 0.22, y + s * 0.44); ctx.moveTo(x + s * 0.22, y + s * 0.02); ctx.lineTo(x + s * 0.36, y - s * 0.16); ctx.stroke()
      this.pedestrian(x - s * 0.06, y - s * 0.12, s * 0.5, color)
    },
    bumps(x, y, color) { stroke(color, 8); ctx.beginPath(); ctx.moveTo(x - 36, y + 14); ctx.quadraticCurveTo(x - 18, y - 14, x, y + 14); ctx.quadraticCurveTo(x + 18, y + 42, x + 36, y + 14); ctx.stroke() },
    bend(x, y, dir, color, double = false) {
      stroke(color, 9); ctx.beginPath(); ctx.moveTo(x - dir * 10, y + 40)
      if (double) { ctx.quadraticCurveTo(x - dir * 10, y + 10, x + dir * 10, y + 4); ctx.quadraticCurveTo(x + dir * 30, y - 4, x + dir * 6, y - 26) } else { ctx.lineTo(x - dir * 10, y + 8); ctx.quadraticCurveTo(x - dir * 10, y - 12, x + dir * 12, y - 12); ctx.lineTo(x + dir * 30, y - 12) }
      ctx.stroke()
    },
    train(x, y, color) { ctx.fillStyle = color; roundRect(ctx, x - 26, y - 20, 52, 40, 6); ctx.fill(); ctx.fillStyle = WHITE; ctx.fillRect(x - 18, y - 12, 14, 12); ctx.fillRect(x + 4, y - 12, 14, 12); ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x - 14, y + 26, 6, 0, Math.PI * 2); ctx.arc(x + 14, y + 26, 6, 0, Math.PI * 2); ctx.fill() },
    worker(x, y, color) { this.pedestrian(x - 6, y + 2, 50, color); stroke(color, 5); ctx.beginPath(); ctx.moveTo(x + 4, y - 4); ctx.lineTo(x + 28, y + 18); ctx.stroke(); ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(x - 30, y + 22); ctx.lineTo(x + 30, y + 22); ctx.lineTo(x + 24, y + 30); ctx.lineTo(x - 24, y + 30); ctx.closePath(); ctx.fill() },
    animal(x, y, color) { ctx.fillStyle = color; roundRect(ctx, x - 30, y - 12, 50, 22, 8); ctx.fill(); ctx.fillRect(x - 26, y + 8, 7, 18); ctx.fillRect(x - 8, y + 8, 7, 18); ctx.fillRect(x + 6, y + 8, 7, 18); ctx.fillRect(x + 20, y + 8, 7, 18); ctx.beginPath(); ctx.arc(x + 26, y - 14, 9, 0, Math.PI * 2); ctx.fill() },
    trafficLight(x, y) { ctx.fillStyle = BLACK; roundRect(ctx, x - 12, y - 30, 24, 60, 6); ctx.fill(); for (const [i, col] of [RED, "#ffb000", GREEN].entries()) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y - 20 + i * 20, 7, 0, Math.PI * 2); ctx.fill() } }
  }
}
