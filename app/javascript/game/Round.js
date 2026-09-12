import * as THREE from "three"
import { euro } from "game/Tuning"

// The round as the server tells it: the town, the parade route, the obstacles and their state, the vote on the
// next town, the server clock offset and the shared action cooldown, plus every Dutch string on the HUD. Messages
// handled: sync (on subscribe), round (every status change), object (hit points), vote (the tally), teleport/switch
// (verdicts on actions), end. Hooks: onRound(body, { fresh, started, live }), onEnd(msg), onAction(msg) for the
// player's own accepted actions, onObjects(list) for the destructibles, onVote(vote or null).
const SLOTS = 60                                                              // stretches of route on the bar
const ICON = { m: "🏠", b: "🏠", t: "🌳", l: "💡", g: "🚦", s: "🪧", d: "🧱" }
const RUBBLE_ICON = "🧱"                                                      // a flattened thing still in the way
// the strip of road the float needs clear, and how far in front of it rubble is worth reporting at all. Both match
// Game::Round::DEBRIS_AHEAD on the server, which is the side that decides.
const PARADE = { corridor: 7, ahead: 45 }

export class Round {
  constructor(playerId, els, hooks) {
    this.playerId = playerId
    this.els = els
    this.hooks = hooks
    this.offset = 0                 // server clock minus Date.now()
    this.round = null               // the round body from the server, or null while idle
    this.obstacles = new Map()      // key → obstacle, states kept current from `object` messages
    this.vote = null                // the vote between rounds: { candidates, by, ends_at }, or null
    this.nextActionAt = null        // server ms; null = the action is ready
    this.damage = 0                 // euros of property the room has flattened this round (lib/game/round.rb totals it)
    this.flashTimer = null
  }

  now() { return Date.now() + this.offset }
  get status() { return this.round?.status }
  get running() { return this.status === "running" }

  receive(msg) {
    if (msg.now) this.offset = msg.now - Date.now()
    switch (msg.type) {
      case "sync":   this.nextActionAt = msg.you.next_action_at; this.setRound(msg.round, false); this.setVote(msg.vote ?? null); break
      case "round":  this.setVote(null); this.setRound(msg.round, true); break
      case "vote":
        if (msg.ok === false) this.flash(msg.reason === "unknown" ? "Die plaats ken ik niet" : "De stemming is gesloten")
        else this.setVote(msg.vote)
        break
      case "object": this.applyObjects(msg.list, msg.damage); break
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
    this.damage = body?.damage ?? 0                                  // a new town starts the bill again
    this.obstacles = new Map((body?.obstacles ?? []).map((o) => [o.key, o]))
    if (body) {
      const fresh = body.id !== prev?.id, started = body.status === "running" && prev?.status !== "running"
      if (fresh || started) this.nextActionAt = null                 // everyone's action is ready for a new town
      this.hooks.onRound?.(body, { fresh, started, live })
    }
    this.hud()
    this.showDamage()
  }

  // free roam has no server to keep the total, so it keeps its own
  addDamage(euros) {
    if (!(euros > 0)) return
    this.damage += euros
    this.showDamage()
  }

  showDamage() {
    const el = this.els.schade
    if (!el) return
    el.hidden = !(this.damage > 0)
    if (!el.hidden) el.textContent = `${euro(this.damage)} schade`
  }

  setVote(vote) {
    if (!vote && !this.vote) return
    this.vote = vote
    this.hooks.onVote?.(vote)
  }

  applyObjects(list, damage) {
    if (damage != null) this.damage = damage
    for (const o of list) {
      const ob = this.obstacles.get(o.key)
      if (ob) { ob.state = o.state; ob.hp = o.hp; ob.max = o.max }
    }
    this.hooks.onObjects?.(list)
    this.showDamage()
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

  // How far along the parade route a point lies, or null if the float does not have to care about it: off to the
  // side, behind it, or so close in front that nobody could clear it in time. The server applies the same rule, so
  // this only saves the traffic.
  onRoute(x, z) {
    const r = this.round
    if (!this.running || !r) return null
    const p = r.path, dx = p.x1 - p.x0, dz = p.z1 - p.z0
    const len2 = dx * dx + dz * dz || 1
    const t = ((x - p.x0) * dx + (z - p.z0) * dz) / len2
    const at = t * p.length
    if (at <= this.travelled() + PARADE.ahead || at >= p.length) return null
    const off = Math.hypot(x - (p.x0 + dx * t), z - (p.z0 + dz * t))
    return off <= PARADE.corridor ? at : null
  }

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
      route.hidden = false
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

  // the route as a vertical bar, start at the bottom: the float where it is, an icon per stretch of route for the
  // obstacles still standing there (the commonest kind, with a count when there are more), the cleared part tinted
  // behind the float. Rendered into the HUD's bar during the round and into the loading screen's before it.
  routeBar(container = this.els.route) {
    const r = this.round, len = r.path.length, p = this.progress()
    const q = (cls) => container.querySelector(cls)
    q(".route-kop").textContent = `Ronde ${r.id} · ${r.arena.name}`
    q(".route-gedaan").style.height = q(".route-optocht").style.bottom = `${(p * 100).toFixed(1)}%`
    const buckets = new Map()
    for (const o of this.obstacles.values()) {
      if (o.state === "gone") continue
      const i = THREE.MathUtils.clamp(Math.floor(o.at / len * SLOTS), 0, SLOTS - 1)
      const b = buckets.get(i) ?? { n: 0, rubble: 0, kinds: {} }
      b.n++; b.kinds[o.kind] = (b.kinds[o.kind] ?? 0) + 1
      if (o.state === "rubble" || o.kind === "d") b.rubble++
      buckets.set(i, b)
    }
    const html = [...buckets].sort((a, b) => a[0] - b[0]).map(([i, b]) => {
      const kind = Object.entries(b.kinds).sort((a, c) => c[1] - a[1])[0][0]
      const icon = kind === "d" || b.rubble >= b.n ? RUBBLE_ICON : ICON[kind] ?? ICON.m
      return `<span class="route-icoon${b.n > 1 ? " meer" : ""}" style="bottom:${((i + 0.5) / SLOTS * 100).toFixed(1)}%" data-n="${b.n}">${icon}</span>`
    }).join("")
    if (html !== container.routeHtml) { container.routeHtml = html; q(".route-iconen").innerHTML = html }
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
