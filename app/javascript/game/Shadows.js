import * as THREE from "three"
import { TUNING as T } from "game/Tuning"

// The sun's shadow, hung on the camera. One directional light over a box the size of what you can actually see
// (±140 m at 2048², so a texel is 14 cm), not the whole province: a directional shadow is one orthographic render
// of every caster in the box, so the box is the whole cost.
//
// Two things make or break it. The box has to be snapped to whole texels, or its sampling grid slides under the
// world as you drive and every shadow edge crawls and boils at 160 km/h. And `castShadow`, the map size and the
// number of shadow-casting lights are *boot* settings: changing any of them recompiles every program in the scene,
// which is a second of black. So the switch is `?schaduw` in the URL (`?schaduw=0` forces it off), read once in
// game.js; the live knob is `shadow.intensity`, which only scales how dark the result is.
//
// Who casts: buildings, trees, cars, bridges, the float and the rubble. Who does not: grass and reeds (their sway
// lives in a patched material the depth pass does not get, so their shadows would stand still while the grass
// bends), bushes (the dark vertex colour at their root already reads as contact shade) and the poles — a lamp post
// is thinner than a texel at this density and its shadow comes out as a dotted line.
const UP = new THREE.Vector3(0, 1, 0)
const _c = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3()

export class Shadows {
  constructor(world) {
    const S = T.light.shadow
    this.world = world
    this.on = !!S.on
    world.renderer.shadowMap.enabled = this.on
    world.renderer.shadowMap.type = THREE.PCFShadowMap
    if (!this.on) return
    const sun = world.sun
    sun.castShadow = true
    sun.shadow.mapSize.set(S.size, S.size)
    sun.shadow.bias = S.bias
    sun.shadow.normalBias = S.normalBias                 // along the surface normal: what keeps the 10 m height grid free of acne
    const cam = sun.shadow.camera
    cam.left = -S.half; cam.right = S.half; cam.top = S.half; cam.bottom = -S.half
    cam.near = 1; cam.far = S.dist * 2
    cam.updateProjectionMatrix()
  }

  // sunDir is the unit direction *to* the sun (DayNight owns it); darkness 0 day … 1 night
  update(camera, sunDir, darkness) {
    if (!this.on) return
    const S = T.light.shadow, sun = this.world.sun
    sun.shadow.intensity = S.strength * (1 - darkness)   // the moon casting hard shadows at midnight is nobody's idea of night
    camera.getWorldDirection(_f)
    _f.y = 0
    _f.lengthSq() < 1e-6 ? _f.set(0, 0, -1) : _f.normalize()
    _c.copy(camera.position).addScaledVector(_f, S.half * S.ahead)   // most of the box in front of the car, where the eye is
    // three builds the light's own basis as (up × dir, dir × that, dir), so snap the centre in that basis and the
    // texel grid stands still in the world while the box slides over it
    _r.crossVectors(UP, sunDir).normalize()
    _u.crossVectors(sunDir, _r)
    const texel = 2 * S.half / S.size
    const q = (v) => Math.round(v / texel) * texel
    const along = _c.dot(sunDir), right = q(_c.dot(_r)), up = q(_c.dot(_u))
    _c.set(0, 0, 0).addScaledVector(_r, right).addScaledVector(_u, up).addScaledVector(sunDir, along)
    sun.target.position.copy(_c)
    sun.target.updateMatrixWorld()                       // the target hangs off no parent, so nothing else would
    sun.position.copy(_c).addScaledVector(sunDir, S.dist)
  }
}

// casts and takes a shadow / only takes one. Both are no-ops while the shadow map is off, so tiles set them either
// way and turning shadows on is one boot flag rather than a hunt through every builder.
export function casts(o) {
  o?.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true } })
  return o
}

export function takes(o) {
  o?.traverse((c) => { if (c.isMesh) c.receiveShadow = true })
  return o
}
