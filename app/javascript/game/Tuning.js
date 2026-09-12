// Every knob of the car feel, camera and effects in one place. Live-tweakable from the console: window.slop.tuning.
// Units: metres, seconds, radians. Rates are 1/s (exponential approach), smooth times are seconds (critically damped).
export const TUNING = {
  car: {
    maxSpeed: 44,          // m/s ≈ 160 km/h
    accel: 9,
    brakeForce: 20,
    maxSteer: 0.55,        // rad at standstill
    steerRate: 8,          // /s: how fast the wheels reach the wanted angle
    reverseFrac: 0.25,     // reverse top speed as a fraction of maxSpeed
    // Drag, as m/s² so it reads like the rest: `drag * v²/maxSpeed + roll` is what the engine has to beat, and
    // where the two meet is the top speed. `roll` is under the arcade model's 0.8 because a real tyre model has
    // losses of its own that the old one did not.
    drag: 0.35, roll: 0.5,
    holdBelow: 1.5, hold: 12,   // hands off the controls below this speed and the brakes hold it on a slope
  },
  drift: {
    minSpeed: 8,           // m/s needed to start or hold a drift
    gripNormal: 1.0, gripDrift: 0.22, gripMild: 0.55,
    latDampMax: 14,        // /s: sideways speed decays this fast at full grip (≈70 ms to kill a slide)
    gripInRate: 12,        // grip drops this fast when a drift starts
    gripOutRate: 6,        // …and comes back this fast on release (≈0.35–0.5 s)
    maxLatAccel: 14,       // m/s²: the tyres' grip limit; steering that asks for more is capped (and slides mildly)
    driftMaxYaw: 0.9,      // rad/s: steering-driven rotation cap while drifting
    yawGain: 1.6,          // steering counts this much more while drifting
    yawSustain: 0.45,      // rad/s of free rotation in the drift direction at speed (keeps the slide going)
    yawRateSmooth: { grip: 12, drift: 4 },
    redirect: { grip: 0.97, drift: 0.9 },          // share of the scrubbed sideways speed that turns into forward speed (1 = turning is free)
    steerLockBonus: 1.35,
    handbrakeDecel: 2.5,   // m/s² while drifting (a plain handbrake stop scrubs 12)
    slideDrag: 1.0,        // m/s² of extra drag while sliding
    maxSlip: 0.9,          // rad: past this the slide is damped extra so the car never spins out
    naturalDrift: { minSpeed: 22, latAccel: 11 },   // sharp turns at speed slide mildly on their own
    mildSlip: 0.32,        // rad: under this the car is merely sliding, over it it is properly sideways
    chargeSlip: 0.14,      // rad of slip before drift time counts towards the turbo
    chargeLevels: [0.7, 1.5, 2.5],                  // seconds of drift → level 1, 2, 3
  },
  boost: {
    drainTime: 3.0,        // seconds of nitro in a full meter
    refillTime: 25,        // seconds to trickle back to full
    reengage: 0.12,        // meter needed to start boosting again after running dry
    burst: [0, 0.5, 0.9, 1.4],                      // seconds of free boost per drift charge level
    meterPerLevel: 0.12,
    pickupFill: 0.35, pickupBurst: 0.4,             // a road pad fills 35 % and gives a short free kick
    speedBonus: 0.28,      // top speed +28 % at full boost
    accelBonus: 0.9,       // acceleration +90 %
    powerSmooth: 6,        // /s: boost power ramps in and out
    overspeedBleed: 2,     // /s: speed above the current cap bleeds off instead of snapping
  },
  camera: {
    dist: 8.5, distPerSpeed: 2.5, distBoost: 1.2,
    height: 3.4, heightPerSpeed: 0.8,
    lookAhead: 3.0, lookHeight: 1.6,
    posSmooth: 0.18, lookSmooth: 0.08, yawSmooth: 0.22,
    velBlend: 0.6, velBlendDrift: 0.85,             // how much the camera sits behind the velocity rather than the nose
    velBlendMinSpeed: 3, velBlendFullSpeed: 11,
    fov: 60, fovPerSpeed: 10, fovBoost: 8, fovMax: 78, fovSmooth: 0.3,
    groundClearance: 1.0,
  },
  susp: {
    heaveHz: 1.8, heaveZeta: 0.35,
    attitudeHz: 2.2, attitudeZeta: 0.4,
    pitchPerAccel: 0.012, rollPerAccel: 0.016,      // rad per m/s²
    maxPitch: 0.12, maxRoll: 0.14,
    travel: 0.35,          // wheel and body travel limit
    maxCornerDrop: 1.0,    // a corner more than this below/above the centre is an unloaded tile: use the centre height
    wheelRadius: 0.33,
    accelSmooth: 10,
  },
  pickups: {
    kinds: ["primary", "secondary", "tertiary", "residential", "unclassified"],
    spacingMin: 300, spacingMax: 500, firstOffset: 60,
    minStraight: 40, maxBend: 0.35,                 // a pad needs 40 m of road bending less than 0.35 rad around it
    radius: 2.2, respawn: 20, height: 0.5, size: 2.4,
  },
  fx: { smokeRate: 28, smokeLife: 0.7, smokeSlip: 0.18, smokePool: 64, flameFlicker: 0.4 },
  light: {
    exposure: 0.95, nightExposure: 0.25,      // toneMappingExposure = exposure + nightExposure × (1 − daylight) (live)
    hemi: 0.45, sun: 1.35,                    // the sky light and the sun, now that the environment map carries the ambient (live)
    env: { on: true, size: 64, sigma: 0.08, intensity: [0.3, 0.85], glare: 6,   // the baked sky (game/Environment.js)
           step: 0.02, minInterval: 0.25, maxInterval: 2, skipMs: 24 },         // re-bake this far apart, never on a slow frame
    outline: { on: true, thickness: 0.003, color: [0.12, 0.08, 0.1], alpha: 0.85 },   // cartoon edges on buildings and cars (on: true, thickness: reload)
    // the sun's shadow (game/Shadows.js). `on` is a boot setting — ?schaduw turns it on, ?schaduw=0 off — because
    // castShadow and the map size recompile every program in the scene; `strength` is live.
    shadow: { on: false, size: 2048, half: 140, dist: 400, ahead: 0.45, strength: 1, bias: 0, normalBias: 0.25 },
  },
  buildings: {
    storey: 3.0, bay: 2.8,                    // a facade cell: one storey tall, one bay wide (reload: baked into the UVs)
    minWidth: 2.0, minHeight: 2.4,            // walls smaller than this get plain brick instead of a window
    lit: 0.42,                                // how brightly the windows burn at night (live)
    // The lit rooms behind the windows of a built house. `threshold` is how bright a room has to want to be before
    // its light is on at all, so 1 - threshold of them are dark; `swing` is how far the slow clock can carry a room
    // across that line, which is the share of the street that changes while you watch; `rate` is how fast it goes
    // round — a day here is six minutes, so this is a couple of turns a night.
    rooms: { threshold: 0.45, swing: 0.1, rate: 0.07 },
    detail: { on: true, cell: 125, radius: 1 },   // plinths, gutters, sills and doors, streamed 3x3 cells around the car
    // The houses near enough to look into are not a shell with windows painted on it but a stack of pieces: panels
    // with real openings and thickness, floors, partitions and roof (game/Structure.js). `radius` is the whole cost.
    structure: {
      on: true, radius: 80, keep: 1.25, perFrame: 1, budgetMs: 5,
      maxBuildings: 48,       // the hard cap: past it the nearest win and the rest keep their shell (draw calls)
      thick: 0.25,            // the outer leaf, extruded inwards: the surveyed silhouette does not move
      reveal: 0.12,           // how far the glass sits behind the outer face
      minPiece: 0.5,          // a face smaller than this either way is not worth cutting up
      minArea: 0.35,          // m²: a cell smaller than this is dropped rather than made a piece of
      tilt: 0.26,             // |n.y| over this and a face labelled "wall" is a horizontal sliver: skip it
      panel: 3.2,             // metres: how big a piece of roof is
      roofThick: 0.16,
      interior: true,         // floors, partitions, doorways and stairs (reload: they are baked into the pieces)
      floorThick: 0.22, slabs: 6,        // slabs: roughly how many pieces one floor is cut into
      partThick: 0.1, partStep: 2.5, doorWide: 1.0,
      doorHigh: 2.1, doorReach: 22,      // the front door, on the widest wall with a street this close in front of it
      // how many bay-by-storey cells one lump of masonry is, drawn from at random: mostly threes and fours, so
      // a wall comes apart in tetrominoes rather than in neat rectangles (reload)
      clump: [1, 2, 2, 3, 3, 3, 4, 4, 4],
      stairs: true, stairWide: 1.0, stairLong: 3.2,
      roomBack: 0.45, roomOver: 0.12,    // how far inside the wall the lit room panel sits, and how far it oversails
    },
  },
  // The rigid-body world (game/Physics.js). `on` is a boot setting — ?fysica=0 never even downloads the engine —
  // and everything under it is live. Gravity is heavier than the real thing on purpose: debris that falls at 9.8
  // reads as polystyrene at this scale.
  physics: {
    on: true, step: 1 / 60, maxSteps: 3, gravity: -16, interpolate: true,
    floorDrop: 4,                             // this far under the ground = the tile went out from under it; recycle
    warpJump: 12,                             // the car moving further than this in one frame is a teleport, not driving
    debris: { density: 900, friction: 0.9, bounce: 0.05, linear: 0.05, angular: 0.4, maxFall: 11,
              sweepAhead: 1.4, sweepPush: 12, sweepHigh: 2.5, bladeExtra: 1.3,
              sweepLift: 0.4, sweepSteps: 6 },   // the swath is swept from where the blade was to where it is   // what the front of a vehicle does
              // to loose rubbish, and how far past the plate the blade's swath reaches   // maxFall x step must stay well under the smallest chip
    // The second tier of solid: a shell of slabs, one per footprint edge, on every intact building inside `radius`
    // that is not built out of pieces — the overflow past `maxBuildings`, whatever is still queued, and the OSM
    // boxes that have no faces to build from. Without it a car drives straight through them.
    solid: { radius: 60, keep: 1.25, perFrame: 24, thick: 0.3, jog: 0.15, trunk: 0.28, trunkOf: 0.45 },   // jog: surveyed wiggles smaller than this are not worth a collider
    // The chassis and its wheels (Rapier's raycast vehicle controller). Stiffness, compression and relaxation are
    // Bullet's own units, which scale with the weight the solver puts on each wheel, so they are given straight
    // rather than derived from `susp`. maxFall is the car's terminal velocity for the same reason the debris has
    // one: a heightfield triangle has no thickness, and the trike's hull is only 0.84 m of it.
    car: {
      rest: 0.32, stiffness: 250, compression: 11, relaxation: 11, forceHeadroom: 8,
      frictionSlip: 2.0, sideStiffness: 1.0, handbrakeSlip: 0.25,   // what the rear tyres keep on the handbrake
      angularDamping: 0.5, hullFriction: 0.4, contactForce: 2000,
      maxFall: 14, floorDrop: 6, dropIn: 0.4,   // dropIn: how far above the ground a teleport puts the car down
      rightAfter: 5, stuckSpeed: 1.0,           // seconds upside down and going nowhere before it rights itself
    },
    // The monster truck's thrusters: held down, not fired. `ratio` is thrust to weight at a standstill, tapering to
    // exactly hover as the climb reaches `vMax` — flat thrust would be a rocket, not a jump. `drainScale` is the
    // share of the boost meter's drain rate, so a full meter is six seconds of flight rather than three.
    thrust: { ratio: 1.7, height: 18, damp: 0.8, vMax: 12, drainScale: 0.5, spread: 0.72 },
    // The debris pool, split between the materials the world is made of (game/Physics.js DEBRIS). `minChip` is
    // the floor on a collider's smallest dimension: under `maxFall x step` it goes through the ground.
    // Two grades. `coarseShare` of each pool is the big stuff a wall actually comes apart into, which is what
    // the parade stops for; the rest is `fineScale` of that size and is what is left once somebody has cleared
    // the big stuff, which the float drives straight over.
    chips: { pool: 300, size: 0.5, speed: 7, life: 30, minChip: 0.22, coarseShare: 0.45, fineScale: 0.55, crumbleTo: 2 },   // pool: reload
    pieces: { max: 160, perFrame: 24, damage: 1.4, settle: 2.5, chips: 4, shards: 6, maxShards: 16, shatter: 9 },   // chips off a broken
                                              // panel, and the shards a pane goes into instead of toppling   // in the air at once, how many may let go per frame, and
                                              // how hard breaking one counts against the building's own hit points
    // what holds what up (game/Support.js): weld is how far apart two pieces may be and still touch, slack how far
    // a supporter's top may overshoot, overhang how far a floor may hang past whatever is left under it
    support: { weld: 0.15, slack: 0.4, groundBite: 0.4, overhang: 2.5 },
    // driving through a wall rather than off it: how fast you have to be, what each panel costs you, and the floor
    smash: { speed: 9, exit: 4, loss: 0.7, reach: 1.0, maxPanels: 3, shove: 0.35, damage: 4, grind: 2.5,
             ahead: 1.2, perFrame: 14, perNewton: 30000 },   // how far in front of the bumper the path is cleared, how
             // much of it a frame, and how many newtons of traction it takes to grind one panel off per second
    blast: { reach: 0.8, push: 7 },           // a rocket takes the pieces within this much of its radius with it
  },
  // What a hit costs: k x 1/2 m v^2 x the vehicle's `bite` x which part of it made contact. Calibrated so each
  // vehicle lands on what its old hand-picked `ram` coefficient gave at its own ramming speed, but moving with
  // mass and speed from here on instead of sitting in a table.
  // The trike's rocket. `pitch` is how far the launcher is angled up, worked out rather than guessed: under this
  // world's gravity, from a 1.35 m muzzle, 16 degrees sails clean over a two-storey house at every range you would
  // ever fire from. Seven degrees at 75 m/s keeps it at wall height at 20, 40 and 80 m and still shows an arc.
  missile: { speed: 75, life: 3, r: 6, dmg: 70, pitch: 0.12, step: 1.2 },
  damage: {
    k: 5e-4,                                // hit points per joule delivered
    through: 0.25,                          // a wall you go through takes a quarter: the panels bill the rest
    grind: 2e-4,                            // hit points per newton of traction per second, leaning on a wall
    landMin: 4,                             // m/s of landing before the underside counts as a hit
  },
  // The parade and what gets in its way. `heap` is how wide one of the server's rubble heaps is to drive into;
  // `report` how often a client tells the server where its debris came to rest (the channel allows 2 a second).
  parade: { heap: 4, report: 0.5 },
  money: { label: 40000 },                  // € off one building before a bang goes up over it: ~7 to flatten a house (live)
  sky: { clouds: { cover: 0.42, scale: 2.6, speed: 0.01 } },             // a noise band on the sky dome; cover 0 turns it off (live)
  trees: { jitter: { hue: 0.07, sat: 0.5, pale: 0.6, level: 1.14, light: 0.26 } },   // a wood is not one tree stamped a thousand times (reload)
  ground: {
    detail: { repeat: 125, strength: 0.45, fadeNear: 120, fadeFar: 300, jitter: 0.6 },   // the grain each class wears: 125 repeats over 500 m = 4 m, fading with distance, class edges stippled by this much (live)
    paint: { minPx: 24, maxPolys: 160, budgetMs: 8 },                       // cover canvas detail: only polygons this big, this many, this long
    sway: { amp: 0.18, speed: 1.7 },                                        // grass in the wind (live)
    wake: { radius: 2.6, push: 0.55 },                                      // grass bends away from the car and springs back (live)
    near: { cell: 10, radius: 6, perCell: 80, perFrame: 12, fadeStart: 46, fadeEnd: 58 },   // the grass carpet around the car: cells of this size, this many out, at most this many tufts each
    bushCap: 700, hedgeCap: 800,                                            // per tile, counted apart
    roadMargin: 0.8, urbanMargin: 2.5,                                      // keep off the roads (and the sidewalks in built-up tiles)
    reeds: { spacing: 4, offsetMin: 0.5, offsetMax: 1.5 },                  // along water edges, pushed onto the land
    flatten: { pad: 0.9, squashY: 0.25, squashXZ: 1.3, puffs: 3, puffColor: 0x6f9a44 },
    classes: {                                                              // by land-cover code: m² per grass tuft (dens) and per bush, and which tufts
      1:  { dens: 2.2, mix: ["grass", "grass", "grass", "grass", "flower"] },  // grasland agrarisch
      2:  { dens: 1.6, mix: ["grass", "grass", "grass", "dry", "flower"], bush: 2500 },
      3:  { dens: 2.5, mix: ["grass", "grass", "flower"], bush: 600 },       // groenvoorziening
      4:  { dens: 12, mix: ["dry"] },                                        // bouwland: stubble between the crop rows
      5:  { dens: 2.5, mix: ["grass"] },
      6:  { dens: 3, mix: ["grass"] },
      7:  { dens: 3.5, mix: ["fern", "fern", "grass"], bush: 400 },          // bos
      8:  { dens: 1.6, mix: ["heather", "heather", "dry"], bush: 800, gorse: true },
      9:  { dens: 3, mix: ["grass"], bush: 25 },                             // struiken
      10: { dens: 1.4, mix: ["reed", "reed", "grass"] },                     // rietland
      11: { dens: 5, mix: ["dune"] },                                        // zand
      13: { dens: 5, mix: ["fern", "grass"], bush: 500 },                    // naaldbos: darker floor, fewer ferns
      14: { dens: 4, mix: ["fern", "grass"], bush: 450 },                    // gemengd bos
      15: { dens: 3, mix: ["grass", "fern"], bush: 120 },                    // houtwal
      16: { dens: 1.6, mix: ["reed", "grass"] },                             // moeras
      17: { dens: 2.5, mix: ["grass", "dry"] },                              // kwelder
      18: { dens: 4, mix: ["dune"] },                                        // duin
      19: { bush: 1.5, hedge: true, margin: 0.3 },                           // haag: a dense row of dark bushes
      20: { bush: 900 },                                                     // erf: bushes in the yards, no grass
      24: { dens: 8, mix: ["dry"] },
      25: { dens: 2, mix: ["grass", "grass", "flower", "dry"], margin: 0.3 },  // berm: right up to the road
    },
  },
}

// Euros, the way a Dutch newsreader would say them: € 340.000, € 1,2 mln, € 12 mln, € 1,4 mrd.
export function euro(n) {
  const v = Math.round(n)
  if (v >= 1e9) return `€ ${(v / 1e9).toFixed(1).replace(".", ",")} mrd`
  if (v >= 1e7) return `€ ${Math.round(v / 1e6)} mln`
  if (v >= 1e6) return `€ ${(v / 1e6).toFixed(1).replace(".", ",")} mln`
  return `€ ${v.toLocaleString("nl-NL")}`
}

// exponential approach: frame-rate independent first-order smoothing
export function expDamp(cur, tgt, rate, dt) { return cur + (tgt - cur) * (1 - Math.exp(-rate * dt)) }

// critically damped spring (Game Programming Gems 4 / Unity SmoothDamp): never overshoots, frame-rate independent.
// vel is an array holding the velocity at index i (so Vector3-like state can be smoothed per component).
export function smoothDamp(cur, tgt, vel, i, smoothTime, dt) {
  const omega = 2 / Math.max(1e-4, smoothTime), x = omega * dt
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x)
  const change = cur - tgt, temp = (vel[i] + omega * change) * dt
  vel[i] = (vel[i] - omega * temp) * e
  return tgt + (change + temp) * e
}

export function wrapAngle(a) { return ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI }
export function lerpAngle(a, b, k) { return a + wrapAngle(b - a) * k }
export function smoothDampAngle(cur, tgt, vel, i, smoothTime, dt) { return smoothDamp(cur, cur + wrapAngle(tgt - cur), vel, i, smoothTime, dt) }
export function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

// FNV-1a over a string → 32-bit seed, and a tiny seeded RNG
export function hash32(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return h >>> 0
}
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
