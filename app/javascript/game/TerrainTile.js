import * as THREE from "three"
import { groundMaterial, ID_N } from "game/Cover"
import { noOutline } from "game/Outline"

const plain = noOutline(new THREE.MeshStandardMaterial({ color: 0x7fa15a, roughness: 1 }))   // tiles without land cover
plain.__shared = true

// The six triangles that meet at a grid vertex, as the (dc, dr) offsets of their other two corners: PlaneGeometry
// splits every cell along (c, r+1)–(c+1, r). Each pair is wound so its cross product points up, and the length of
// that cross product is twice the triangle's area — the same weighting computeVertexNormals uses, so a normal
// computed here is exactly the one the mesh would have had if its grid carried on past the edge.
const FAN = [[[0, 1], [1, 0]], [[-1, 0], [-1, 1]], [[-1, 1], [0, 1]], [[1, -1], [0, -1]], [[1, 0], [1, -1]], [[0, -1], [-1, 0]]]
const _a = new THREE.Vector3(), _b = new THREE.Vector3()

// The normal at grid vertex (c, r) of a height field read through `at(c, r)`, which returns null where nothing is
// loaded; a triangle with a missing corner is left out, which is what an edge vertex does today anyway.
export function gridNormal(at, c, r, step, out) {
  const h = at(c, r)
  out.set(0, 0, 0)
  if (h == null) return out.set(0, 1, 0)
  for (const [[dc1, dr1], [dc2, dr2]] of FAN) {
    const h1 = at(c + dc1, r + dr1), h2 = at(c + dc2, r + dr2)
    if (h1 == null || h2 == null) continue
    _a.set(dc1 * step, h1 - h, dr1 * step)
    _b.set(dc2 * step, h2 - h, dr2 * step)
    out.add(_a.cross(_b))
  }
  return out.lengthSq() > 1e-12 ? out.normalize() : out.set(0, 1, 0)
}

// Heightmap (rows north→south, columns west→east) → displaced plane, plus sampling that agrees with the mesh.
export class TerrainTile {
  constructor(data, cfg, texture = null) {
    this.ox = data.origin[0]            // west edge (game x)
    this.oz = data.origin[1]            // north edge (game z)
    this.n = cfg.height_n
    this.step = cfg.height_step
    this.size = cfg.tile_size
    this.h = data.heights

    const geo = new THREE.PlaneGeometry(this.size, this.size, this.n - 1, this.n - 1)
    geo.rotateX(-Math.PI / 2)            // plane +y (top row) becomes -z (north), matching data order
    const pos = geo.attributes.position
    for (let i = 0; i < pos.count; i++) pos.setY(i, this.h[i])
    geo.computeVertexNormals()

    // per-tile material when a land cover texture is painted (disposed with the tile), else the shared green
    const material = texture ? groundMaterial(texture) : plain
    this.mesh = new THREE.Mesh(geo, material)
    this.mesh.position.set(this.ox + this.size / 2, 0, this.oz + this.size / 2)
  }

  // the tile's class raster, once the buildings are in: the ground shader reads the grain each class wears from it
  setIds(ids) {
    const tex = new THREE.DataTexture(ids, ID_N, ID_N, THREE.RedFormat)
    tex.minFilter = tex.magFilter = THREE.NearestFilter      // an interpolated class id is a class that does not exist
    tex.generateMipmaps = false
    tex.needsUpdate = true
    this.mesh.material.userData.ids.value = tex              // a uniform swap: no recompile
    this.mesh.userData.onDispose = () => tex.dispose()       // ChunkManager.dispose calls this
  }

  // one grid sample, and one vertex normal of the drawn mesh: ChunkManager stitches the seams with these
  height(c, r) { return this.h[r * this.n + c] }
  writeNormal(c, r, n) { this.mesh.geometry.attributes.normal.setXYZ(r * this.n + c, n.x, n.y, n.z) }
  normalsChanged() { this.mesh.geometry.attributes.normal.needsUpdate = true }

  heightAt(x, z) {
    const u = THREE.MathUtils.clamp((x - this.ox) / this.step, 0, this.n - 1.0001)
    const v = THREE.MathUtils.clamp((z - this.oz) / this.step, 0, this.n - 1.0001)
    const c = Math.floor(u), r = Math.floor(v), fu = u - c, fv = v - r
    const h = this.h, n = this.n
    const h00 = h[r * n + c], h10 = h[r * n + c + 1], h01 = h[(r + 1) * n + c], h11 = h[(r + 1) * n + c + 1]
    // PlaneGeometry splits every cell along (c, r+1)–(c+1, r), so read the triangle the mesh actually draws.
    // Bilinear misses it by up to 80 cm where the road builder steps the terrain across a 10 m cell, which is
    // why everything seated with this — wheels, trees, signs, road ribbons — used to float or sink.
    return fu + fv <= 1 ? h00 + (h10 - h00) * fu + (h01 - h00) * fv
                        : h11 + (h01 - h11) * (1 - fu) + (h10 - h11) * (1 - fv)
  }
}
