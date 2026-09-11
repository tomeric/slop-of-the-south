import * as THREE from "three"

// The round as the server tells it: the town, the parade route, the obstacles and their state, the server clock
// offset and the shared action cooldown, plus every Dutch string on the HUD. Messages handled: sync (on subscribe),
// round (every status change), object (hit points), teleport/switch (verdicts on actions), end. Hooks:
// onRound(body, { fresh, started, live }), onEnd(msg), onAction(msg) for the player's own accepted actions,
// onObjects(list) for the destructibles.
const SLOTS = 60                                                              // stretches of route on the bar
const ICON = { m: "🏠", b: "🏠", t: "🌳", l: "💡", g: "🚦", s: "🪧" }

export class Round {
  constructor(playerId, els, hooks) {
    this.playerId = playerId
    this.els = els
    this.hooks = hooks
    this.offset = 0                 // server clock minus Date.now()
    this.round = null               // the round body from the server, or null while idle
    this.obstacles = new Map()      // key → obstacle, states kept current from `object` messages
    this.nextActionAt = null        // server ms; null = the action is ready
    this.flashTimer = null
  }

  now() { return Date.now() + this.offset }
  get status() { return this.round?.status }
  get running() { return this.status === "running" }

  receive(msg) {
    if (msg.now) this.offset = msg.now - Date.now()
    switch (msg.type) {
      case "sync":   this.nextActionAt = msg.you.next_action_at; this.setRound(msg.round, false); break
      case "round":  this.setRound(msg.round, true); break
      case "object": this.applyObjects(msg.list); break
      case "end":    this.hooks.onEnd?.(msg); break
      case "teleport":
      case "switch":
        if (msg.ok === false) this.flash({ cooldown: `Actie beschikbaar over ${this.countdown()}`, bounds: "Te ver van de arena", status: "Geen ronde bezig" }[msg.reason] ?? "Dat gaat niet")
        else if (msg.id === this.playerId) { this.nextActionAt = msg.next_action_at; this.hooks.onAction?.(msg) }
        break
    }
  }

  setRound(body, live) {
    const prev = this.round
    this.round = body
    this.obstacles = new Map((body?.obstacles ?? []).map((o) => [o.key, o]))
    if (body) {
      const fresh = body.id !== prev?.id, started = body.status === "running" && prev?.status !== "running"
      if (fresh || started) this.nextActionAt = null                 // everyone's action is ready for a new town
      this.hooks.onRound?.(body, { fresh, started, live })
    }
    this.hud()
  }

  applyObjects(list) {
    for (const o of list) {
      const ob = this.obstacles.get(o.key)
      if (ob) { ob.state = o.state; ob.hp = o.hp; ob.max = o.max }
    }
    this.hooks.onObjects?.(list)
  }

  get remaining() {
    let n = 0
    for (const o of this.obstacles.values()) if (o.state !== "gone") n++
    return n
  }

  // the float's motion, mirroring Game::Round on the server
  travelled(now = this.now()) {
    const r = this.round
    if (!r?.started_at) return 0
    return THREE.MathUtils.clamp(r.speed * (now - r.started_at) / 1000, 0, r.path.length)
  }

  progress(now) { return this.round ? this.travelled(now) / this.round.path.length : 0 }

  floatAt(now) {
    const p = this.round.path, t = this.travelled(now) / p.length
    return [p.x0 + (p.x1 - p.x0) * t, p.z0 + (p.z1 - p.z0) * t]
  }

  get heading() { const p = this.round.path; return Math.atan2(-(p.x1 - p.x0), -(p.z1 - p.z0)) }   // yaw: 0 = north, positive = left

  canAct() { return !this.nextActionAt || this.nextActionAt <= this.now() }

  countdown(at = this.nextActionAt) {
    const s = Math.max(0, Math.ceil((at - this.now()) / 1000))
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
  }

  // every 0.25 s from game.js
  hud() {
    const { actie, banner, route } = this.els
    const r = this.round
    actie.hidden = !r
    if (!r) { banner.hidden = route.hidden = true; return }
    const secs = (at) => Math.max(0, Math.ceil((at - this.now()) / 1000))
    const naam = r.arena.name
    if (r.status === "running") {
      banner.hidden = true
      this.routeBar()
    } else if (r.status === "intermission") {
      route.hidden = true
      this.showBanner(naam, `Optocht start over ${secs(r.next_at)} s`)
    } else {
      route.hidden = true
      this.showBanner(r.result === "won" ? "Alaaf! Optocht binnen" : "Optocht vastgelopen", `Volgende plaats over ${secs(r.next_at)} s`)
    }
    actie.textContent = this.canAct() ? "Actie: klaar" : `Actie over ${this.countdown()}`
  }

  // the route as a bar: the float where it is, and an icon per stretch of route for the obstacles still standing
  // there (the commonest kind, with a count when there are more), the cleared part tinted behind the float
  routeBar() {
    const { route, routeKop, routeGedaan, routeIconen, routeOptocht } = this.els
    const r = this.round, len = r.path.length, p = this.progress()
    route.hidden = false
    routeKop.textContent = `Ronde ${r.id} · ${r.arena.name}`
    routeGedaan.style.width = routeOptocht.style.left = `${(p * 100).toFixed(1)}%`
    const buckets = new Map()
    for (const o of this.obstacles.values()) {
      if (o.state === "gone") continue
      const i = THREE.MathUtils.clamp(Math.floor(o.at / len * SLOTS), 0, SLOTS - 1)
      const b = buckets.get(i) ?? { n: 0, kinds: {} }
      b.n++; b.kinds[o.kind] = (b.kinds[o.kind] ?? 0) + 1
      buckets.set(i, b)
    }
    const html = [...buckets].sort((a, b) => a[0] - b[0]).map(([i, b]) => {
      const kind = Object.entries(b.kinds).sort((a, c) => c[1] - a[1])[0][0]
      return `<span class="route-icoon${b.n > 1 ? " meer" : ""}" style="left:${((i + 0.5) / SLOTS * 100).toFixed(1)}%" data-n="${b.n}">${ICON[kind] ?? ICON.m}</span>`
    }).join("")
    if (html !== this.routeHtml) { this.routeHtml = html; routeIconen.innerHTML = html }
  }

  showBanner(title, sub) {
    const { banner, bannerTitel, bannerSub } = this.els
    bannerTitel.textContent = title
    bannerSub.textContent = sub
    banner.hidden = false
  }

  // a short toast at the bottom of the screen
  flash(text) {
    const { flits } = this.els
    flits.textContent = text
    flits.hidden = false
    clearTimeout(this.flashTimer)
    this.flashTimer = setTimeout(() => { flits.hidden = true }, 2200)
  }
}
