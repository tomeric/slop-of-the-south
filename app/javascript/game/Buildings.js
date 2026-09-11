import * as THREE from "three"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"
import { collapseRange, scaleRange, buildingHp } from "game/Destructibles"
import { buildingMaterial } from "game/BuildingTextures"


const palette = {
  church: 0x8c8378, cathedral: 0x8c8378,
  industrial: 0x9aa0a6, warehouse: 0x9aa0a6, retail: 0xb8a48c, commercial: 0xb8a48c,
  apartments: 0xc9b39a, office: 0xa9b3bd, school: 0xd4b489,
  default: 0xd9c4a5,        // Limburg brick-ish
}
// 3D BAG parts carry a roof type instead of an OSM kind: flat roofs read as commercial/apartment blocks
const roofPalette = { horizontal: 0xc3b9a8, "multiple horizontal": 0xbfb3a0 }

// Footprints (game x/z) → extruded boxes sitting on the terrain, merged into one mesh per tile. With `reg` every
// building registers a destructible handle: its vertex range in the merged geometry, collapsed when it falls.
export function buildBuildings(buildings, reg) {
  const geos = [], handles = []
  const color = new THREE.Color()
  let offset = 0
  for (const b of buildings) {
    if (b.footprint.length < 3) continue
    const shape = new THREE.Shape(b.footprint.map(([x, z]) => new THREE.Vector2(x, -z)))
    const g = new THREE.ExtrudeGeometry(shape, { depth: b.height + 0.5, bevelEnabled: false })
    g.rotateX(-Math.PI / 2)                       // extrude along +Y; shape y → -z
    g.translate(0, b.base - 0.5, 0)               // sink slightly so slopes don't show gaps

    color.setHex(palette[b.kind] ?? roofPalette[b.roof] ?? palette.default)
    const tint = 0.9 + Math.random() * 0.2
    const cols = new Float32Array(g.attributes.position.count * 3)
    for (let i = 0; i < cols.length; i += 3) { cols[i] = color.r * tint; cols[i + 1] = color.g * tint; cols[i + 2] = color.b * tint }
    g.setAttribute("color", new THREE.BufferAttribute(cols, 3))
    // ExtrudeGeometry's own UVs are already in metres (sides along × depth, caps in shape units), which is what the
    // brick map wants: it repeats by the metre, so the numbers go straight through
    geos.push(g)
    const count = g.attributes.position.count
    if (reg && b.id != null) {
      const ring = b.footprint.flat(), n = b.footprint.length
      const cx = b.footprint.reduce((s, p) => s + p[0], 0) / n, cz = b.footprint.reduce((s, p) => s + p[1], 0) / n
      handles.push({ key: `b:${b.id}`, kind: "b", rings: [ring], x: cx, z: cz, h: b.height, max: buildingHp([ring]), start: offset, count })
    }
    offset += count
  }
  if (!geos.length) return null
  const merged = mergeGeometries(geos, false)
  geos.forEach((g) => g.dispose())
  for (const h of handles) reg(h.key, { ...h, remove: () => collapseRange(merged.attributes.position, h.start, h.count), tint: (k) => scaleRange(merged.attributes.color, h.start, h.count, k) })
  return new THREE.Mesh(merged, buildingMaterial("steen"))
}
