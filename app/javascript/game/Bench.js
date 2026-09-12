// Frame cost at three fixed spots, so a render change can be judged against a number instead of a feeling.
// ?bench=bos|dorp|veld parks the car there (free roam, clock frozen at one o'clock), waits until every tile around
// it is in and the grass has caught up, watches two seconds of ordinary frames, then measures. requestAnimationFrame
// is capped to the screen's refresh rate, so the frame time alone says nothing while there is headroom: the measure
// pass renders the scene EXTRA more times per frame, reads a pixel back to wait for the GPU, and divides.
// The result lands on slop.bench.result and in the console. Read it in a real browser — script/browse.rb runs a
// software rasteriser, where the counts are still true but the milliseconds are not.
const WATCH = 2, FRAMES = 300, EXTRA = 3     // ?frames= and ?extra= cut these down for a smoke test

export const SPOTS = {
  bos:  { name: "bos", x: 6245, z: -62225, yaw: 0.6 },    // a conifer wood: the worst triangle count
  dorp: { name: "dorp", x: 12750, z: -24750, yaw: 0 },    // the densest village tile: the worst draw-call count
  veld: { name: "veld", x: 116, z: 3796, yaw: 0 },        // open farmland: the worst ground fill and grass carpet
}

export class Bench {
  constructor(world, spot, settled, { frames = FRAMES, extra = EXTRA } = {}) {
    this.world = world
    this.spot = spot
    this.settled = settled
    this.want = Math.max(1, frames)
    this.extra = Math.max(1, extra)
    this.state = "wacht"
    this.t = 0
    this.frames = []
    this.renders = []
    this.updates = []                                                       // CPU per frame: the physics lives here
    this.result = null
    this.gl = world.renderer.getContext()
    this.pixel = new Uint8Array(4)
    this.gpuTimer = !!this.gl.getExtension("EXT_disjoint_timer_query_webgl2")   // reported only: the finish below is enough
  }

  // once per frame, right after the scene has been drawn
  frame(dt) {
    if (this.state === "klaar") return
    if (this.state === "wacht") {
      if (this.settled()) { this.state = "kijk"; this.t = 0 }
      return
    }
    this.t += dt
    if (this.updateMs) this.updates.push(this.updateMs)           // whatever game.js timed around its update block
    if (this.state === "kijk") {                                  // ordinary frames: is the refresh rate being held?
      this.frames.push(dt * 1000)
      if (this.t > WATCH) { this.state = "meet"; this.renders.length = 0 }
      return
    }
    const t0 = performance.now()                                  // what one render of this scene really costs
    for (let i = 0; i < this.extra; i++) this.world.render()
    // the GPU runs behind the CPU, and finish() only waits for the command buffer: reading one pixel back is what
    // actually blocks until the frame is drawn
    this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, this.pixel)
    this.renders.push((performance.now() - t0) / this.extra)
    if (this.renders.length >= this.want) this.finish()
  }

  finish() {
    this.state = "klaar"
    const info = this.world.renderer.info
    this.result = {
      spot: this.spot.name,
      frameMs: percentiles(this.frames),                          // with one render a frame, so capped by vsync
      renderMs: percentiles(this.renders),                        // one render, unthrottled: the number to compare
      updateMs: percentiles(this.updates),                        // the CPU side: car, collision, physics step
      physics: this.world.physics?.stats && { ...this.world.physics.stats },
      calls: info.render.calls, triangles: info.render.triangles,
      programs: info.programs.length, textures: info.memory.textures, geometries: info.memory.geometries,
      pixelRatio: this.world.renderer.getPixelRatio(), gpuTimer: this.gpuTimer,
    }
    console.log("bench", JSON.stringify(this.result))
  }
}

function percentiles(list) {
  if (!list.length) return null
  const s = [...list].sort((a, b) => a - b)
  const at = (p) => Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 100) / 100
  return { p50: at(0.5), p90: at(0.9), p99: at(0.99), n: s.length }
}
