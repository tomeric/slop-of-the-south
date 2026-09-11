import { createConsumer } from "@rails/actioncable"

// Thin wrapper around the GameChannel subscription. Every message reaches onMessage, the player's own echoes
// included; game.js decides per type what to do with them. `offline` (vrij rijden) never opens the socket at all:
// send becomes a no-op and no message ever arrives, so there is no round, no reset and nobody else on the map.
export class Network {
  constructor({ room, onMessage, offline = false }) {
    this.offline = offline
    this.ready = false
    if (offline) return
    this.consumer = createConsumer()
    const name = localStorage.getItem("driverName") || `Chauffeur ${Math.floor(Math.random() * 900 + 100)}`
    this.sub = this.consumer.subscriptions.create({ channel: "GameChannel", room, name }, {
      connected: () => { this.ready = true },
      disconnected: () => { this.ready = false },
      received: (msg) => onMessage(msg),
    })
  }

  // Only send once the subscription is confirmed; earlier performs are dropped server-side with a warning.
  send(action, data) { if (this.ready) this.sub.perform(action, data) }
  sendMove(state) { this.send("move", state) }
}
