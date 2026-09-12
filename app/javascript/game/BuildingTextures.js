import * as THREE from "three"
import { TUNING as T } from "game/Tuning"
import { texture, bricks, grain, speckle, cracks, grey, rng } from "game/Textures"
import { noOutline } from "game/Outline"

// What the buildings are made of. Four maps, all drawn once: plain brick and plaster for the walls that are too
// small or too odd to carry a window, pantiles and bitumen for the roofs, and the facade — one canvas holding
// exactly one bay by one storey, with a window in it.
//
// The facade is the whole trick. BuildingMeshes gives every wall face a UV of (metres along the wall / bay width,
// metres above the building's foot / storey height), both snapped to whole numbers per building, so this one cell
// tiles into a row of windows that lines up around every corner, never slices a window at an eave and always
// leaves a brick pier on an outside corner. The window sits in the middle of the cell with a good half metre of
// brick either side, which is what makes that true.
//
// Three maps share the layout: the picture, a surface map (roughness in green, metalness in blue) so only the glass
// catches the environment, and an emissive map that lights the windows after dark.
const BAY = 2.8, STOREY = 3.0                       // metres of one facade cell; T.buildings snaps faces to these
const WIN = { w: 1.2, h: 1.4, sill: 0.9 }           // window size and the height of its sill above the floor
// where the window sits inside the cell, in the cell's own metres: game/Facades.js hangs a real sill under it
export const WINDOW = { ...WIN, bay: BAY, storey: STOREY }
// near-greyscale on purpose: the map is the relief, the building's own palette colour is the hue, multiplied in as
// a vertex colour. One brick map then serves every house in Limburg.
const MORTAR = "#e6e2da"
const PALETTES = { brick: ["#d2ccc4", "#c6c0b8", "#dad4cb", "#bdb7ae", "#e0dad1", "#b4aea6"] }

const CANVAS = 512
const px = (m, span) => m / span * CANVAS          // metres → pixels inside one facade cell

// ---- the facade cell ---------------------------------------------------------------------------------------------

// mode "kleur" paints the picture, "vlak" the roughness/metalness, "licht" the light behind the glass
function drawFacade(ctx, size, mode, rnd) {
  const x0 = px((BAY - WIN.w) / 2, BAY), w = px(WIN.w, BAY)
  const y1 = size - px(WIN.sill, STOREY), y0 = y1 - px(WIN.h, STOREY)
  const frame = px(0.06, BAY)

  if (mode === "kleur") {
    bricks(ctx, size, { mortar: MORTAR, palette: PALETTES.brick, rows: 36, cols: 12, rnd })
    ctx.fillStyle = "rgba(0,0,0,.18)"                                  // a soldier course over the opening
    ctx.fillRect(x0 - frame, y0 - px(0.14, STOREY), w + frame * 2, px(0.12, STOREY))
  } else if (mode === "vlak") {
    ctx.fillStyle = "rgb(0,242,0)"                                     // brick: rough, not metal
    ctx.fillRect(0, 0, size, size)
  } else {
    ctx.fillStyle = "#000"
    ctx.fillRect(0, 0, size, size)
  }

  if (mode === "licht") {                                              // the light indoors, nothing else
    const glow = ctx.createLinearGradient(0, y0, 0, y1)
    glow.addColorStop(0, "#ffca6e"); glow.addColorStop(1, "#c98a2a")
    ctx.fillStyle = glow
    ctx.fillRect(x0, y0, w, y1 - y0)
    return
  }

  if (mode === "vlak") {
    ctx.fillStyle = "rgb(0,38,140)"                                    // glass: smooth and half a mirror
    ctx.fillRect(x0, y0, w, y1 - y0)
    ctx.fillStyle = "rgb(0,150,0)"                                     // the painted frame sits between the two
    ctx.fillRect(x0 - frame, y0 - frame, w + frame * 2, frame)
    ctx.fillRect(x0 - frame, y1, w + frame * 2, frame)
    return
  }

  // the glass, layered the way a window reads from outside: a dark room, curtains at the sides, a warm patch
  // deeper in, then the sky over all of it and one diagonal streak of reflection
  ctx.fillStyle = "#1b2129"
  ctx.fillRect(x0, y0, w, y1 - y0)
  ctx.fillStyle = "rgba(232,223,207,0.85)"
  for (const side of [0, 1]) ctx.fillRect(side ? x0 + w * 0.78 : x0, y0, w * 0.22, y1 - y0)
  ctx.fillStyle = "rgba(255,214,120,0.35)"
  ctx.fillRect(x0 + w * 0.3, y0 + (y1 - y0) * 0.35, w * 0.4, (y1 - y0) * 0.65)
  const sky = ctx.createLinearGradient(0, y0, 0, y1)
  sky.addColorStop(0, "rgba(170,205,235,0.7)"); sky.addColorStop(0.55, "rgba(90,120,150,0.45)"); sky.addColorStop(1, "rgba(30,45,60,0.35)")
  ctx.fillStyle = sky
  ctx.fillRect(x0, y0, w, y1 - y0)
  ctx.fillStyle = "rgba(255,255,255,0.16)"
  ctx.beginPath()
  ctx.moveTo(x0 + w * 0.1, y1); ctx.lineTo(x0 + w * 0.55, y0); ctx.lineTo(x0 + w * 0.75, y0); ctx.lineTo(x0 + w * 0.3, y1)
  ctx.fill()
  const shade = ctx.createLinearGradient(0, y0, 0, y0 + px(0.18, STOREY))
  shade.addColorStop(0, "rgba(0,0,0,0.4)"); shade.addColorStop(1, "rgba(0,0,0,0)")
  ctx.fillStyle = shade
  ctx.fillRect(x0, y0, w, px(0.18, STOREY))

  ctx.fillStyle = "#f2efe6"                                            // frame, mullion and transom
  ctx.fillRect(x0 - frame, y0 - frame, w + frame * 2, frame)
  ctx.fillRect(x0 - frame, y1, w + frame * 2, frame)
  ctx.fillRect(x0 - frame, y0, frame, y1 - y0)
  ctx.fillRect(x0 + w, y0, frame, y1 - y0)
  ctx.fillRect(x0 + w / 2 - frame / 2, y0, frame, y1 - y0)
  ctx.fillRect(x0, y0 + (y1 - y0) * 0.32, w, frame * 0.8)
  ctx.fillStyle = "#cdc7bb"                                            // the stone sill under it
  ctx.fillRect(x0 - frame * 2, y1 + frame, w + frame * 4, px(0.08, STOREY))
  ctx.fillStyle = "rgba(0,0,0,.25)"
  ctx.fillRect(x0 - frame * 2, y1 + frame + px(0.08, STOREY), w + frame * 4, px(0.02, STOREY))
}

// ---- the plain surfaces -------------------------------------------------------------------------------------------

const DRAW = {
  // a wall with no window in it: the same bond, tiled by the metre
  steen: () => (ctx, size) => bricks(ctx, size, { mortar: MORTAR, palette: PALETTES.brick, rows: 32, cols: 10, rnd: rng(21) }),
  // pantiles: rows of curved tiles, each with a highlight down its back and a shadow in the valley
  pannen: () => (ctx, size) => {
    const rnd = rng(24), cols = 8, rows = 12, w = size / cols, h = size / rows
    ctx.fillStyle = "#6a4034"; ctx.fillRect(0, 0, size, size)
    for (let r = 0; r < rows; r++) for (let c = -1; c <= cols; c++) {
      const x = c * w + (r % 2) * w / 2, y = r * h
      const g = ctx.createLinearGradient(x, 0, x + w, 0)
      const base = 150 + rnd() * 40
      g.addColorStop(0, grey(base * 0.6)); g.addColorStop(0.45, grey(base)); g.addColorStop(1, grey(base * 0.5))
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.moveTo(x, y); ctx.lineTo(x + w, y)
      ctx.lineTo(x + w, y + h * 0.8)
      ctx.quadraticCurveTo(x + w / 2, y + h * 1.15, x, y + h * 0.8)
      ctx.closePath(); ctx.fill()
      ctx.fillStyle = "rgba(0,0,0,.25)"; ctx.fillRect(x, y, Math.max(1, w * 0.06), h)
    }
    grain(ctx, size, 150, 60, 5000, 2, rnd, 0.3)
  },
  // a flat roof: bitumen with the seams between the rolls
  bitumen: () => (ctx, size) => {
    const rnd = rng(25)
    speckle(ctx, size, 120, 30, 4000, 3, rnd)
    ctx.fillStyle = "rgba(0,0,0,.25)"
    for (let y = 0; y < size; y += size / 4) ctx.fillRect(0, y, size, 2)
  },
  // the inside of a wall, and the underside of a floor: plaster, near enough flat, with the roller marks in it
  pleister: () => (ctx, size) => {
    const rnd = rng(26)
    speckle(ctx, size, 205, 14, 2200, 4, rnd)
    grain(ctx, size, 200, 22, 900, 9, rnd, 0.25)
  },
  // a bare floor slab, seen from above once the roof is off
  beton: () => (ctx, size) => {
    const rnd = rng(27)
    speckle(ctx, size, 168, 22, 5000, 3, rnd)
    cracks(ctx, size, 6, 120, rnd)
  },
}

const METRES = { steen: 2.4, pannen: 2.0, bitumen: 3.0, pleister: 2.0, beton: 2.5 }

// ---- materials ------------------------------------------------------------------------------------------------

const STRUCTURE = new Set([ "pleister", "beton" ])     // built by game/Structure.js, and wound correctly
const materials = new Map()
const lit = []                                        // the facade materials, dimmed and lit by setBuildingsNight

let facadeMaps = null
function facade() {
  if (!facadeMaps) {
    const map = texture(1, (ctx, size) => drawFacade(ctx, size, "kleur", rng(31)), CANVAS)
    const vlak = texture(1, (ctx, size) => drawFacade(ctx, size, "vlak", rng(31)), CANVAS)
    const licht = texture(1, (ctx, size) => drawFacade(ctx, size, "licht", rng(31)), CANVAS)
    vlak.colorSpace = licht.colorSpace = THREE.NoColorSpace                      // data, not colour
    facadeMaps = { map, vlak, licht }
  }
  return facadeMaps
}

export function buildingMaterial(name) {
  if (materials.has(name)) return materials.get(name)
  let m
  if (name === "gevel" || name === "gevel-uit") {                                // the same wall; only one lights up
    const { map, vlak, licht } = facade()
    const on = name === "gevel"
    m = new THREE.MeshStandardMaterial({
      map, vertexColors: true, side: THREE.DoubleSide,      // LoD2.2 winding is not to be trusted
      roughnessMap: vlak, metalnessMap: vlak, roughness: 1, metalness: 1,
      ...(on && { emissive: 0xffffff, emissiveMap: licht, emissiveIntensity: 0 }),
    })
    if (on) lit.push(m)
  } else if (name === "glas") {
    // the one surface with no texture on it: what you see is the sky the environment map is carrying, and after dark
    // the light behind it. Punching a real hole takes the painted window (and its glow) out of the facade map, so
    // this joins the `lit` list in its place.
    m = new THREE.MeshStandardMaterial({ color: 0x8fa7b8, vertexColors: true, roughness: 0.08, metalness: 0.5,
      emissive: 0xffca6e, emissiveIntensity: 0 })
    lit.push(m)
  } else {
    m = new THREE.MeshStandardMaterial({ map: texture(METRES[name], DRAW[name]()), vertexColors: true, roughness: 0.92,
      side: STRUCTURE.has(name) ? THREE.FrontSide : THREE.DoubleSide })   // a built wall has two real sides; a shell has one
  }
  m.__shared = true
  // the structure is hundreds of small pieces per house: an inverted hull round every one of them is a scribble,
  // and it would draw a quarter of a million triangles twice
  if (STRUCTURE.has(name) || name === "glas") noOutline(m)
  materials.set(name, m)
  return m
}

// darkness 0 (day) … 1 (night): the windows come on
export function setBuildingsNight(d) { for (const m of lit) m.emissiveIntensity = T.buildings.lit * d * d }
