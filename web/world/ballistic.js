// Things thrown in a vacuum go in straight lines and parabolas and nothing
// else: no air to slow them, nothing to hold them up, no cloud left
// behind. Dust from the exhaust leaves the ground in a thin sheet at a few
// degrees and very fast, and is gone; rock and metal from a crash go up
// in arcs at a sixth of a g and come down where they come down.
//
// Every particle's whole flight is known when it is thrown, so the GPU
// draws each from its start, its velocity and its age; the CPU only
// writes new ones into a ring. Each is drawn as a short streak along its
// path, the way a camera sees fast things.

import * as T from '../vendor/three.js';

const vert = /* glsl */ `
attribute vec2 corner;           // x: 0 tail .. 1 head; y: -1 .. 1 across
attribute vec3 aOrigin;
attribute vec3 aVel;
attribute vec4 aLife;            // birth, life, size, floor
attribute float aShade;
uniform float uTime;
uniform float uG;
uniform float uStreak;
varying float vFade;
varying float vAcross;
varying float vAlong;
varying float vShade;
vec3 at(float t) { return aOrigin + aVel * t + vec3(0.0, -0.5 * uG * t * t, 0.0); }
void main() {
  float age = uTime - aLife.x;
  vec3 head = at(age);
  if (age < 0.0 || age > aLife.y || head.y < aLife.w) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vFade = 0.0;
    return;
  }
  vec3 tail = at(max(0.0, age - uStreak));
  vec3 d = head - tail;
  float len = length(d);
  vec3 view = normalize(cameraPosition - head);
  vec3 dir = len > 1e-4 ? d / len : vec3(0.0, 1.0, 0.0);
  vec3 side = cross(dir, view);
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);
  // Never shorter than wide.
  float size = aLife.z;
  if (len < size * 2.0) tail = head - dir * size * 2.0;
  vec3 p = mix(tail, head, corner.x) + side * corner.y * size;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  float u = age / aLife.y;
  // Gone before it reaches the lens: close up a grain is a blur, not a streak.
  float near = smoothstep(5.0, 22.0, length(cameraPosition - head));
  vFade = smoothstep(0.0, 0.06, u) * (1.0 - smoothstep(0.7, 1.0, u)) * near;
  vAcross = corner.y;
  vAlong = corner.x;
  vShade = aShade;
}`;

const frag = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uAdditive;
varying float vFade;
varying float vAcross;
varying float vAlong;
varying float vShade;
void main() {
  if (vFade <= 0.0) discard;
  float a = (1.0 - vAcross * vAcross) * mix(0.25, 1.0, vAlong) * vFade * uOpacity;
  vec3 c = uColor * vShade;
  gl_FragColor = uAdditive > 0.5 ? vec4(c * a, 1.0) : vec4(c, a);
}`;

export class Ballistic {
  /**
   * @param o  n: ring size; color; opacity; additive; streak (seconds of
   *           path drawn behind the head); g (ft/s/s)
   */
  constructor(scene, o) {
    this.n = o.n;
    const g = new T.InstancedBufferGeometry();
    g.setAttribute('corner', new T.Float32BufferAttribute([0, -1, 1, -1, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.origin = new T.InstancedBufferAttribute(new Float32Array(this.n * 3), 3).setUsage(T.DynamicDrawUsage);
    this.vel = new T.InstancedBufferAttribute(new Float32Array(this.n * 3), 3).setUsage(T.DynamicDrawUsage);
    this.life = new T.InstancedBufferAttribute(new Float32Array(this.n * 4).fill(-1e9), 4).setUsage(T.DynamicDrawUsage);
    this.shade = new T.InstancedBufferAttribute(new Float32Array(this.n).fill(1), 1).setUsage(T.DynamicDrawUsage);
    g.setAttribute('aOrigin', this.origin);
    g.setAttribute('aVel', this.vel);
    g.setAttribute('aLife', this.life);
    g.setAttribute('aShade', this.shade);
    g.instanceCount = this.n;
    this.uniforms = {
      uTime: { value: 0 }, uG: { value: o.g ?? 5.32 }, uStreak: { value: o.streak ?? 0.03 },
      uColor: { value: new T.Color(...(o.color || [0.6, 0.57, 0.53])) }, uOpacity: { value: o.opacity ?? 0.5 }, uAdditive: { value: o.additive ? 1 : 0 },
    };
    this.mesh = new T.Mesh(g, new T.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: vert, fragmentShader: frag,
      transparent: true, depthWrite: false, blending: o.additive ? T.AdditiveBlending : T.NormalBlending, side: T.DoubleSide,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = o.order ?? 3;
    scene.add(this.mesh);
    this.next = 0;
    this.dirty = [];
    this.time = 0;
  }

  /** Throw one: start, velocity, life (s), size (ft), floor (y below
   * which it is gone), shade (a brightness factor). */
  throw(p, v, life, size, floor, shade = 1) {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    this.origin.setXYZ(i, p.x, p.y, p.z);
    this.vel.setXYZ(i, v.x, v.y, v.z);
    this.life.setXYZW(i, this.time, life, size, floor);
    this.shade.setX(i, shade);
    this.dirty.push(i);
  }

  update(time) {
    this.time = time;
    this.uniforms.uTime.value = time;
    if (!this.dirty.length) return;
    // Upload only the part of the ring that changed.
    let lo = Infinity, hi = -1;
    const wrapped = this.dirty.length >= this.n || this.dirty[0] > this.dirty[this.dirty.length - 1];
    if (wrapped) {
      lo = 0;
      hi = this.n - 1;
    } else {
      lo = this.dirty[0];
      hi = this.dirty[this.dirty.length - 1];
    }
    for (const [a, size] of [[this.origin, 3], [this.vel, 3], [this.life, 4], [this.shade, 1]]) {
      a.clearUpdateRanges();
      a.addUpdateRange(lo * size, (hi - lo + 1) * size);
      a.needsUpdate = true;
    }
    this.dirty.length = 0;
  }

  /** Forget everything in flight. */
  clear() {
    this.life.array.fill(-1e9);
    this.life.clearUpdateRanges();
    this.life.needsUpdate = true;
    this.dirty.length = 0;
  }
}

/** A small seeded generator, so that a replay throws the same dust. */
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _p = new T.Vector3(), _v = new T.Vector3();

/**
 * The sheet of dust the exhaust drives along the ground. In the Apollo
 * films it is not a cloud but a fast, thin, translucent layer streaming
 * out in every direction, the ground seeming to flow; it stops dead with
 * the engine. Drawn as a disc on the ground with streaks running out
 * along it, and a scatter of single grains over it.
 */
export class DustSheet {
  constructor(scene, random) {
    this.parts = new Ballistic(scene, { n: 32768, color: [1.0, 0.96, 0.9], opacity: 0.05, streak: 0.05 });
    this.random = random;
    this.carry = 0;
    this.uniforms = { uTime: { value: 0 }, uStrength: { value: 0 }, uInner: { value: 4 } };
    this.disc = new T.Mesh(new T.RingGeometry(0.5, 80, 96, 12), new T.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform float uTime; uniform float uStrength; uniform float uInner; varying vec2 vP;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
        void main(){
          float r = length(vP);
          float a = atan(vP.y, vP.x) / 6.2831853;
          // Streaks along the radius, running out at the speed of the gas.
          float run = r - uTime * 140.0;
          float s1 = n(vec2(a * 300.0, run * 0.05));
          float s2 = n(vec2(a * 700.0 + 7.0, run * 0.12));
          float clump = n(vec2(a * 14.0 + 3.0, run * 0.012));
          float streak = 0.55 + 0.45 * smoothstep(0.4, 0.95, s1 * 0.55 + s2 * 0.45);
          float reach = 10.0 + 22.0 * uStrength;
          float k = smoothstep(uInner * 0.7, uInner * 1.8, r) * (1.0 - smoothstep(reach * 0.3, reach, r));
          float alpha = uStrength * 0.11 * k * streak * (0.5 + 0.5 * clump);
          if (alpha < 0.003) discard;
          gl_FragColor = vec4(vec3(1.05, 1.0, 0.93), alpha);
        }`,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    }));
    this.disc.rotation.x = -Math.PI / 2;
    this.disc.renderOrder = 2;
    this.disc.visible = false;
    scene.add(this.disc);
  }

  /**
   * Throw dust from where the gas meets the ground. `hit` the point,
   * `strength` 0..1, `alt` the nozzles' height, `groundAt` the terrain.
   */
  emit(dt, hit, strength, alt, groundAt, scale = 1) {
    this.disc.visible = !!hit && strength > 0.005;
    if (!this.disc.visible) return;
    const R = this.random;
    // Laid on the ground as it is, a little above it.
    const base = groundAt(hit.x, hit.z);
    this.disc.position.set(hit.x, base, hit.z);
    const pos = this.disc.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i), ly = pos.getY(i);
      pos.setZ(i, groundAt(hit.x + lx, hit.z - ly) - base + 0.15);
    }
    pos.needsUpdate = true;
    this.uniforms.uStrength.value = Math.min(1, Math.sqrt(strength) * 1.3);
    this.uniforms.uInner.value = (1.5 + alt * 0.45) * scale;
    this.carry += dt * 30000 * strength;
    const n = Math.floor(this.carry);
    this.carry -= n;
    const r0 = (1.5 + alt * 0.45) * scale;
    for (let k = 0; k < n; k++) {
      const a = R() * Math.PI * 2;
      const r = r0 * (0.8 + 1.4 * R());
      _p.set(hit.x + Math.cos(a) * r, 0, hit.z + Math.sin(a) * r);
      const gy = groundAt(_p.x, _p.z);
      _p.y = gy + 0.05;
      // Fast and flat: a few degrees, a few at more.
      const el = (R() < 0.85 ? 0.5 + 4 * R() : 5 + 9 * R()) * (Math.PI / 180);
      const sp = (70 + 200 * R() * R()) * (0.35 + 0.65 * strength);
      _v.set(Math.cos(a) * Math.cos(el) * sp, Math.sin(el) * sp, Math.sin(a) * Math.cos(el) * sp);
      this.parts.throw(_p, _v, 0.35 + 0.9 * R(), (0.025 + 0.04 * R()) * Math.sqrt(scale), gy - 0.5, 0.7 + 0.6 * R());
    }
  }

  /** No exhaust on the ground this frame: the sheet is gone at once. */
  stop() {
    this.disc.visible = false;
  }

  update(time) {
    this.parts.update(time);
    this.uniforms.uTime.value = time;
  }

  clear() {
    this.parts.clear();
    this.disc.visible = false;
  }
}
