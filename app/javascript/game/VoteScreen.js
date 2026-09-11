// Between rounds: where does the parade go next? A handful of towns to pick from, a field to type another one in,
// fifteen seconds on the clock. One vote per player, changeable until the clock runs out; the server keeps the
// tally and sends it back after every vote.
import { bindName } from "game/NameField"

const KIND = { city: "stad", town: "stad", village: "dorp" }

export class VoteScreen {
  constructor(el, { onVote, onName }) {
    this.el = el
    this.kop = el.querySelector(".stem-kop")
    this.list = el.querySelector(".stem-lijst")
    this.input = el.querySelector(".stem-plaats")
    this.klok = el.querySelector(".stem-klok")
    this.naam = bindName(el.querySelector(".naam input"), onName)
    this.playerId = null
    this.list.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) onVote(b.dataset.name) })
    // typing must not drive the car or pick a vehicle: the keys stop here
    this.input.addEventListener("keydown", (e) => {
      e.stopPropagation()
      if (e.code === "Enter" && this.input.value.trim()) { onVote(this.input.value.trim()); this.input.value = "" }
    })
    this.input.addEventListener("keyup", (e) => e.stopPropagation())
  }

  get open() { return !this.el.hidden }

  // vote: { candidates: [{ name, kind, votes }], by: { playerId: name }, ends_at }; round: the one just played
  show(vote, playerId, round) {
    this.playerId = playerId
    this.kop.textContent = round ? `${round.result === "won" ? "Alaaf! De optocht kwam binnen in" : "De optocht liep vast in"} ${round.arena.name}` : "Vastelaovend in Limburg"
    this.naam.refresh()
    this.update(vote)
    this.el.hidden = false
    setTimeout(() => this.input.focus(), 50)
  }

  update(vote) {
    const mine = vote.by[this.playerId]
    this.list.innerHTML = vote.candidates.map((c) =>
      `<button data-name="${escape(c.name)}" class="${c.name === mine ? "mijn" : ""}"><b>${escape(c.name)}</b><span>${KIND[c.kind] ?? c.kind}</span><em>${c.votes}</em></button>`).join("")
  }

  countdown(secs) { this.klok.textContent = `Nog ${secs} s` }

  hide() {
    if (this.open) { this.input.blur(); this.naam.blur() }
    this.el.hidden = true
  }
}

function escape(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]) }
