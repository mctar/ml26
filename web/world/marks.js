// Marks in the ground. Nothing on the Moon fills them in: a tyre's tread
// where it came down and rolled, the furrow a car on its side ploughs,
// the scuffs of its pieces skidding. They stay from game to game, as the
// boot prints do, and the Moon keeps the story of every flight.
//
// Each mark is laid in tiles behind whatever makes it, a tile at a time
// as it moves on, each tile tilted to the ground under it. They are
// drawn onto the ground they lie on, not over it: they darken it a
// little (disturbed regolith is darker than the undisturbed), and their
// ribs and furrows catch the low sun on one side and lose it on the
// other, which is how tracks read in the Apollo photographs. Drawn that
// way, by multiplying what the ground already shows, they are as dark
// as the ground in a shadow and as bright as it in the sun, whatever
// light it has.

import * as T from '../vendor/three.js';

const MAX = 2400; // tiles of each kind
const TILE = { tread: 1.1, print: 1.5, scrape: 0.9 }; // feet along a tile
const WIDE = { tread: 1.3, print: 1.3, scrape: 0.7 }; // feet across, as drawn (a tile is stretched to the width asked)
const DEEP = { tread: 0.08, print: 0.1, scrape: 0.08 }; // feet, at full depth

/**
 * A tile's surface: heights over (u along, 0..1; v across, -0.5..0.5),
 * as normals (rgb) and how disturbed (a). The tread repeats along a tile
 * so that tiles laid end to end run on without a seam.
 */
function surface(kind) {
  const W = 128, H = 64;
  const h = new Float32Array(W * H), m = new Float32Array(W * H);
  const lane = [];
  for (let k = 0; k < 9; k++) lane.push([((k * 0.618) % 1) - 0.5, 0.012 + 0.03 * ((k * 0.37) % 1), 0.3 + 0.7 * ((k * 0.71) % 1)]);
  for (let j = 0; j < H; j++) {
    const v = (j + 0.5) / H - 0.5;
    const av = Math.abs(v);
    for (let i = 0; i < W; i++) {
      const u = (i + 0.5) / W;
      let y, dis;
      if (kind === 'tread' || kind === 'print') {
        // The tyre is the middle seven tenths: pressed down, the lugs
        // pressed deeper in a chevron; the regolith it pushed aside
        // raised in a low berm either side. A print, where a tyre came
        // down and did not roll on, has ends too: the patch it sat on.
        const inside = 1 - smooth(0.3, 0.37, av);
        const lug = smooth(0.35, 0.45, Math.abs(((u * 7 + av * 1.3) % 1) - 0.5) * 2) * smooth(0.06, 0.12, av);
        y = -inside * (0.7 + 0.3 * lug);
        dis = 1 - smooth(0.36, 0.5, av);
        if (kind === 'print') {
          const au = Math.abs(u - 0.5);
          const patch = 1 - smooth(0.28, 0.4, au);
          y *= patch;
          dis *= 1 - smooth(0.3, 0.48, au);
          const r = Math.hypot(au / 0.42, av / 0.42);
          y += 0.35 * Math.exp(-(((r - 1) / 0.12) ** 2));
        } else y += 0.35 * Math.exp(-(((av - 0.42) / 0.05) ** 2));
      } else {
        // Dragged: grooves along the way it went, uneven, between low
        // ridges, worn shallower at the edges.
        y = 0;
        for (const [c, w, d] of lane) {
          const wav = 1 + 0.3 * Math.sin(2 * Math.PI * (u * 2 + c * 3));
          y -= d * Math.exp(-(((v - c * 0.8) / (w * wav)) ** 2));
        }
        y *= 1 - smooth(0.3, 0.48, av);
        y += 0.25 * Math.exp(-(((av - 0.45) / 0.05) ** 2));
        dis = (1 - smooth(0.32, 0.5, av)) * 0.85;
      }
      h[j * W + i] = y;
      m[j * W + i] = dis;
    }
  }
  // Normals from the slopes, in feet per foot.
  const data = new Uint8Array(W * H * 4);
  const su = (W / 2 / TILE[kind]) * DEEP[kind], sv = (H / 2 / WIDE[kind]) * DEEP[kind];
  const at = (i, j) => h[Math.min(H - 1, Math.max(0, j)) * W + ((i + W) % W)];
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const du = (at(i + 1, j) - at(i - 1, j)) * su;
      const dv = (at(i, j + 1) - at(i, j - 1)) * sv;
      const l = Math.hypot(du, dv, 1);
      // Rows from the top, as the plane's v runs.
      const o = ((H - 1 - j) * W + i) * 4;
      data[o] = ((-du / l) * 0.5 + 0.5) * 255;
      data[o + 1] = ((-dv / l) * 0.5 + 0.5) * 255;
      data[o + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      data[o + 3] = m[j * W + i] * 255;
    }
  }
  const t = new T.DataTexture(data, W, H, T.RGBAFormat);
  t.colorSpace = T.NoColorSpace;
  t.wrapS = T.RepeatWrapping;
  t.magFilter = T.LinearFilter;
  t.minFilter = T.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

function smooth(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const vertexShader = `
varying vec2 vUv;
varying vec3 vT, vB, vN, vW;
void main() {
  mat4 m = modelMatrix * instanceMatrix;
  vec4 w = m * vec4(position, 1.0);
  vT = normalize(mat3(m) * vec3(1.0, 0.0, 0.0));
  vN = normalize(mat3(m) * vec3(0.0, 1.0, 0.0));
  vB = normalize(mat3(m) * vec3(0.0, 0.0, 1.0));
  vUv = uv;
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

// Out: half of the factor the ground below is multiplied by (the blend
// doubles it), so 0.5 leaves it as it is.
const fragmentShader = `
uniform sampler2D uMap;
uniform vec3 uSun;
uniform float uDark;
varying vec2 vUv;
varying vec3 vT, vB, vN, vW;
void main() {
  vec4 t = texture2D(uMap, vUv);
  vec3 nt = t.rgb * 2.0 - 1.0;
  vec3 n = normalize(vT * nt.x + vB * nt.y + vN * nt.z);
  // The ground's own way with light (see the land's shader): as bright
  // tilted toward the sun as flat, very nearly; dark only where the sun
  // does not reach. So a wall facing away is in shadow, and one facing
  // the sun only a little brighter than the ground.
  vec3 toEye = normalize(cameraPosition - vW);
  float nv = max(0.0, dot(vN, toEye));
  float l0 = max(0.02, dot(vN, uSun)), l1 = max(0.0, dot(n, uSun));
  float flat0 = mix(l0, 1.1 * l0 / (l0 + nv + 0.08), 0.65);
  float lit = mix(l1, 1.1 * l1 / (l1 + nv + 0.08), 0.65);
  float shade = clamp(lit / flat0, 0.3, 1.25);
  float fade = 1.0 - smoothstep(220.0, 520.0, distance(cameraPosition, vW));
  float f = mix(1.0, uDark * shade, t.a * fade);
  gl_FragColor = vec4(vec3(0.5 * f), 1.0);
}`;

class Layer {
  constructor(scene, kind, sun) {
    const g = new T.PlaneGeometry(1, 1);
    g.rotateX(-Math.PI / 2);
    const mat = new T.ShaderMaterial({
      uniforms: { uMap: { value: surface(kind) }, uSun: { value: sun }, uDark: { value: kind === 'scrape' ? 0.76 : 0.74 } },
      vertexShader,
      fragmentShader,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      blending: T.CustomBlending,
      blendEquation: T.AddEquation,
      blendSrc: T.DstColorFactor,
      blendDst: T.SrcColorFactor,
      blendSrcAlpha: T.ZeroFactor,
      blendDstAlpha: T.OneFactor,
      toneMapped: false,
      fog: false,
    });
    this.mesh = new T.InstancedMesh(g, mat, MAX);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1; // after the ground
    scene.add(this.mesh);
    this.list = [];
    this.k = 0;
  }

  add(tile) {
    const i = this.k;
    this.k = (this.k + 1) % MAX;
    this.list[i] = tile;
    this.mesh.count = Math.min(MAX, this.list.length);
    return i;
  }
}

const _a = new T.Vector3(), _b = new T.Vector3(), _n = new T.Vector3(), _x = new T.Vector3(), _z = new T.Vector3(), _m = new T.Matrix4();

export class Marks {
  /**
   * @param scene  where to draw them
   * @param sun    the direction toward the sun (kept, not copied)
   * @param ground the height of the ground at (x, z)
   */
  constructor(scene, sun, ground) {
    this.layers = { tread: new Layer(scene, 'tread', sun), print: new Layer(scene, 'print', sun), scrape: new Layer(scene, 'scrape', sun) };
    this.ground = ground;
    this.trails = new WeakMap(); // what makes a mark -> where its last tile ended, and when it was last down
  }

  /**
   * Something on the ground at `p` (a wheel's contact, a corner of a piece)
   * at time `t`: while it stays down and moves, a tile is laid behind it
   * each tile-length it goes. `key` is what is making the mark. Coming
   * down hard (`stamp`), it leaves its print where it came down even if
   * it does not move on.
   */
  follow(key, p, t, kind, width, stamp = null) {
    let tr = this.trails.get(key);
    if (!tr || t - tr.t > 0.3 || tr.kind !== kind) {
      // The end of the last one, if it went on a way past its last tile.
      if (tr && Math.hypot(tr.last.x - tr.p.x, tr.last.z - tr.p.z) > 0.4 * TILE[tr.kind]) this.tile(tr.kind, tr.p, tr.last, tr.width);
      tr = { p: p.clone(), last: p.clone(), t, kind, width };
      this.trails.set(key, tr);
      if (stamp && kind === 'tread') {
        _a.copy(stamp).setY(0).normalize().multiplyScalar(TILE.print / 2);
        this.tile('print', _b.copy(p).sub(_a), _x.copy(p).add(_a), width);
      }
      return;
    }
    tr.t = t;
    tr.last.copy(p);
    const len = TILE[kind];
    let dx = p.x - tr.p.x, dz = p.z - tr.p.z;
    let d = Math.hypot(dx, dz);
    if (d > 8) {
      tr.p.copy(p);
      return;
    }
    while (d >= len) {
      _a.copy(tr.p);
      tr.p.x += (dx / d) * len;
      tr.p.z += (dz / d) * len;
      this.tile(kind, _a, tr.p, width);
      dx = p.x - tr.p.x;
      dz = p.z - tr.p.z;
      d = Math.hypot(dx, dz);
    }
  }

  /**
   * Follow a rigid body's contacts after a step: its tyres by their
   * treads, the rest of it by the scrapes it drags. Only what slides
   * leaves a line: a corner that touches and lifts again as the body
   * tumbles is not down long enough to.
   */
  traceBody(body, { scrape = 0.6, tread = 1.3, wheel = false } = {}) {
    const t = body.time;
    if (body.asleep) return;
    if (wheel) return this.traceWheel(body, tread);
    const wheels = new Map();
    // What of the body is down and dragging (not rolling over it: a
    // corner rolled onto does not slide): one furrow, through the middle
    // of them.
    let n = 0;
    const drag = _b.set(0, 0, 0);
    for (const c of body.contacts) {
      _n.copy(c.r).add(body.x);
      if (c.wheel) {
        const w = wheels.get(c.wheel);
        if (w) {
          w.p.add(_n).multiplyScalar(0.5);
          w.vin = Math.max(w.vin, c.vin);
        } else wheels.set(c.wheel, { p: _n.clone(), vin: c.vin });
      } else if (scrape > 0) {
        _x.crossVectors(body.w, c.r).add(body.v);
        _x.addScaledVector(c.n, -_x.dot(c.n));
        if (_x.lengthSq() > 0.25) {
          drag.add(_n);
          n++;
        }
      }
    }
    if (n) this.follow(body, drag.divideScalar(n), t, 'scrape', scrape);
    for (const [w, { p, vin }] of wheels) this.follow(w, p, t, 'tread', tread, vin > 3 ? rollDir(body, w) : null);
  }

  /**
   * A loose wheel: on its tread while it stands, a smear while it lies
   * down and slides. Bouncing along, as wheels on the Moon do, it leaves
   * a print at each place it comes down.
   */
  traceWheel(body, tread) {
    if (!body.contacts.length) return;
    let vin = 0;
    const p = _b.set(0, 0, 0);
    for (const c of body.contacts) {
      p.add(_n.copy(c.r).add(body.x));
      vin = Math.max(vin, c.vin);
    }
    p.divideScalar(body.contacts.length);
    const axle = _x.copy(body.wheels[0].axis).applyQuaternion(body.q);
    if (Math.abs(axle.y) < 0.6) {
      const roll = new T.Vector3().crossVectors(axle, new T.Vector3(0, 1, 0));
      this.follow(body, p, body.time, 'tread', tread, vin > 1.5 ? roll : null);
    } else this.follow(body, p, body.time, 'scrape', body.wheels[0].r * 1.6);
  }

  tile(kind, a, b, width) {
    const layer = this.layers[kind];
    const tile = { a: a.clone(), b: b.clone(), width };
    const i = layer.add(tile);
    this.place(layer, i, tile);
    layer.mesh.instanceMatrix.needsUpdate = true;
  }

  /** A tile on the ground: from a to b, tilted to the ground under it. */
  place(layer, i, { a, b, width }) {
    const g = this.ground;
    a.y = g(a.x, a.z);
    b.y = g(b.x, b.z);
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    // The ground's tilt across the tile, from either side of its middle.
    _x.copy(b).sub(a);
    const len = _x.length();
    _x.divideScalar(len || 1);
    _z.set(-_x.z, 0, _x.x).normalize().multiplyScalar(width / 2);
    const ha = g(mx + _z.x, mz + _z.z), hb = g(mx - _z.x, mz - _z.z);
    _z.y = (ha - hb) / 2;
    _n.crossVectors(_z, _x).normalize();
    _z.normalize();
    _m.makeBasis(_x.multiplyScalar(len), _n, _z.multiplyScalar(width));
    _m.setPosition(mx, (a.y + b.y) / 2 + 0.02, mz);
    layer.mesh.setMatrixAt(i, _m);
  }

  /** Back on the ground after it has changed (a crater dug, the other
   * scale's heights). */
  reground(ground) {
    if (ground) this.ground = ground;
    for (const layer of Object.values(this.layers)) {
      layer.list.forEach((tile, i) => this.place(layer, i, tile));
      layer.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** A fresh Moon. */
  clear() {
    for (const layer of Object.values(this.layers)) {
      layer.list = [];
      layer.k = 0;
      layer.mesh.count = 0;
    }
    this.trails = new WeakMap();
  }

  set visible(v) {
    for (const layer of Object.values(this.layers)) layer.mesh.visible = v;
  }
}

/** The way a body's wheel rolls, for its print where it comes down. */
function rollDir(body, w) {
  return new T.Vector3().crossVectors(new T.Vector3().copy(w.axis).applyQuaternion(body.q), new T.Vector3(0, 1, 0));
}
