// Keyboard state. Held keys are read every frame by Vehicle; one-shot presses (R, M) are recorded on keydown and
// consumed by the first frame that asks, so a quick tap is never missed.
export class Input {
  constructor() {
    this.keys = new Set()
    this.pressed = new Set()
    addEventListener("keydown", (e) => {
      this.keys.add(e.code)
      if (!e.repeat) this.pressed.add(e.code)
      if (e.code === "Space") e.preventDefault()
    })
    addEventListener("keyup", (e) => this.keys.delete(e.code))
  }
  get throttle()  { return (this.keys.has("KeyW") || this.keys.has("ArrowUp")) ? 1 : 0 }
  get brake()     { return (this.keys.has("KeyS") || this.keys.has("ArrowDown")) ? 1 : 0 }
  get steer()     { return ((this.keys.has("KeyA") || this.keys.has("ArrowLeft")) ? 1 : 0) - ((this.keys.has("KeyD") || this.keys.has("ArrowRight")) ? 1 : 0) }
  get handbrake() { return this.keys.has("Space") }
  get boost()     { return this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") }
  get reset()     { return this.consume("KeyR") }
  get flip()      { return this.consume("KeyQ") }      // back on your wheels where you stand (F belongs to the map)
  get toggleMap() { return this.consume("KeyM") }
  get mute()      { return this.consume("KeyN") }
  get ability()   { return this.consume("KeyE") }
  get pick()      { return this.consume("KeyV") }
  get digit()     { for (let i = 1; i <= 6; i++) if (this.consume(`Digit${i}`)) return i; return 0 }
  get timeStep()  { return (this.consume("Period") ? 1 : 0) - (this.consume("Comma") ? 1 : 0) }   // , and . wind the clock (vrij rijden)
  consume(code)   { const had = this.pressed.has(code); this.pressed.delete(code); return had }
}
