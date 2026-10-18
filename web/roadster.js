// The 2026 view: Burness's terrain as a lit surface, the Roadster coming
// down on cold gas, a camera that follows, and the driver getting out to
// do what the program's man does. Everything here is drawn from the
// game's state as the original's variables hold it; nothing here decides
// anything. The pieces are in world/.
//
// Units are the program's: feet. x is HORDIS, y is VERDIS, the flight is in
// the plane z = 0; the terrain profile at z = 0 is the original's TERAIN
// table exactly, and falls away into invented hills behind and in front.

import * as T from './vendor/three.js';
import { Car } from './world/car.js';
import { Astronaut } from './world/astronaut.js';
import { Driver, WINDOW } from './world/driver.js';
import { Props, Flag } from './world/props.js';
import { Exhaust } from './world/plume.js';
import { DustSheet, rng } from './world/ballistic.js';
import { Debris } from './world/debris.js';
import { Prints } from './world/prints.js';
import { makeEnvironment } from './world/env.js';
import { hash, noise2 as noise, fbm2 as fbm } from './world/shape.js';

const TERRAIN_N = 911; // words in TERAIN
const TERRAIN_X0 = -22400; // feet at index 0
const TERRAIN_DX = 32; // feet per index
// The diner's lot: a slab, its extent about the DINER feature.
const PAD = { x0: -55, x1: 55, z0: -37, z1: 33 };

/** Burness's lander, from the DESIGN table: moves (M) and lines (L) in
 * raster units about the ship's centre, with the intensity level (I). */
const LANDER_1973 = [['I', 4], ['M', -6, 0], ['L', -14, 8], ['L', -14, 20], ['L', -6, 29], ['L', 6, 29], ['L', 14, 20], ['L', 14, 8], ['L', 6, 0], ['L', -6, 0], ['M', -17, 0], ['L', -17, -16], ['L', 17, -16], ['L', 17, 0], ['L', -17, 0], ['I', 3], ['L', -32, -24], ['M', 17, 0], ['L', 32, -24], ['I', 1], ['M', -17, -14], ['L', -28, -18], ['M', 17, -14], ['L', 28, -18], ['I', 4], ['M', 36, -24], ['L', 28, -24], ['M', -28, -24], ['L', -36, -24], ['M', -3, -16], ['L', -7, -21], ['L', 7, -21], ['L', 3, -16]];

export const FEATURE = { NONE: 0, OLD_SHIP: 1, FLAG: 2, WRECK_LEFT: 3, WRECK_RIGHT: 4, ROCK: 5, DINER_SIDE: 6, DINER: 7 };

export class Roadster {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas, tubeCanvas) {
    this.canvas = canvas;
    // The 1973 tube, as drawn by the phosphor renderer: the films on the
    // diner's screens are the player's own flight as the GT40 showed it.
    this.tubeTexture = new T.CanvasTexture(tubeCanvas);
    this.tubeTexture.colorSpace = T.SRGBColorSpace;
    this.tubeTexture.minFilter = T.LinearFilter;
    this.tubeTexture.generateMipmaps = false;
    this.renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = T.PCFSoftShadowMap;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.scene = new T.Scene();
    this.scene.background = new T.Color(0x000000);
    this.camera = new T.PerspectiveCamera(42, 4 / 3, 1, 200000);
    this.camTarget = new T.Vector3();
    this.camPos = new T.Vector3();
    this.first = true;
    this.pose = { x: 0, y: 0, a: 0 };
    this.lastState = null;
    this.lastStateWall = 0;
    this.terrain = null;
    this.features = null;
    this.dinerX = null;
    // The program keeps the terrain at its full height while the ship is
    // high, and at a quarter of it once the ship is below 450 feet and the
    // close-up begins ("continuing fudging terrain by known standards").
    // The 1973 display cut between two pictures there; so does the camera.
    this.scaleY = 1;
    this.random = rng(1973);
    this.lights();
    this.env = makeEnvironment(this.renderer, this.sunDir);
    this.sky();
    this.car = new Car({ env: this.env });
    this.scene.add(this.car.group);
    this.man = new Astronaut(this.env);
    this.scene.add(this.man.root);
    this.props = new Props(this.scene, this.env, (x, z) => this.groundAt(x, z));
    this.prints = new Prints(this.scene);
    this.driver = new Driver(this);
    this.exhaust = new Exhaust(this.scene, this.car, this.sunDir);
    this.dust = new DustSheet(this.scene, this.random);
    this.blasts = [];
    this.exploded = false;
    this.debris = null;
    this.composer = null;
    this.thrustNow = 0;
    this.mtime = 0;
    this.setupPost();
  }

  setupPost() {
    const size = new T.Vector2();
    this.renderer.getSize(size);
    this.composer = new T.EffectComposer(this.renderer);
    this.composer.addPass(new T.RenderPass(this.scene, this.camera));
    this.bloom = new T.UnrealBloomPass(size, 0.45, 0.55, 0.88);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new T.OutputPass());
  }

  lights() {
    // A low sun, hard light, no air: long shadows, black sky.
    this.sun = new T.DirectionalLight(0xfff4e0, 3.0);
    this.sunDir = new T.Vector3(-0.45, 0.5, 0.75).normalize();
    this.sun.position.copy(this.sunDir).multiplyScalar(1000);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.sunTarget = new T.Object3D();
    this.scene.add(this.sunTarget);
    this.sun.target = this.sunTarget;
    this.scene.add(this.sun);
    // Earthshine and the ground's bounce: faint, bluish from above, warm
    // grey from below. The car and the man have the full environment too.
    this.scene.add(new T.HemisphereLight(0x3a4457, 0x3a3430, 0.75));
    // A light for the moment of a crash.
    this.flash = new T.PointLight(0xfff0d0, 0, 400, 1.5);
    this.scene.add(this.flash);
  }

  sky() {
    const R = rng(11);
    const n = 2500;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      // Points on a far sphere, more of them near the horizon.
      const u = R(), v = R();
      const th = 2 * Math.PI * u, ph = Math.acos(1 - v * 1.15);
      const r = 150000;
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.cos(ph) + 2000;
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
      const b = 0.35 + 0.65 * Math.pow(R(), 3);
      const warm = R() < 0.3;
      col[i * 3] = b * (warm ? 1 : 0.85);
      col[i * 3 + 1] = b * 0.9;
      col[i * 3 + 2] = b * (warm ? 0.75 : 1);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3));
    g.setAttribute('color', new T.BufferAttribute(col, 3));
    const m = new T.PointsMaterial({ size: 2.2, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false });
    this.stars = new T.Points(g, m);
    this.scene.add(this.stars);
    // The Earth, far and high to the left, with continents and cloud from
    // noise; it is lit by the same sun as the ground.
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 256;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(512, 256);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 512; x++) {
        const u = x / 512, v = y / 256;
        const land = fbm(u * 9 + 2.3, v * 5 + 1.1) + 0.35 * fbm(u * 27, v * 15) - 0.78 + 0.18 * Math.abs(v - 0.5);
        const ice = Math.abs(v - 0.5) > 0.44;
        let r, gg, b;
        if (ice) { r = 235; gg = 240; b = 245; }
        else if (land > 0) { const t = Math.min(1, land * 6); r = 110 + 40 * t; gg = 100 + 30 * t; b = 60 + 20 * t; }
        else { r = 30; gg = 70; b = 150; }
        const cloud = Math.max(0, fbm(u * 14 + 7.7, v * 8 + 3.3) - 0.55) * 2.6;
        r = r + (245 - r) * cloud; gg = gg + (245 - gg) * cloud; b = b + (248 - b) * cloud;
        const i = (y * 512 + x) * 4;
        img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new T.CanvasTexture(c);
    tex.colorSpace = T.SRGBColorSpace;
    const earth = new T.Mesh(new T.SphereGeometry(2600, 64, 48), new T.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0.0, emissive: 0x060a14, emissiveIntensity: 1 }));
    earth.position.set(-42000, 52000, -118000);
    earth.rotation.y = 1.2;
    this.scene.add(earth);
    this.earth = earth;
  }

  /** Read the terrain and the features out of the original's memory. */
  load(symbols, peek) {
    this.symbols = symbols;
    this.peek = peek;
    const h = new Int16Array(TERRAIN_N);
    for (let i = 0; i < TERRAIN_N; i++) h[i] = (peek(symbols.TERAIN + 2 * i) << 16) >> 16;
    this.terrain = h;
    this.features = this.readFeatures();
    this.buildTerrain();
    this.buildFeatures();
    this.buildLeftovers();
  }

  /** The feature table as it stands: a nibble per terrain index. */
  readFeatures() {
    const f = new Uint8Array(TERRAIN_N);
    for (let i = 0; i < TERRAIN_N; i++) {
      // FEATUR is a byte table: byte i/2 holds index i (low nibble, even i)
      // and i+1 (high nibble). peek reads words at even addresses.
      const addr = this.symbols.FEATUR + (i >> 1);
      const word = this.peek(addr & ~1);
      const byte = addr & 1 ? word >> 8 : word & 0xff;
      f[i] = i & 1 ? (byte >> 4) & 15 : byte & 15;
    }
    return f;
  }

  /** What earlier games left on the Moon, as the program records it in
   * the feature table: cars parked after good landings, wrecks tilted
   * left or right, flags. Rebuilt when a new game begins. */
  buildLeftovers() {
    if (this.leftovers) {
      this.scene.remove(this.leftovers);
      this.leftovers.traverse((o) => o.geometry && o.geometry.dispose());
    }
    this.leftovers = new T.Group();
    this.leftoverAt = [];
    this.features = this.readFeatures();
    for (let i = 0; i < TERRAIN_N; i++) {
      const f = this.features[i];
      if (f !== FEATURE.OLD_SHIP && f !== FEATURE.FLAG && f !== FEATURE.WRECK_LEFT && f !== FEATURE.WRECK_RIGHT) continue;
      const x = TERRAIN_X0 + i * TERRAIN_DX + TERRAIN_DX / 2;
      if (f === FEATURE.FLAG) {
        const flag = new Flag(this.env);
        this.leftovers.add(flag.group);
        this.leftoverAt.push({ kind: 'flag', o: flag.group, x: x + 6, z: 5.8 });
      } else {
        const car = new Car({ kind: f === FEATURE.OLD_SHIP ? 'parked' : 'wreck', env: this.env });
        car.setCanopy(f === FEATURE.OLD_SHIP ? 1 : 0);
        this.leftovers.add(car.group);
        this.leftoverAt.push({ kind: 'car', car, x, a: f === FEATURE.WRECK_LEFT ? -50 : f === FEATURE.WRECK_RIGHT ? 50 : 0 });
      }
    }
    this.scene.add(this.leftovers);
    this.placeLeftovers();
  }

  placeLeftovers() {
    for (const l of this.leftoverAt || []) {
      if (l.kind === 'flag') l.o.position.set(l.x, this.groundAt(l.x, l.z) - 0.25, l.z);
      else l.car.place(l.x, this.height(l.x), l.a, (x) => this.groundAt(x, 0), 0);
    }
  }

  /** The 1973 lander, in light: Burness's DESIGN table as a hologram in
   * the diner's lot, the first customer. */
  buildLander() {
    const pts = [];
    const S = 0.5; // feet per raster unit
    let cur = null;
    for (const op of LANDER_1973) {
      if (op[0] === 'M') cur = [op[1] * S, op[2] * S];
      if (op[0] === 'L') {
        if (cur) pts.push(cur[0], cur[1] + 12, 0, op[1] * S, op[2] * S + 12, 0);
        cur = [op[1] * S, op[2] * S];
      }
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pts, 3));
    const m = new T.LineBasicMaterial({ color: new T.Color(0.45, 1.2, 0.55), transparent: true, opacity: 0.85, blending: T.AdditiveBlending, depthWrite: false });
    const grp = new T.Group();
    grp.add(new T.LineSegments(g, m));
    return grp;
  }

  /** Terrain height at x (feet) on the flight plane: the original's table,
   * linear between points, as the program itself interpolates. */
  height(x) {
    const u = (x - TERRAIN_X0) / TERRAIN_DX;
    const i = Math.floor(u);
    if (i < 0) return this.terrain[0] * this.scaleY;
    if (i >= TERRAIN_N - 1) return this.terrain[TERRAIN_N - 1] * this.scaleY;
    const f = u - i;
    return (this.terrain[i] * (1 - f) + this.terrain[i + 1] * f) * this.scaleY;
  }

  /** What anything stands on at (x, z): the terrain, or the diner's lot. */
  groundAt(x, z) {
    const h = this.heightAt(x, z);
    if (this.pad) {
      const lx = x - this.pad.x, p = PAD;
      if (lx > p.x0 && lx < p.x1 && z > p.z0 && z < p.z1) return Math.max(h, this.pad.y);
    }
    return h;
  }

  /** The program's regime for a ship at VERDIS `y`: close-up or not. */
  closeUp(state) {
    return state.verdis <= 450 && state.bigxct > 10 && state.bigxct < 890;
  }

  /** Switch the terrain between the program's two heights. */
  setScale(sy) {
    if (sy === this.scaleY) return;
    this.scaleY = sy;
    this.fillTerrain();
    this.placeFeatures();
    this.placeLeftovers();
    this.prints.reground((x, z) => this.groundAt(x, z));
    this.prints.visible = sy < 1;
    this.first = true; // the camera cuts, as the 1973 display did
  }

  /** Height off the plane. The profile is a crest: level for 60 feet
   * either side, falling towards the camera in front, fading into smoother
   * hills behind. The silhouette the camera sees is Burness's. */
  heightAt(x, z) {
    const h0 = this.height(x);
    const d = Math.max(0, Math.abs(z) - 60);
    if (d === 0) return h0;
    // A lightly smoothed profile for the slopes, so each 32-foot column
    // does not become its own ribbon; the crest itself stays exact.
    let h1 = 0;
    for (let k = -3; k <= 3; k++) h1 += this.height(x + k * 32);
    h1 /= 7;
    if (z > 0) {
      const w = Math.min(1, d / 1400);
      const w2 = w * w * (3 - 2 * w);
      const ws = Math.min(1, d / 400);
      const base = h0 * (1 - ws) + h1 * ws;
      const far = Math.min(1, Math.max(0, d - 1400) / 20000);
      const floor = Math.min(base, h1 * 0.15) - 40 + (fbm(x / 420, z / 420 + 7.7) - 0.5) * 60 * w + (fbm(x / 6000 + 1.3, z / 6000) - 0.5) * 1200 * far;
      return base * (1 - w2) + floor * w2;
    }
    let hs = 0;
    for (let k = -4; k <= 4; k++) hs += this.height(x + k * 64);
    hs /= 9;
    const w = Math.min(1, d / 1200);
    const w2 = w * w * (3 - 2 * w);
    const ws = Math.min(1, d / 300);
    const base = h0 * (1 - ws) + h1 * ws;
    const far = Math.min(1, d / 4000);
    const hills = (fbm(x / 2200 + 3.1, z / 2200) - 0.5) * 2600 * far + (fbm(x / 500, z / 500 + 7.7) - 0.5) * 160 * w;
    return base * (1 - w2) + (hs * 0.8 + 300 * far + hills) * w2;
  }

  buildTerrain() {
    const cols = TERRAIN_N;
    // Rows in z: dense near the plane, sparse far away. Behind is far.
    this.zs = [-90000, -60000, -40000, -24000, -16000, -10000, -7000, -4800, -3400, -2400, -1700, -1200, -850, -600, -420, -300, -200, -130, -80, -60, 0, 60, 90, 130, 190, 270, 380, 520, 700, 950, 1300, 1800, 2600, 3800, 6000, 10000, 18000, 32000, 60000];
    const rows = this.zs.length;
    const pos = new Float32Array(cols * rows * 3);
    const uv = new Float32Array(cols * rows * 2);
    let ku = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        uv[ku++] = c / (cols - 1);
        uv[ku++] = r / (rows - 1);
      }
    }
    const idx = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3).setUsage(T.DynamicDrawUsage));
    g.setAttribute('uv', new T.BufferAttribute(uv, 2));
    g.setIndex(idx);
    this.groundGeometry = g;
    const mat = new T.MeshStandardMaterial({ color: 0x8a8884, roughness: 0.96, metalness: 0.0 });
    // Where the exhaust has blown the fine dust away: brighter ground.
    this.blastUniform = { value: [0, 1, 2, 3].map(() => new T.Vector4(0, 0, 1, 0)) };
    this.sunUniform = { value: this.sunDir };
    // Regolith: grain in the colour, relief in the normal, from noise in
    // world space: fine grit, a coarser roll, shallow craters with rims;
    // brighter looking straight down-sun (the opposition surge). All of
    // it fades with distance so it never shimmers.
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uBlast = this.blastUniform;
      sh.uniforms.uSunDir = this.sunUniform;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vW;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvW = (modelMatrix * vec4(position, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec3 vW;
uniform vec4 uBlast[4];
uniform vec3 uSunDir;
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = h21(i), b = h21(i + vec2(1.0, 0.0)), c = h21(i + vec2(0.0, 1.0)), d = h21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }
// Craters on two grids: a dent with a raised rim, a few per cell.
float crater(vec2 p, float cell, float rmin, float rmax){
  vec2 i = floor(p / cell), f = fract(p / cell);
  float h = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 c = i + g; float r1 = h21(c), r2 = h21(c + 17.3), r3 = h21(c + 41.7);
    if (r3 > 0.55) continue;
    vec2 centre = g + vec2(r1, r2) * 0.8 + 0.1;
    float rad = mix(rmin, rmax, h21(c + 5.5)) / cell;
    float d = length(f - centre) / rad;
    if (d < 1.4) { float bowl = -(1.0 - d * d) * 0.5; float rim = exp(-pow((d - 1.0) * 4.0, 2.0)) * 0.35; h += (d < 1.0 ? bowl : 0.0) + rim; }
  }
  return h;
}
float relief(vec2 p){
  return vnoise(p * 1.7) * 0.06 + vnoise(p * 0.45 + 3.1) * 0.25 + vnoise(p * 0.09 + 9.2) * 1.2
       + crater(p, 60.0, 5.0, 14.0) * 2.2 + crater(p + 1000.0, 300.0, 25.0, 70.0) * 6.0;
}
float blastAt(vec2 p){
  float k = 0.0;
  for (int i = 0; i < 4; i++) {
    vec4 b = uBlast[i];
    if (b.w <= 0.0) continue;
    float d = length(p - b.xy);
    float a = atan(p.y - b.y, p.x - b.x);
    float rays = 0.75 + 0.5 * vnoise(vec2(a * 18.0, d * 0.04 + float(i) * 7.0));
    k = max(k, b.w * (1.0 - smoothstep(b.z * 0.3, b.z * rays, d)));
  }
  return k;
}`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  float dist = length(vViewPosition);
  float k = (1.0 - smoothstep(600.0, 6000.0, dist)) * 0.9;
  if (k > 0.001) {
    vec2 p = vW.xz; float e = 0.4;
    float h0 = relief(p);
    float hx = relief(p + vec2(e, 0.0)) - h0;
    float hz = relief(p + vec2(0.0, e)) - h0;
    vec3 n = normalize(vec3(-hx / e, 1.0, -hz / e));
    vec3 nv = normalize((viewMatrix * vec4(n, 0.0)).xyz);
    normal = normalize(mix(normal, normalize(normal + (nv - normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz))), k));
  }
}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
{
  float blast = blastAt(vW.xz);
  float g = h21(floor(vW.xz * 3.0)) * 0.25 + vnoise(vW.xz * 0.12) * 0.45 + vnoise(vW.xz * 0.012 + 4.0) * 0.3;
  g = mix(g, 0.55, blast * 0.6);
  diffuseColor.rgb *= (0.84 + 0.3 * g) * (1.0 + 0.24 * blast);
  // Looking down-sun the grains hide their own shadows: a bright patch
  // about the antisolar point.
  vec3 toEye = normalize(cameraPosition - vW);
  float o = max(0.0, dot(toEye, normalize(uSunDir)));
  diffuseColor.rgb *= 1.0 + 0.3 * pow(o, 24.0) + 0.1 * pow(o, 4.0);
}`);
    };
    const mesh = new T.Mesh(g, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    this.scene.add(mesh);
    this.ground = mesh;

    // The 1973 vectors: a faint phosphor line along the profile.
    const lg = new T.BufferGeometry();
    lg.setAttribute('position', new T.BufferAttribute(new Float32Array(cols * 3), 3).setUsage(T.DynamicDrawUsage));
    this.traceGeometry = lg;
    const lm = new T.LineBasicMaterial({ color: new T.Color(0.35, 1.0, 0.45), transparent: true, opacity: 0.55, blending: T.AdditiveBlending, depthWrite: false });
    this.trace = new T.Line(lg, lm);
    this.scene.add(this.trace);
    // Loose rocks along the way, a few thousand, instanced; none big in
    // the strip where the car comes down and the driver walks.
    const n = 2600;
    const rockGeo = new T.DodecahedronGeometry(1, 0);
    const rockMat = new T.MeshStandardMaterial({ color: 0x77736e, roughness: 1, flatShading: true });
    this.pebbles = new T.InstancedMesh(rockGeo, rockMat, n);
    this.pebbles.castShadow = true;
    this.pebbles.receiveShadow = true;
    this.pebbleAt = [];
    for (let i = 0; i < n; i++) {
      const x = TERRAIN_X0 + hash(i, 11) * (TERRAIN_N - 1) * TERRAIN_DX;
      const z = (hash(i, 12) - 0.5) * 2 * (hash(i, 13) < 0.6 ? 90 : 500) + 10;
      let sz = 0.4 + 3.2 * Math.pow(hash(i, 14), 3);
      if (z > -7 && z < 11) sz = Math.min(sz, 0.3);
      this.pebbleAt.push([x, z, sz, hash(i, 15) * 6.28, 0.6 + 0.8 * hash(i, 16), 0.5 + 0.6 * hash(i, 17)]);
    }
    this.scene.add(this.pebbles);
    this.fillTerrain();
  }

  placePebbles() {
    const m = new T.Matrix4(), q = new T.Quaternion(), e = new T.Euler(), p = new T.Vector3(), sc = new T.Vector3();
    for (let i = 0; i < this.pebbleAt.length; i++) {
      const [x, z, sz, rot, sx, sy] = this.pebbleAt[i];
      // Small ones in the strip sit low, half buried.
      const lane = z > -7 && z < 11;
      const onPad = this.pad && x - this.pad.x > PAD.x0 - 2 && x - this.pad.x < PAD.x1 + 2 && z > PAD.z0 - 2 && z < PAD.z1 + 2;
      p.set(x, this.heightAt(x, z) + sz * (lane ? 0.05 : 0.25) - (onPad ? 100 : 0), z);
      e.set(0, rot, 0);
      q.setFromEuler(e);
      sc.set(sz * sx, sz * sy * (lane ? 0.5 : 1), sz);
      m.compose(p, q, sc);
      this.pebbles.setMatrixAt(i, m);
    }
    this.pebbles.instanceMatrix.needsUpdate = true;
  }

  /** Heights into the terrain mesh and the trace, at the current scale. */
  fillTerrain() {
    const cols = TERRAIN_N, rows = this.zs.length;
    const pos = this.groundGeometry.attributes.position.array;
    let k = 0;
    for (let r = 0; r < rows; r++) {
      const z = this.zs[r];
      for (let c = 0; c < cols; c++) {
        const x = TERRAIN_X0 + c * TERRAIN_DX;
        pos[k++] = x;
        pos[k++] = this.heightAt(x, z);
        pos[k++] = z;
      }
    }
    this.groundGeometry.attributes.position.needsUpdate = true;
    this.groundGeometry.computeVertexNormals();
    this.groundGeometry.computeBoundingSphere();
    const lp = this.traceGeometry.attributes.position.array;
    for (let c = 0; c < cols; c++) {
      lp[c * 3] = TERRAIN_X0 + c * TERRAIN_DX;
      lp[c * 3 + 1] = this.terrain[c] * this.scaleY + 1.5;
      lp[c * 3 + 2] = 0;
    }
    this.traceGeometry.attributes.position.needsUpdate = true;
    this.traceGeometry.computeBoundingSphere();
    if (this.pebbles) this.placePebbles();
  }

  buildFeatures() {
    const rockGeo = new T.SphereGeometry(1, 9, 6);
    const rp = rockGeo.attributes.position;
    for (let i = 0; i < rp.count; i++) {
      const f = 0.85 + 0.3 * hash(Math.round(rp.getX(i) * 50), Math.round(rp.getY(i) * 50 + rp.getZ(i) * 31));
      rp.setXYZ(i, rp.getX(i) * f, rp.getY(i) * f, rp.getZ(i) * f);
    }
    rockGeo.computeVertexNormals();
    const rockMat = new T.MeshStandardMaterial({ color: 0x6f6b66, roughness: 1, flatShading: true });
    this.rocks = new T.Group();
    this.placed = []; // [object, x, lift, z]
    for (let i = 0; i < TERRAIN_N; i++) {
      const f = this.features[i];
      const x = TERRAIN_X0 + i * TERRAIN_DX + TERRAIN_DX / 2;
      if (f === FEATURE.ROCK) {
        const m = new T.Mesh(rockGeo, rockMat);
        const s = 9 + 6 * hash(i, 1);
        const sz = s * (0.8 + 0.5 * hash(i, 3));
        m.scale.set(s * (0.8 + 0.5 * hash(i, 2)), s * 0.75, sz);
        m.rotation.y = hash(i, 4) * 6;
        m.castShadow = true;
        m.receiveShadow = true;
        this.rocks.add(m);
        // Behind the plane, so the walking strip in front stays clear.
        this.placed.push([m, x, s * 0.35, -sz * 0.72]);
      }
      if (f === FEATURE.DINER) {
        this.dinerX = x;
        this.diner = this.buildDiner();
        this.scene.add(this.diner);
        this.placed.push([this.diner, x, 'pad', 0]);
      }
    }
    this.scene.add(this.rocks);
    this.placeFeatures();
  }

  placeFeatures() {
    for (const [o, x, lift, z] of this.placed) {
      if (lift === 'pad') {
        // The lot is level, a little above the highest ground under it.
        let top = -Infinity, low = Infinity;
        for (let lx = PAD.x0; lx <= PAD.x1; lx += 4) {
          top = Math.max(top, this.height(x + lx));
          low = Math.min(low, this.height(x + lx));
        }
        this.pad = { x, y: top + 0.25 };
        o.position.set(x, this.pad.y, 0);
        this.padSlab.scale.y = this.pad.y - low + 1.5;
      } else o.position.set(x, this.height(x) + lift, z);
    }
  }

  /** A drive-in diner: a glass box under a wide flat roof, a lit interior,
   * a wing over the charging stalls, a walk-up window out to the lot, two
   * big screens on posts angled at the lot, a plain round sign, and the
   * first customer at the end stall. Its origin is on the lot's surface. */
  buildDiner() {
    const g = new T.Group();
    const white = new T.MeshStandardMaterial({ color: 0xece9e2, roughness: 0.55, metalness: 0.05, envMap: this.env, envMapIntensity: 0.5 });
    const concrete = new T.MeshStandardMaterial({ color: 0x9a9792, roughness: 0.95 });
    const dark = new T.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.5, metalness: 0.4 });
    const glass = new T.MeshPhysicalMaterial({ color: 0x141a22, roughness: 0.06, metalness: 0.6, transparent: true, opacity: 0.78, envMap: this.env });
    const warm = new T.MeshBasicMaterial({ color: 0xc9a470 });
    const add = (mesh, x, y, z, shadow = true) => {
      mesh.position.set(x, y, z);
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      g.add(mesh);
      return mesh;
    };
    // The lot: a slab, its top at the origin, deep enough to meet the ground.
    const slabGeo = new T.BoxGeometry(PAD.x1 - PAD.x0, 1, PAD.z1 - PAD.z0);
    slabGeo.translate((PAD.x0 + PAD.x1) / 2, -0.5, (PAD.z0 + PAD.z1) / 2);
    this.padSlab = add(new T.Mesh(slabGeo, concrete), 0, 0, 0, false);
    // The building: lit inside, glass outside, mullions across the front.
    add(new T.Mesh(new T.BoxGeometry(64, 9.5, 28), warm), 0, 5.8, -23, false);
    add(new T.Mesh(new T.BoxGeometry(70, 12.5, 34), glass), 0, 6.8, -22);
    for (let x = -33; x <= 33; x += 6) add(new T.Mesh(new T.BoxGeometry(0.35, 12.5, 0.5), dark), x, 6.8, -4.8, false);
    // Counter and a few interior shapes, dark against the warm light.
    add(new T.Mesh(new T.BoxGeometry(40, 3.5, 2), dark), 0, 2.5, -8, false);
    for (const x of [-22, -8, 8, 22]) add(new T.Mesh(new T.BoxGeometry(5, 4.5, 5), dark), x, 2.9, -30, false);
    // The flat roof, wide, with a soffit line.
    add(new T.Mesh(new T.BoxGeometry(84, 1.3, 46), white), 0, 13.7, -22);
    add(new T.Mesh(new T.BoxGeometry(80, 0.5, 42), dark), 0, 12.9, -22, false);
    // The walk-up window: a white bay out from the front to the lane, a
    // lit opening, a steel counter.
    const wx = WINDOW.dx, front = WINDOW.z - 1.15;
    const depth = front + 5;
    const bay = (w, h, x, y) => add(new T.Mesh(new T.BoxGeometry(w, h, depth), white), wx + x, y, -5 + depth / 2);
    bay(1.6, 9.6, -2.8, 4.8);
    bay(1.6, 9.6, 2.8, 4.8);
    bay(4.0, 3.5, 0, 1.75);
    bay(4.0, 3.1, 0, 8.05);
    add(new T.Mesh(new T.BoxGeometry(7.6, 0.5, depth + 0.8), white), wx, 9.85, -5 + depth / 2 + 0.3);
    add(new T.Mesh(new T.BoxGeometry(4.0, 3.0, 0.3), warm), wx, 5.0, front - 2.2, false);
    add(new T.Mesh(new T.BoxGeometry(0.15, 3.0, 2.2), dark), wx - 2.0, 5.0, front - 1.1, false);
    add(new T.Mesh(new T.BoxGeometry(0.15, 3.0, 2.2), dark), wx + 2.0, 5.0, front - 1.1, false);
    add(new T.Mesh(new T.BoxGeometry(4.0, 0.12, 0.8), new T.MeshStandardMaterial({ color: 0xb8bbbe, metalness: 0.9, roughness: 0.3, envMap: this.env })), wx, 3.44, front + 0.3);
    add(new T.Mesh(new T.BoxGeometry(4.2, 0.08, 0.08), new T.MeshBasicMaterial({ color: new T.Color(2.4, 2.0, 1.4) })), wx, 6.75, front + 0.05, false);
    // The wing over the stalls on four thin columns.
    add(new T.Mesh(new T.BoxGeometry(96, 0.9, 26), white), 0, 16.8, 14);
    for (const x of [-40, -13, 13, 40]) add(new T.Mesh(new T.CylinderGeometry(0.45, 0.45, 17, 10), white), x, 8.0, 14);
    // Charging stalls, each with a light strip.
    for (let i = -3; i <= 4; i++) {
      add(new T.Mesh(new T.BoxGeometry(1.3, 4.6, 1.0), white), i * 11 - 5.5, 2.3, 24);
      add(new T.Mesh(new T.BoxGeometry(0.2, 2.2, 0.3), warm), i * 11 - 5.5, 2.5, 24.6, false);
    }
    // Two big screens, angled toward the lot, showing the 1973 tube.
    this.screens = [];
    for (const sx of [-112, 112]) {
      const stand = new T.Group();
      stand.position.set(sx, -1, -44);
      stand.rotation.y = sx < 0 ? 0.28 : -0.28;
      const post = new T.Mesh(new T.BoxGeometry(2.4, 32, 2.4), dark);
      post.position.y = 16;
      post.castShadow = true;
      const frame = new T.Mesh(new T.BoxGeometry(48, 37, 1.6), dark);
      frame.position.y = 44;
      frame.castShadow = true;
      const screen = new T.Mesh(new T.PlaneGeometry(46, 34.5), new T.MeshBasicMaterial({ map: this.tubeTexture, toneMapped: false }));
      screen.position.set(0, 44, 0.9);
      stand.add(post, frame, screen);
      g.add(stand);
      this.screens.push(screen);
    }
    // A round sign on a pole, plain: a white disc in a thin dark ring.
    add(new T.Mesh(new T.CylinderGeometry(0.6, 0.6, 34, 12), dark), 72, 16, 36);
    const disc = add(new T.Mesh(new T.CylinderGeometry(7.5, 7.5, 0.6, 32), white), 72, 37, 36);
    disc.rotation.x = Math.PI / 2;
    add(new T.Mesh(new T.TorusGeometry(7.6, 0.35, 8, 40), dark), 72, 37, 36);
    // The first customer: the 1973 lander, in light, at the end stall.
    const lander = this.buildLander();
    lander.position.set(-44, -0.7, 30);
    g.add(lander);
    return g;
  }

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    const size = new T.Vector2();
    this.renderer.getSize(size);
    if (size.x !== w || size.y !== h) {
      this.renderer.setSize(w, h, false);
      this.composer.setSize(w * this.renderer.getPixelRatio(), h * this.renderer.getPixelRatio());
      this.camera.aspect = w / h;
      // A wider view on a tall screen, so the horizon stays in it.
      this.camera.fov = w / h < 1 ? 62 : w / h < 1.4 ? 50 : 42;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Whether the ship is standing on the ground: the radar reads zero or
   * less (the program stops flying it there; when it lifts off again it
   * puts it four feet up first). */
  onGround(state) {
    return this.closeUp(state) && state.radary <= 0;
  }

  /** Where the car's reference point is, from the state; in flight carried
   * forward between the program's steps with its own velocities, on the
   * ground exactly where the program has it. */
  poseFrom(state, now, down) {
    // On the ground it stands on the ground (the program's VERDIS is a
    // little above it; the springs take the rest).
    if (down) return { x: state.hordis, y: this.groundAt(state.hordis, 0) - 0.06, a: state.angle };
    const dt = Math.min(0.25, ((now - this.lastStateWall) / 1000) * (this.rate ?? 1));
    return {
      x: state.hordis + (state.horvel / 10) * dt,
      y: state.verdis + (state.vervel / 10) * dt,
      a: state.angle,
    };
  }

  /**
   * Draw a frame. `state` is the engine's state, `now` performance.now(),
   * `dt` seconds since the last frame.
   */
  frame(state, now, dt) {
    this.update(state, now, dt);
    this.render();
  }

  /** Everything but the drawing: poses, camera, particles, events. */
  update(state, now, dt) {
    if (!this.terrain) return;
    const mdt = dt * (this.rate ?? 1); // machine seconds this frame
    // A new game: the program has run INIT again (TIME starts over).
    if (this.lastState && state.time < this.lastState.time) this.reset();
    this.setScale(this.closeUp(state) ? 0.25 : 1);
    if (state !== this.lastState || state.t !== this.lastT) {
      if (!this.lastState || state.hordis !== this.lastState.hordis || state.verdis !== this.lastState.verdis) this.lastStateWall = now;
      this.lastState = { ...state };
      this.lastT = state.t;
    }
    // Machine time, carried forward between the program's steps.
    const mt = state.t / 1e6 + Math.min(0.25, ((now - this.lastStateWall) / 1000) * (this.rate ?? 1));
    this.mtime = Math.max(this.mtime, mt);
    const down = this.onGround(state);
    if (down) this.wasDown = true;
    if (!this.closeUp(state)) this.wasDown = false;
    this.liftingOff = this.wasDown && !down && !this.exploded;
    const target = this.poseFrom(this.lastState, now, down);

    // Turning: the program clears TURN as soon as it has used it, so read
    // the turn off the angle itself; the attitude jets fire with it.
    if (this.prevAngle !== undefined && target.a !== this.prevAngle && !down) {
      let d = target.a - this.prevAngle;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      // Clockwise is nose down: push the nose down, the tail up.
      if (d > 0) {
        this.exhaust.puff('noseUp');
        this.exhaust.puff('tailDown');
      } else {
        this.exhaust.puff('noseDown');
        this.exhaust.puff('tailUp');
      }
      this.puffing = true;
    } else this.puffing = false;
    this.prevAngle = target.a;
    const k = this.first ? 1 : 1 - Math.exp(-dt / 0.06);
    const prevX = this.pose.x;
    this.pose.x += (target.x - this.pose.x) * k;
    this.pose.y += (target.y - this.pose.y) * k;
    // Angles: the program's are degrees clockwise from up. On the ground a
    // big change is the ship falling over (TILT): let it fall, not snap.
    let da = target.a - this.pose.a;
    while (da > 180) da -= 360;
    while (da < -180) da += 360;
    const tau = down && Math.abs(da) > 10 ? 0.45 : 0.12;
    this.pose.a += da * (this.first ? 1 : 1 - Math.exp(-dt / tau));

    const ground = this.height(this.pose.x);
    const alt = Math.max(0, this.pose.y - ground);
    // Camera: distance follows altitude; looks at a point between the car
    // and the ground under it, from in front and a little above. Far out,
    // it stands well back and higher, so the whole valley reads.
    const close = this.scaleY < 1;
    const fit = (alt + 30) / (2 * 1.15 * Math.tan(T.MathUtils.degToRad(this.camera.fov / 2)));
    const d = close ? T.MathUtils.clamp(Math.max(alt * 0.6 + 55, fit), 55, 900) : T.MathUtils.clamp(Math.max(alt * 1.9 + 900, fit), 1200, 36000);
    // The car is drawn larger when the camera is far, so it can be seen.
    // (On a cut the camera has not moved yet: go by where it is going.)
    const dist = this.first ? d : this.camPos.distanceTo(this.camTarget) || d;
    const scale = Math.max(1, dist / 500);
    this.car.group.visible = !this.exploded;
    this.car.place(this.pose.x, this.pose.y, this.pose.a, (x) => this.groundAt(x, 0), mdt, scale);
    if (this.car.wheels.some((w) => w.contact)) this.car.roll(this.pose.x - prevX);

    // The driver.
    this.man.root.visible = !this.exploded;
    this.man.root.scale.setScalar(this.driver.isOut ? 1 : scale);
    if (!this.exploded) this.driver.update(state, this.mtime, mdt, down);
    this.walking = this.driver.isOut && close;
    const driverX = this.driver.x;

    const look = new T.Vector3(this.pose.x + (state.horvel / 10) * 0.6, ground + alt * (close ? 0.5 : 0.6) + 6, 0);
    let d2 = d;
    if (this.walking && driverX !== undefined) {
      // Both the car and the driver in the frame while he walks; follow
      // him, and bring the car in as he nears it.
      const gap = Math.abs(driverX - this.pose.x);
      const near = T.MathUtils.smoothstep(gap, 10, 30);
      look.x = T.MathUtils.lerp((this.pose.x + driverX) / 2, driverX, near);
      look.y = this.groundAt(look.x, 5) + 5.5;
      look.z = 2.5;
      d2 = Math.max(40, T.MathUtils.lerp(gap * 0.9 + 38, 52, near));
    }
    // Low elevation, as the 1973 side view was: the needle mountains read
    // as a skyline, and the depth behind them is the bonus.
    const up = close ? (this.walking ? 0.16 : 0.14) : T.MathUtils.lerp(0.06, 0.1, Math.min(1, d / 20000));
    const cam = new T.Vector3(look.x + d2 * 0.1, look.y + d2 * up, look.z + d2 * 0.95);
    // Keep the camera above the ground in front.
    cam.y = Math.max(cam.y, this.heightAt(cam.x, cam.z) + (close ? 6 : 25));
    const kc = this.first ? 1 : 1 - Math.exp(-dt / 0.5);
    if (this.debugCam) {
      // For tests: a fixed camera.
      cam.set(...this.debugCam.pos);
      look.set(...this.debugCam.look);
    }
    this.camTarget.lerp(look, kc);
    this.camPos.lerp(cam, kc);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget);
    this.camera.near = Math.max(0.5, Math.min(d, d2) * 0.01);
    this.camera.far = 400000;
    this.camera.updateProjectionMatrix();

    // The sun's shadow camera follows what is being looked at.
    const sunR = close ? T.MathUtils.clamp(alt * 1.2 + 70, 70, 900) : T.MathUtils.clamp(alt * 1.2 + 200, 120, 4000);
    this.sunTarget.position.copy(this.camTarget);
    this.sun.position.copy(this.sunTarget.position).addScaledVector(this.sunDir, sunR * 3);
    const sc = this.sun.shadow.camera;
    sc.left = -sunR; sc.right = sunR; sc.top = sunR; sc.bottom = -sunR;
    sc.near = sunR; sc.far = sunR * 6;
    sc.updateProjectionMatrix();

    // Exhaust. THRUST stays where it was when the program stops flying,
    // so on the ground there is none, whatever it says.
    const maxThrust = this.maxThrust || 1;
    const power = this.exploded || down ? 0 : Math.max(0, Math.min(1, state.thrust / maxThrust)) * (state.fuel > 0 ? 1 : 0);
    this.thrustNow = power;
    const jet = this.exploded ? { hit: null } : this.exhaust.update(this.mtime, mdt, power, this.camera, (x, z) => this.groundAt(x, z), scale);
    if (this.exploded) this.exhaust.hide();
    if (jet.hit) {
      this.dust.emit(mdt, jet.hit, jet.strength, jet.alt, (x, z) => this.groundAt(x, z), scale);
      this.scour(jet.hit, jet.strength, jet.alt, mdt);
    } else this.dust.stop();
    this.dust.update(this.mtime);

    // A crash: the program stops drawing the ship (SHIPDP cleared) once it
    // has drawn it at least once this game.
    if (state.shipdp !== 0) this.shipSeen = true;
    if (this.shipSeen && state.shipdp === 0 && !this.exploded && close) this.explode(state);
    if (this.debris) this.debris.step(mdt);
    if (this.flashAt !== undefined) {
      const f = this.mtime - this.flashAt;
      this.flash.position.copy(this.car.group.position).add(new T.Vector3(0, 6, 4));
      this.flash.intensity = f < 0.5 ? 700 * Math.exp(-f * 12) : 0;
      if (f > 1) this.flashAt = undefined;
    }
    if (this.rereadAt && this.rereadAt.length && this.mtime >= this.rereadAt[0]) {
      this.rereadAt.shift();
      this.rereadTerrain();
    }
    // The diner, if the program says it has been destroyed.
    if (this.diner) this.dinerStands(!!(state.diner & 1));
    this.first = false;
  }

  /** The exhaust blows the fine dust off the ground where it lands: the
   * spot stays brighter afterwards, as it did round each Apollo lander. */
  scour(at, strength, alt, dt) {
    let b = this.blasts.find((z) => Math.hypot(z.x - at.x, z.z - at.z) < 12);
    if (!b) {
      b = { x: at.x, z: at.z, r: 6, s: 0 };
      this.blasts.push(b);
      if (this.blasts.length > 4) this.blasts.shift();
    }
    b.x += (at.x - b.x) * Math.min(1, dt * 2);
    b.z += (at.z - b.z) * Math.min(1, dt * 2);
    b.s = Math.min(1, b.s + strength * dt * 0.35);
    b.r = Math.max(b.r, Math.min(40, 8 + alt * 1.1));
    this.blastUniform.value.forEach((v, i) => {
      const z = this.blasts[i];
      if (z) v.set(z.x, z.z, z.r, z.s);
      else v.set(0, 0, 1, 0);
    });
  }

  render() {
    if (!this.terrain) return;
    this.resize();
    this.tubeTexture.needsUpdate = true;
    this.composer.render();
  }

  explode(state) {
    this.exploded = true;
    // The program digs a crater as it explodes (ALTER): read it soon.
    this.rereadAt = [this.mtime + 0.1, this.mtime + 1.2];
    const v = new T.Vector3(state.horvel / 10, state.vervel / 10, 0);
    this.debris = new Debris(this.scene, this.car, v, this.random, (x, z) => this.groundAt(x, z));
    this.exhaust.hide();
    this.flashAt = this.mtime;
  }

  /** The diner stands, or lies flattened by a car. */
  dinerStands(up) {
    if (this.dinerUp === up) return;
    this.dinerUp = up;
    this.diner.scale.y = up ? 1 : 0.3;
    for (const [i, sc] of this.screens.entries()) sc.parent.rotation.z = up ? 0 : (i ? -1 : 1) * 0.6;
  }

  /** The terrain as the program has it now: a crash digs a crater. */
  rereadTerrain() {
    if (!this.peek) return;
    let changed = false;
    for (let i = 0; i < TERRAIN_N; i++) {
      const v = (this.peek(this.symbols.TERAIN + 2 * i) << 16) >> 16;
      if (v !== this.terrain[i]) {
        this.terrain[i] = v;
        changed = true;
      }
    }
    if (changed) {
      this.fillTerrain();
      this.placeFeatures();
    }
  }

  /** A new game: the car is whole again, and the driver in it. */
  reset() {
    if (this.peek) {
      this.rereadTerrain();
      this.buildLeftovers();
    }
    this.exploded = false;
    this.shipSeen = false;
    this.walking = false;
    this.wasDown = false;
    this.driver.reset();
    this.car.setCanopy(0);
    if (this.debris) {
      this.debris.dispose();
      this.debris = null;
    }
    this.dust.clear();
    this.exhaust.hide();
    this.first = true;
  }
}
