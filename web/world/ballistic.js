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
varying float vU;
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
  vU = u;
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
uniform float uCool;
varying float vFade;
varying float vU;
varying float vAcross;
varying float vAlong;
varying float vShade;
void main() {
  if (vFade <= 0.0) discard;
  float a = (1.0 - vAcross * vAcross) * mix(0.25, 1.0, vAlong) * vFade * uOpacity;
  vec3 c = uColor * vShade;
  // Hot things cool on the way: yellow-white to a dull red to nothing.
  if (uCool > 0.5) c = mix(c, vec3(0.45, 0.04, 0.0), smoothstep(0.0, 0.7, vU)) * (1.0 - 0.8 * vU);
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
      uColor: { value: new T.Color(...(o.color || [0.6, 0.57, 0.53])) }, uOpacity: { value: o.opacity ?? 0.5 }, uAdditive: { value: o.additive ? 1 : 0 }, uCool: { value: o.cool ? 1 : 0 },
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
    this.until = -Infinity; // when the last one thrown is gone
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
    this.until = Math.max(this.until, this.time + life);
  }

  update(time) {
    this.time = time;
    this.uniforms.uTime.value = time;
    // Nothing in flight: not drawn at all.
    this.mesh.visible = time <= this.until;
    if (this.full) {
      // Emptied: the whole ring goes up once.
      for (const a of [this.origin, this.vel, this.life, this.shade]) {
        a.clearUpdateRanges();
        a.needsUpdate = true;
      }
      this.full = false;
      this.dirty.length = 0;
      return;
    }
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
    this.next = 0;
    this.dirty.length = 0;
    this.full = true;
    this.until = -Infinity;
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
const G_DUST = 5.32;

/**
 * The dust the exhaust drives off the ground. In the Apollo films it is
 * not a cloud but a fast, thin, translucent sheet streaming out in every
 * direction, the ground seeming to flow; it stops dead with the engine.
 * Drawn as a disc on the ground with streaks running out along it, a
 * dense scatter of grains low over it, and coarser stuff the gas digs out
 * near where it strikes, thrown higher on short arcs. The jets reach the
 * ground from about sixty feet; the closer, the more.
 */
export class DustSheet {
  constructor(scene, random) {
    this.parts = new Ballistic(scene, { n: 65536, color: [1.0, 0.96, 0.9], opacity: 0.15, streak: 0.024 });
    this.spray = new Ballistic(scene, { n: 32768, color: [0.74, 0.71, 0.66], opacity: 0.5, streak: 0.012 });
    this.was = 0; // the strength a moment ago, for the jets coming on near the ground
    this.random = random;
    this.carry = 0;
    this.carrySpray = 0;
    this.uniforms = { uTime: { value: 0 }, uStrength: { value: 0 }, uInner: { value: 4 } };
    this.disc = new T.Mesh(new T.RingGeometry(0.5, 110, 96, 14), new T.ShaderMaterial({
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
          float streak = 0.5 + 0.5 * smoothstep(0.35, 0.95, s1 * 0.55 + s2 * 0.45);
          float reach = 14.0 + 50.0 * uStrength;
          float k = smoothstep(uInner * 0.5, uInner * 1.5, r) * (1.0 - smoothstep(reach * 0.25, reach, r));
          float alpha = uStrength * 0.22 * k * streak * (0.45 + 0.55 * clump);
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
    const r0 = (1.5 + alt * 0.4) * scale;
    this.uniforms.uInner.value = r0;
    // The sheet: fast and flat, a few degrees, a few at more.
    this.carry += dt * 52000 * strength;
    const n = Math.floor(this.carry);
    this.carry -= n;
    for (let k = 0; k < n; k++) {
      const a = R() * Math.PI * 2;
      const r = r0 * (0.6 + 1.6 * R());
      _p.set(hit.x + Math.cos(a) * r, 0, hit.z + Math.sin(a) * r);
      const gy = groundAt(_p.x, _p.z);
      _p.y = gy + 0.05;
      const el = (R() < 0.8 ? 0.5 + 4 * R() : 4.5 + 11 * R()) * (Math.PI / 180);
      const sp = (60 + 210 * R() * R()) * (0.35 + 0.65 * strength);
      _v.set(Math.cos(a) * Math.cos(el) * sp, Math.sin(el) * sp, Math.sin(a) * Math.cos(el) * sp);
      this.parts.throw(_p, _v, 0.35 + 1.0 * R(), (0.03 + 0.05 * R()) * Math.sqrt(scale), gy - 0.5, 0.7 + 0.6 * R());
    }
    // Coarser grains dug out near the strike, on short, steeper arcs:
    // the dust that can be seen to go up and come down. The jets coming
    // on hard close to the ground (lifting off) throw a burst of it.
    const surge = strength - this.was > 0.35 ? 2200 : 0;
    this.was += (strength - this.was) * Math.min(1, dt * 4);
    if (alt < 35 * scale) {
      this.carrySpray += dt * 7000 * strength + surge;
      const m = Math.floor(this.carrySpray);
      this.carrySpray -= m;
      for (let k = 0; k < m; k++) {
        const a = R() * Math.PI * 2;
        const r = r0 * (0.3 + 1.2 * R());
        _p.set(hit.x + Math.cos(a) * r, 0, hit.z + Math.sin(a) * r);
        const gy = groundAt(_p.x, _p.z);
        _p.y = gy + 0.05;
        const el = (6 + 30 * R()) * (Math.PI / 180);
        const sp = (8 + 22 * R()) * (0.4 + 0.6 * strength) * (surge ? 1.3 : 1);
        _v.set(Math.cos(a) * Math.cos(el) * sp, Math.sin(el) * sp, Math.sin(a) * Math.cos(el) * sp);
        const t = (2 * _v.y) / G_DUST;
        this.spray.throw(_p, _v, t + 0.2, (0.035 + 0.055 * R()) * Math.sqrt(scale), gy - 0.2, 0.7 + 0.6 * R());
      }
    }
  }

  /**
   * A blow on the ground at `at`, `speed` ft/s: a ring of dust thrown up
   * from it. `k` scales how much.
   */
  kick(at, speed, groundAt, k = 1) {
    const R = this.random;
    const n = Math.min(1600, Math.floor(speed * 70 * k));
    for (let i = 0; i < n; i++) {
      const a = R() * Math.PI * 2;
      const r = 0.3 + 1.2 * R();
      _p.set(at.x + Math.cos(a) * r, 0, at.z + Math.sin(a) * r);
      const gy = groundAt(_p.x, _p.z);
      _p.y = gy + 0.05;
      const el = (12 + 50 * R()) * (Math.PI / 180);
      const sp = (1.5 + speed * (0.15 + 0.5 * R() * R()));
      _v.set(Math.cos(a) * Math.cos(el) * sp, Math.sin(el) * sp, Math.sin(a) * Math.cos(el) * sp);
      const t = (2 * _v.y) / G_DUST;
      this.spray.throw(_p, _v, t + 0.2, 0.025 + 0.045 * R(), gy - 0.2, 0.7 + 0.6 * R());
    }
  }

  /** No exhaust on the ground this frame: the sheet is gone at once. */
  stop() {
    this.disc.visible = false;
    this.was = 0;
  }

  update(time) {
    this.parts.update(time);
    this.spray.update(time);
    this.uniforms.uTime.value = time;
  }

  clear() {
    this.parts.clear();
    this.spray.clear();
    this.disc.visible = false;
  }
}
