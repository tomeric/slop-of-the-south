import * as THREE from "three"
import { noOutline } from "game/Outline"

// The edge of the world: a tall curtain of animated fire along the province border, and a burn-back for cars
// that cross it. Rings come from /api/world as flat game coordinates [x, z, x, z, …].
const HEIGHT = 420, BOTTOM = -40, SEGMENT = 40

const material = noOutline(new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, side: THREE.DoubleSide,     // normal blending: stays orange against a bright sky
  uniforms: { time: { value: 0 } },
  vertexShader: /* glsl */`
    attribute vec2 wallUv;
    varying vec2 vUv;
    void main() { vUv = wallUv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform float time;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
    }
    float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 3; i++) { v += a * noise(p); p *= 2.1; a *= 0.5; } return v; }
    void main() {
      // vUv.x runs along the wall in units of ~40 m, vUv.y from 0 (ground) to 1 (top)
      float n = fbm(vec2(vUv.x * 1.5, vUv.y * 3.0 - time * 0.9));
      float n2 = fbm(vec2(vUv.x * 4.0 + 7.0, vUv.y * 8.0 - time * 1.7));
      float flame = smoothstep(0.1, 0.9, (n * 0.75 + n2 * 0.55) - vUv.y * 0.8);    // dies out towards the top
      vec3 color = mix(vec3(0.75, 0.08, 0.0), vec3(1.0, 0.55, 0.05), flame);         // deep red core → orange tongues
      color = mix(color, vec3(1.0, 0.9, 0.35), pow(flame, 4.0));                     // yellow-white hottest bits
      float alpha = clamp(flame * 1.4 * (1.0 - 0.55 * vUv.y) + 0.25 * (1.0 - vUv.y), 0.0, 0.97);
      gl_FragColor = vec4(color, alpha);
    }`
}))
material.__shared = true

const CHUNK = 64                                                     // quads per mesh (~2.5 km of wall), so the province-long curtain is frustum-culled in pieces

export class FlameWall {
  constructor(rings) {
    this.rings = rings.map((flat) => { const pts = []; for (let i = 0; i + 1 < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]); return pts })
    this.mesh = new THREE.Group()
    for (const g of this.geometries()) { const m = new THREE.Mesh(g, material); m.renderOrder = 10; this.mesh.add(m) }
  }

  geometries() {
    const out = []
    let pos = [], uv = [], quads = 0, along = 0
    const flush = () => {
      if (!pos.length) return
      const g = new THREE.BufferGeometry()
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
      g.setAttribute("wallUv", new THREE.Float32BufferAttribute(uv, 2))
      g.computeBoundingSphere()
      out.push(g); pos = []; uv = []; quads = 0
    }
    for (const ring of this.rings) {
      for (let i = 0; i < ring.length; i++) {
        const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length]
        const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(len / SEGMENT))
        for (let k = 0; k < n; k++) {
          const x0 = ax + (bx - ax) * k / n, z0 = az + (bz - az) * k / n, x1 = ax + (bx - ax) * (k + 1) / n, z1 = az + (bz - az) * (k + 1) / n
          const u0 = along / SEGMENT, u1 = (along + len / n) / SEGMENT
          along += len / n
          // two triangles per segment
          pos.push(x0, BOTTOM, z0, x1, BOTTOM, z1, x1, BOTTOM + HEIGHT, z1, x0, BOTTOM, z0, x1, BOTTOM + HEIGHT, z1, x0, BOTTOM + HEIGHT, z0)
          uv.push(u0, 0, u1, 0, u1, 1, u0, 0, u1, 1, u0, 1)
          if (++quads >= CHUNK) flush()
        }
      }
    }
    flush()
    return out
  }

  update(t) { material.uniforms.time.value = t }

  // true when (x, z) lies inside any ring (even-odd rule)
  inside(x, z) {
    for (const ring of this.rings) {
      let inside = false
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, zi] = ring[i], [xj, zj] = ring[j]
        if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside
      }
      if (inside) return true
    }
    return false
  }
}
