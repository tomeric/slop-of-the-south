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
  ground: {
    detail: { repeat: 125, strength: 0.45, fadeNear: 120, fadeFar: 300 },   // terrain grain: 125 repeats over 500 m = 4 m, fading out with distance (live)
    paint: { minPx: 24, maxPolys: 160, budgetMs: 8 },                       // cover canvas detail: only polygons this big, this many, this long
    sway: { amp: 0.18, speed: 1.7 },                                        // grass in the wind (live)
    wake: { radius: 2.6, push: 0.55 },                                      // grass bends away from the car and springs back (live)
    near: { cell: 10, radius: 6, perCell: 80, perFrame: 12, fadeStart: 46, fadeEnd: 58 },   // the grass carpet around the car: cells of this size, this many out, at most this many tufts each
    bushCap: 700, hedgeCap: 800,                                            // per tile, counted apart
    roadMargin: 0.8, urbanMargin: 2.5,                                      // keep off the roads (and the sidewalks in built-up tiles)
    reeds: { spacing: 4, offsetMin: 0.5, offsetMax: 1.5 },                  // along water edges, pushed onto the land
    flatten: { pad: 0.9, squashY: 0.25, squashXZ: 1.3, puffs: 3, puffColor: 0x6f9a44 },
    classes: {                                                              // by land-cover code: m² per grass tuft (dens) and per bush, and which tufts
      1:  { dens: 2.2, mix: ["grass", "grass", "grass", "flower", "dry"] },  // grasland agrarisch
      2:  { dens: 1.6, mix: ["grass", "grass", "dry", "flower"], bush: 2500 },
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
      19: { bush: 2.2, hedge: true, margin: 0.3 },                           // haag: a dense row of dark bushes
      20: { bush: 900 },                                                     // erf: bushes in the yards, no grass
      24: { dens: 8, mix: ["dry"] },
      25: { dens: 2, mix: ["grass", "grass", "flower", "dry"], margin: 0.3 },  // berm: right up to the road
    },
  },
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
