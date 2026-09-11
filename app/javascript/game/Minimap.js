// Minimap drawn from our own map data (see MapBuilder): an overview of the whole play area plus 1 km detail cells
// fetched as you zoom in. Small: follows the car, north-up. Expanded (M): drag to pan, wheel to zoom around the
// cursor, F fits the full bounds, a click teleports the car, Escape/M close. During a round it also shows the arena,
// the parade route with the obstacles still standing on it, and the float itself.
const SMALL_SCALE = 3.5          // m/px in the corner map
const DETAIL_SCALE = 4.5         // load 1 km detail cells when zoomed in beyond this (the corner map included)
const MIN_SCALE = 0.4            // max zoom-in
const REDRAW_MS = 80
const LAYER_MARGIN = 1           // the cached map layer extends this many view widths beyond the view on each side

const BASE = "#d7dec3"
const COVER = {
  1: "#c3da98", 2: "#cde0a6", 3: "#bad39a", 4: "#eadcae", 5: "#bfd99a", 6: "#c9da9f", 7: "#9cc286", 8: "#d3c7a6", 9: "#b3cd90",
  10: "#b8cea4", 11: "#efe4c3", 12: "#d4d2b4", 13: "#8fb87c", 14: "#95bd81", 15: "#9cc286", 16: "#b2c79c", 17: "#c0cda8", 18: "#f2e8cb",
  19: "#8cb377", 20: "#e7e2d7", 21: "#cdcdcf", 22: "#dbd5ce", 23: "#ddd8cb", 24: "#d9d1bf", 25: "#cbdfa5", 30: "#9cc3e0"
}
const ROAD = {
  motorway: ["#e88b5a", 2.2], motorway_link: ["#e88b5a", 1.4], trunk: ["#f0a866", 2.0], trunk_link: ["#f0a866", 1.3],
  primary: ["#f5b76b", 1.9], primary_link: ["#f5b76b", 1.2], secondary: ["#f7dd8f", 1.7], secondary_link: ["#f7dd8f", 1.1],
  tertiary: ["#fbeeb5", 1.5], tertiary_link: ["#fbeeb5", 1.0], default: ["#ffffff", 1.2]
}
const BUILDING = "#b7a597", TREE = "#5f8c3e", WATER_EDGE = "#7fa9cc"
const BBOX = new WeakMap()       // flat coordinate array → [minX, minZ, maxX, maxZ]

export class Minimap {
  constructor(canvas, config, { onTeleport, interactive = true }) {
    this.canvas = canvas
    this.ctx = canvas.getContext("2d")
    this.cfg = config
    this.origin = config.origin
    this.onTeleport = onTeleport
    this.expanded = false
    this.view = { cx: 0, cz: 0, scale: SMALL_SCALE }
    this.cells = new Map()          // "mx_my" → data | "loading" | "missing"
    this.overview = null
    this.dirty = true
    this.lastDraw = 0
    this.drag = null
    this.hover = null
    // The static map (cover, roads, buildings, trees, border) is rasterised once into an offscreen layer three
    // view-widths wide and blitted with an offset while the car moves; it is redrawn only when the view leaves it,
    // the zoom changes or new cells arrive. Re-pathing the whole province 12× a second was a large share of the frame.
    this.layer = null
    this.layerDirty = true
    fetch("/map/overview.json").then((r) => (r.ok ? r : fetch("/api/map/overview"))).then((r) => r.json())
      .then((o) => { this.overview = o; this.dirty = this.layerDirty = true; if (this.expanded) this.fit() }).catch(console.warn)

    if (interactive) this.listen()
    addEventListener("resize", () => this.resize())
    this.resize()
  }

  listen() {
    const { canvas } = this
    canvas.addEventListener("mousedown", (e) => { this.drag = { x: e.offsetX, y: e.offsetY, moved: false }; e.preventDefault() })
    canvas.addEventListener("mousemove", (e) => {
      this.hover = this.expanded ? [e.offsetX, e.offsetY] : null
      if (this.drag && this.expanded) {
        const dx = e.offsetX - this.drag.x, dy = e.offsetY - this.drag.y
        if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true
        if (this.drag.moved) { this.view.cx -= dx * this.view.scale; this.view.cz -= dy * this.view.scale; this.drag.x = e.offsetX; this.drag.y = e.offsetY }
      }
      this.dirty = true
    })
    canvas.addEventListener("mouseup", (e) => {
      const drag = this.drag; this.drag = null
      if (!drag) return
      if (!this.expanded) { this.toggle(); return }                // clicking the small map opens it
      if (drag.moved) return
      const [x, z] = this.toWorld(e.offsetX, e.offsetY)
      if (this.onTeleport(x, z) !== false) this.toggle()          // a refused teleport keeps the map open
    })
    canvas.addEventListener("mouseleave", () => { this.hover = null; this.drag = null; this.dirty = true })
    canvas.addEventListener("wheel", (e) => {
      if (!this.expanded) return
      e.preventDefault()
      const [wx, wz] = this.toWorld(e.offsetX, e.offsetY)
      const factor = Math.exp(e.deltaY * 0.0015)
      this.view.scale = Math.min(this.fitScale() * 1.5, Math.max(MIN_SCALE, this.view.scale * factor))
      // keep the world point under the cursor fixed
      this.view.cx = wx - (e.offsetX - this.w / 2) * this.view.scale
      this.view.cz = wz - (e.offsetY - this.h / 2) * this.view.scale
      this.dirty = true
    }, { passive: false })
    addEventListener("keydown", (e) => {
      if (!this.expanded) return
      if (e.code === "KeyF") this.fit()
      if (e.code === "Escape") this.toggle()
    })
  }

  // a fixed frame of the arena for the loading screen: the whole square with the route through it, no car
  showArena(round) {
    const a = round.round?.arena
    if (!a) return
    this.round = round
    if (this.w <= 1) this.resize()
    const scale = 2 * a.half * 1.2 / Math.min(this.w, this.h)
    if (this.view.cx !== a.cx || this.view.cz !== a.cz || this.view.scale !== scale) { this.view = { cx: a.cx, cz: a.cz, scale }; this.dirty = true }
    if (this.view.scale < DETAIL_SCALE) this.loadCells()
    if (this.dirty) { this.dirty = false; this.draw() }
  }

  toggle() {
    this.expanded = !this.expanded
    this.canvas.classList.toggle("expanded", this.expanded)
    this.resize()
    if (this.expanded) this.fit()
  }

  resize() {
    const r = this.canvas.getBoundingClientRect()
    const dpr = Math.min(devicePixelRatio || 1, 2)
    this.w = Math.max(1, Math.round(r.width)); this.h = Math.max(1, Math.round(r.height))
    this.canvas.width = this.w * dpr; this.canvas.height = this.h * dpr
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.dpr = dpr
    this.dirty = this.layerDirty = true
  }

  bounds() {
    if (this.overview) return this.overview.bounds
    const [x0, y0, x1, y1] = this.cfg.bounds        // RD → game
    return [x0 - this.origin.x, -(y1 - this.origin.y), x1 - this.origin.x, -(y0 - this.origin.y)]
  }

  fitScale() {
    const [xw, zn, xe, zs] = this.bounds()
    return Math.max((xe - xw) / this.w, (zs - zn) / this.h) * 1.04
  }

  fit() {
    const [xw, zn, xe, zs] = this.bounds()
    this.view = { cx: (xw + xe) / 2, cz: (zn + zs) / 2, scale: this.fitScale() }
    this.dirty = true
  }

  toPixel(x, z) { return [this.w / 2 + (x - this.view.cx) / this.view.scale, this.h / 2 + (z - this.view.cz) / this.view.scale] }
  toWorld(px, py) { return [this.view.cx + (px - this.w / 2) * this.view.scale, this.view.cz + (py - this.h / 2) * this.view.scale] }

  update(car, remotes, round) {
    this.car = car; this.remotes = remotes; this.round = round
    if (round?.running) this.dirty = true                          // the float moves even when the car stands still
    if (!this.expanded) {
      if (this.view.cx !== car.x || this.view.cz !== car.z) this.dirty = true
      this.view = { cx: car.x, cz: car.z, scale: SMALL_SCALE }
    }
    if (this.view.scale < DETAIL_SCALE) this.loadCells()
    const now = performance.now()
    if ((this.dirty || this.expanded) && now - this.lastDraw > REDRAW_MS) { this.lastDraw = now; this.dirty = false; this.draw() }
  }

  // 1 km cells (RD grid) intersecting the view
  cellsInView() {
    const [xw, zn] = this.toWorld(0, 0), [xe, zs] = this.toWorld(this.w, this.h)
    const mx0 = Math.floor((xw + this.origin.x) / 1000), mx1 = Math.floor((xe + this.origin.x) / 1000)
    const my0 = Math.floor((this.origin.y - zs) / 1000), my1 = Math.floor((this.origin.y - zn) / 1000)
    const range = this.overview?.cells
    const out = []
    for (let my = my0; my <= my1; my++)
      for (let mx = mx0; mx <= mx1; mx++) {
        if (range && (mx < range[0] || mx >= range[2] || my < range[1] || my >= range[3])) continue
        out.push([mx, my])
      }
    return out
  }

  loadCells() {
    for (const [mx, my] of this.cellsInView()) {
      const key = `${mx}_${my}`
      if (this.cells.has(key)) continue
      this.cells.set(key, "loading")
      fetch(`/map/${key}.json`).then((r) => (r.ok ? r : fetch(`/api/map/${mx}/${my}`))).then((r) => (r.ok ? r.json() : null))
        .then((data) => { this.cells.set(key, data ?? "missing"); this.dirty = this.layerDirty = true })
        .catch(() => this.cells.set(key, "missing"))
    }
  }

  draw() {
    const { ctx, w, h } = this
    this.ensureLayer()
    const L = this.layer
    // blit the cached static map, offset by how far the view has moved since the layer was drawn
    const ox = (L.cx - this.view.cx) / this.view.scale, oz = (L.cz - this.view.cz) / this.view.scale
    ctx.fillStyle = BASE
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(L.canvas, w / 2 + ox - L.w / 2, h / 2 + oz - L.h / 2, L.w, L.h)
    this.drawArena()
    if (this.expanded) this.drawLabels()
    this.drawCars()
    if (this.expanded) this.drawChrome()
  }

  // redraw the static layer when the view has left it, the zoom or size changed, or new data arrived
  ensureLayer() {
    const s = this.view.scale, L = this.layer
    const margin = this.expanded ? 0.25 : LAYER_MARGIN            // the expanded map is screen-sized: keep its layer small
    const lw = this.w * (1 + 2 * margin), lh = this.h * (1 + 2 * margin)
    const stale = !L || this.layerDirty || L.scale !== s || L.w !== lw || L.h !== lh ||
      Math.abs(this.view.cx - L.cx) > margin * this.w * s * 0.8 || Math.abs(this.view.cz - L.cz) > margin * this.h * s * 0.8
    if (!stale) return
    this.layerDirty = false
    const canvas = L?.canvas ?? document.createElement("canvas")
    canvas.width = Math.round(lw * this.dpr); canvas.height = Math.round(lh * this.dpr)
    const lctx = canvas.getContext("2d")
    lctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.layer = { canvas, cx: this.view.cx, cz: this.view.cz, scale: s, w: lw, h: lh }
    // draw with the layer as the current target: the path helpers read ctx/w/h/view
    const saved = { ctx: this.ctx, w: this.w, h: this.h }
    this.ctx = lctx; this.w = lw; this.h = lh
    try {
      lctx.fillStyle = BASE
      lctx.fillRect(0, 0, lw, lh)
      const detail = s < DETAIL_SCALE
      const cells = detail ? this.cellsInView().map(([mx, my]) => this.cells.get(`${mx}_${my}`)).filter((c) => c && typeof c === "object") : []
      if (this.overview) this.drawCover(this.overview.cover)
      for (const c of cells) this.drawCover(c.cover)
      if (this.overview && !detail) this.drawRoads(this.overview.roads, false)
      for (const c of cells) this.drawRoads(c.roads, s < 2.5)
      if (s < 4) for (const c of cells) this.drawBuildings(c.buildings)
      if (s < 1.8) for (const c of cells) this.drawTrees(c.trees)
      this.drawBorder()
    } finally {
      this.ctx = saved.ctx; this.w = saved.w; this.h = saved.h
    }
  }

  // world-space bounding box of a flat [x, z, x, z, …] array (from `offset`), cached on the array
  bbox(flat, offset = 0) {
    let bb = BBOX.get(flat)
    if (!bb) {
      bb = [Infinity, Infinity, -Infinity, -Infinity]
      for (let i = offset; i + 1 < flat.length; i += 2) {
        const x = flat[i], z = flat[i + 1]
        if (x < bb[0]) bb[0] = x; if (x > bb[2]) bb[2] = x; if (z < bb[1]) bb[1] = z; if (z > bb[3]) bb[3] = z
      }
      BBOX.set(flat, bb)
    }
    return bb
  }

  // whether the flat polyline/ring can touch the current target
  visible(flat, offset = 0, slack = 0) {
    const bb = this.bbox(flat, offset), s = this.view.scale
    const hw = this.w / 2 * s + slack, hh = this.h / 2 * s + slack
    return bb[2] >= this.view.cx - hw && bb[0] <= this.view.cx + hw && bb[3] >= this.view.cz - hh && bb[1] <= this.view.cz + hh
  }

  path(flat, offset = 0) {
    const { ctx } = this
    const s = 1 / this.view.scale, ox = this.w / 2 - this.view.cx * s, oz = this.h / 2 - this.view.cz * s
    ctx.moveTo(ox + flat[offset] * s, oz + flat[offset + 1] * s)
    for (let i = offset + 2; i + 1 < flat.length; i += 2) ctx.lineTo(ox + flat[i] * s, oz + flat[i + 1] * s)
  }

  drawCover(cover) {
    const { ctx } = this
    for (const entry of cover) {
      const color = COVER[entry[0]]
      if (!color || !this.visible(entry[1])) continue
      ctx.fillStyle = color
      ctx.beginPath()
      for (let r = 1; r < entry.length; r++) { this.path(entry[r]); ctx.closePath() }
      ctx.fill("evenodd")
      if (entry[0] === 30 && this.view.scale < 6) { ctx.strokeStyle = WATER_EDGE; ctx.lineWidth = 1; ctx.stroke() }
    }
  }

  drawRoads(roads, casing) {
    const { ctx } = this
    ctx.lineCap = "round"; ctx.lineJoin = "round"
    const widthOf = (road) => { const [, min] = ROAD[road[0]] ?? ROAD.default; return Math.max(min, road[1] / this.view.scale) }
    const shown = roads.filter((road) => this.visible(road, 3, 20))
    if (casing) {
      ctx.strokeStyle = "#9a9a9a"
      for (const road of shown) { ctx.lineWidth = widthOf(road) + 1.6; ctx.beginPath(); this.path(road, 3); ctx.stroke() }
    }
    for (const road of shown) {
      ctx.strokeStyle = (ROAD[road[0]] ?? ROAD.default)[0]
      ctx.lineWidth = widthOf(road)
      ctx.beginPath(); this.path(road, 3); ctx.stroke()
    }
    if (this.view.scale < 1.2) this.drawRoadNames(shown)
  }

  drawRoadNames(roads) {
    const { ctx } = this
    ctx.font = "10px system-ui, sans-serif"; ctx.fillStyle = "#333"; ctx.textAlign = "center"; ctx.textBaseline = "middle"
    const seen = new Set()
    for (const road of roads) {
      const name = road[2]
      if (!name || seen.has(name) || road.length < 7) continue
      // label at the middle segment, along its direction
      const mid = 3 + 2 * Math.floor((road.length - 3) / 4)
      const [ax, ay] = this.toPixel(road[mid], road[mid + 1]), [bx, by] = this.toPixel(road[mid + 2], road[mid + 3])
      const len = Math.hypot(bx - ax, by - ay)
      if (len < name.length * 5) continue
      let angle = Math.atan2(by - ay, bx - ax)
      if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI
      seen.add(name)
      ctx.save(); ctx.translate((ax + bx) / 2, (ay + by) / 2); ctx.rotate(angle); ctx.fillText(name, 0, 0); ctx.restore()
    }
  }

  drawBuildings(buildings) {
    const { ctx } = this
    ctx.fillStyle = BUILDING
    ctx.beginPath()
    for (const ring of buildings) { if (!this.visible(ring)) continue; this.path(ring); ctx.closePath() }
    ctx.fill()
  }

  drawTrees(trees) {
    const { ctx } = this
    const r = Math.max(1, 1.5 / this.view.scale)
    ctx.fillStyle = TREE
    ctx.beginPath()
    for (let i = 0; i + 1 < trees.length; i += 2) { const [px, py] = this.toPixel(trees[i], trees[i + 1]); ctx.moveTo(px + r, py); ctx.arc(px, py, r, 0, Math.PI * 2) }
    ctx.fill()
  }

  drawLabels() {
    const { ctx } = this
    ctx.textAlign = "center"; ctx.textBaseline = "middle"
    // label density follows the zoom: a province at fit scale shows cities and towns only
    const s = this.view.scale
    for (const p of this.cfg.places) {
      const settlement = ["city", "town", "village", "hamlet"].includes(p.kind)
      if (!settlement && s > 8) continue
      if (p.kind === "hamlet" && s > 12) continue
      if (p.kind === "village" && s > 40) continue
      if (p.kind === "town" && s > 260) continue
      const [px, py] = this.toPixel(p.x, p.z)
      if (px < -50 || py < -20 || px > this.w + 50 || py > this.h + 20) continue
      ctx.font = settlement ? `bold ${p.kind === "hamlet" ? 11 : 13}px system-ui, sans-serif` : "italic 11px system-ui, sans-serif"
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.strokeText(p.name, px, py)
      ctx.fillStyle = settlement ? "#222" : "#555"; ctx.fillText(p.name, px, py)
    }
  }

  // the province border: outside it the world is on fire
  drawBorder() {
    if (!this.cfg.border?.length) return
    const { ctx } = this
    ctx.strokeStyle = "#e0401a"; ctx.lineWidth = this.expanded ? 3 : 2; ctx.setLineDash([6, 4])
    for (const ring of this.cfg.border) { ctx.beginPath(); this.path(ring); ctx.closePath(); ctx.stroke() }
    ctx.setLineDash([])
  }

  // the round: the arena square, the parade route with the obstacles still standing on it, and the float
  drawArena() {
    const r = this.round?.round
    if (!r) return
    const { ctx } = this
    const a = r.arena, p = r.path
    const [ax, ay] = this.toPixel(a.cx - a.half, a.cz - a.half), size = 2 * a.half / this.view.scale
    ctx.strokeStyle = "#f2c14e"; ctx.lineWidth = 2; ctx.setLineDash([8, 4]); ctx.strokeRect(ax, ay, size, size)
    ctx.strokeStyle = "#e0241a"; ctx.lineWidth = this.expanded ? 3 : 2.5; ctx.setLineDash([10, 6])
    ctx.beginPath(); this.path([p.x0, p.z0, p.x1, p.z1]); ctx.stroke()
    ctx.setLineDash([])
    const [ex, ey] = this.toPixel(p.x1, p.z1)
    ctx.fillStyle = "#e0241a"; ctx.beginPath(); ctx.arc(ex, ey, 4, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = "#8b1a1a"
    for (const o of this.round.obstacles.values()) {
      if (o.state === "gone") continue
      const [px, py] = this.toPixel(o.x, o.z)
      ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill()
    }
    if (r.status === "ended") return
    const [kx, ky] = this.toPixel(...this.round.floatAt(this.round.now()))
    ctx.fillStyle = "#f2c14e"; ctx.strokeStyle = "#111"; ctx.lineWidth = 2
    ctx.beginPath(); ctx.arc(kx, ky, this.expanded ? 7 : 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
    if (this.expanded) { ctx.font = "bold 12px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "bottom"; ctx.fillStyle = "#111"; ctx.fillText("optocht", kx, ky - 9) }
  }

  drawCars() {
    const { ctx } = this
    if (this.remotes) for (const [, rc] of this.remotes.cars) {
      const p = rc.mesh.position
      const [px, py] = this.toPixel(p.x, p.z)
      ctx.fillStyle = "#" + rc.color.toString(16).padStart(6, "0")
      ctx.beginPath(); ctx.arc(px, py, this.expanded ? 5 : 4, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke()
    }
    if (!this.car) return
    const [cx, cy] = this.toPixel(this.car.x, this.car.z)
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(-this.car.yaw)     // yaw 0 = north = up
    const s = this.expanded ? 9 : 7
    ctx.beginPath(); ctx.moveTo(0, -s * 1.3); ctx.lineTo(s * 0.8, s); ctx.lineTo(0, s * 0.5); ctx.lineTo(-s * 0.8, s); ctx.closePath()
    ctx.fillStyle = "#d7412b"; ctx.fill(); ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke()
    ctx.restore()
  }

  drawChrome() {
    const { ctx, w, h } = this
    if (this.hover) {
      ctx.strokeStyle = "rgba(0,0,0,.45)"; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(this.hover[0] - 12, this.hover[1]); ctx.lineTo(this.hover[0] + 12, this.hover[1])
      ctx.moveTo(this.hover[0], this.hover[1] - 12); ctx.lineTo(this.hover[0], this.hover[1] + 12); ctx.stroke()
    }
    // scale bar
    const metres = [100, 200, 500, 1000, 2000, 5000].find((m) => m / this.view.scale > 70) ?? 5000
    const px = metres / this.view.scale
    ctx.fillStyle = "rgba(255,255,255,.75)"; ctx.fillRect(10, h - 30, px + 16, 22)
    ctx.fillStyle = "#333"; ctx.fillRect(18, h - 14, px, 3)
    ctx.font = "11px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"
    ctx.fillText(metres >= 1000 ? `${metres / 1000} km` : `${metres} m`, 18, h - 17)
    ctx.textAlign = "right"; ctx.fillStyle = "rgba(0,0,0,.6)"
    ctx.fillText("slepen · scrollen zoomt · klik teleporteert · F alles · M/Esc sluit", w - 10, h - 10)
  }
}
