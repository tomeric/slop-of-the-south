import { OutlineEffect } from "three/addons/effects/OutlineEffect.js"
import { TUNING as T } from "game/Tuning"

// Cartoon outlines: three's OutlineEffect draws every eligible mesh a second time as an inverted hull. That is a
// whole extra pass, so it is kept to the things that gain from one — buildings, cars, the float, rubble — and taken
// off everything else. Two rules do almost all of it: sprites and lines are skipped by the effect itself (it only
// outlines meshes with normals), and every instanced mesh is opted out as its tile is built, because the addon
// offsets the hull with the model-view matrix alone and ignores instanceMatrix, so an instance away from the origin
// would outline from the wrong place. The big flat surfaces (ground, roads, water, the sky dome) are opted out by
// hand where their material is made.
export function noOutline(material) {
  (material.userData.outlineParameters ??= {}).visible = false
  return material
}

// every instanced mesh in a group: trees, grass, bushes, reeds, lamp posts, traffic lights, signs, boost pads
export function noOutlineInstanced(group) {
  group.traverse((o) => { if (o.isInstancedMesh && o.material) noOutline(o.material) })
}

export function makeOutline(renderer) {
  const O = T.light.outline
  return new OutlineEffect(renderer, { defaultThickness: O.thickness, defaultColor: O.color, defaultAlpha: O.alpha })
}
