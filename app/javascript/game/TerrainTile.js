import * as THREE from "three"
import { groundMaterial } from "game/Cover"
import { noOutline } from "game/Outline"

const plain = noOutline(new THREE.MeshStandardMaterial({ color: 0x7fa15a, roughness: 1 }))   // tiles without land cover
plain.__shared = true

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
