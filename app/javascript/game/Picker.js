import { VEHICLES } from "game/Vehicles"

// The vehicle picker: three cards with a speed bar and the trick, and the field to change your name. Free while no
// round runs (at the first join and behind the loading screen between towns); during a round picking costs the
// shared action. Click or 1–3 picks, Enter keeps what you have, Escape closes. In the lobby the strip stays up after
// a pick, so the name can still be changed; the mid-round picker closes on a pick. Keys typed into the name field
// stay there: they neither drive nor pick.
export class Picker {
  constructor(el, { onPick, onName }) {
    this.el = el
    this.onPick = onPick
    this.kaarten = el.querySelector(".kaarten")
    this.hint = el.querySelector(".kiezer-hint")
    this.naam = el.querySelector("input")
    this.naam.value = localStorage.getItem("driverName") ?? ""
    const commit = () => { const name = this.naam.value.trim().slice(0, 16); if (name && name !== localStorage.getItem("driverName")) onName(name) }
    this.naam.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.code === "Enter" || e.code === "Escape") this.naam.blur() })
    this.naam.addEventListener("keyup", (e) => e.stopPropagation())
    this.naam.addEventListener("blur", commit)
    this.free = true
    this.current = null
    this.kaarten.innerHTML = VEHICLES.map((v, i) => {
      const bars = Math.round(v.maxSpeed / 10)
      return `<div class="kaart" data-id="${v.id}"><kbd>${i + 1}</kbd><b>${v.naam}</b><div class="snelheid">${"▮".repeat(bars)}${"▯".repeat(5 - bars)}</div><p>${v.blurb}</p></div>`
    }).join("")
    this.kaarten.addEventListener("click", (e) => { const k = e.target.closest(".kaart"); if (k) this.pick(k.dataset.id) })
    addEventListener("keydown", (e) => { if (this.open && (e.code === "Enter" || e.code === "Escape")) this.hide() })
  }

  get open() { return !this.el.hidden }

  show(current, free) {
    this.free = free
    this.mark(current)
    this.hint.textContent = free ? "Klik of 1–6 · Enter houdt wat je hebt" : "Wisselen kost je actie (één per minuut) · Esc sluit"
    this.el.hidden = false
  }

  hide() { if (this.open) this.naam.blur(); this.el.hidden = true }

  mark(id) {
    this.current = id
    for (const k of this.kaarten.children) k.classList.toggle("actief", k.dataset.id === id)
  }

  pick(id) {
    if (id !== this.current) this.onPick(VEHICLES.find((v) => v.id === id), this.free)
    if (this.free) this.mark(id)
    else this.hide()
  }

  digit(n) { if (this.open && VEHICLES[n - 1]) this.pick(VEHICLES[n - 1].id) }
}
