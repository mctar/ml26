// The 2026 view: Burness's terrain as a lit surface, the Roadster coming
// down on cold gas, a camera that follows. Everything here is drawn from
// the game's state as the original's variables hold it; nothing here
// decides anything.
//
// Units are the program's: feet. x is HORDIS, y is VERDIS, the flight is in
// the plane z = 0; the terrain profile at z = 0 is the original's TERAIN
// table exactly, and falls away into invented hills behind and in front.

import * as T from './vendor/three.js';
import { Astronaut } from './astronaut.js';

const TERRAIN_N = 911;          // words in TERAIN
const TERRAIN_X0 = -22400;      // feet at index 0
const TERRAIN_DX = 32;          // feet per index
const CAR_LENGTH = 15;          // feet, a Roadster
const CAR_WIDTH = 6.8;
const SEAT_Z = 0.9;             // the single seat, on the camera's side
const FT = 1;

/** Burness's lander, from the DESIGN table: moves (M) and lines (L) in
 * raster units about the ship's centre, with the intensity level (I). */
const LANDER_1973 = [['I', 4], ['M', -6, 0], ['L', -14, 8], ['L', -14, 20], ['L', -6, 29], ['L', 6, 29], ['L', 14, 20], ['L', 14, 8], ['L', 6, 0], ['L', -6, 0], ['M', -17, 0], ['L', -17, -16], ['L', 17, -16], ['L', 17, 0], ['L', -17, 0], ['I', 3], ['L', -32, -24], ['M', 17, 0], ['L', 32, -24], ['I', 1], ['M', -17, -14], ['L', -28, -18], ['M', 17, -14], ['L', 28, -18], ['I', 4], ['M', 36, -24], ['L', 28, -24], ['M', -28, -24], ['L', -36, -24], ['M', -3, -16], ['L', -7, -21], ['L', 7, -21], ['L', 3, -16]];

export const FEATURE = { NONE: 0, OLD_SHIP: 1, FLAG: 2, WRECK_LEFT: 3, WRECK_RIGHT: 4, ROCK: 5, DINER_SIDE: 6, DINER: 7 };

// A small, fast hash noise for the hills.
function hash(x, y) {
  let h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
function fbm(x, y) {
  let s = 0, amp = 1, f = 1, norm = 0;
  for (let i = 0; i < 4; i++) {
    s += amp * noise(x * f, y * f);
    norm += amp;
    amp *= 0.5;
    f *= 2.1;
  }
  return s / norm;
}

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
    // The program keeps the terrain at its full height while the ship is
    // high, and at a quarter of it once the ship is below 450 feet and the
    // close-up begins ("continuing fudging terrain by known standards").
    // The 1973 display cut between two pictures there; so does the camera.
    this.scaleY = 1;
    this.lights();
    this.sky();
    this.car = this.buildCar();
    this.scene.add(this.car);
    this.plume = new Plume(this.scene, 3000);
    this.dust = new Dust(this.scene, 1500);
    this.smoke = new Dust(this.scene, 600);
    this.smoke.material.uniforms.color.value = new T.Color(0.12, 0.11, 0.1);
    this.squat = null;
    this.exploded = false;
    this.debris = null;
    this.composer = null;
    // The driver outside the car; the one inside is part of the car.
    this.walker = new Astronaut();
    this.walker.group.visible = false;
    this.scene.add(this.walker.group);
    this.out = null; // the driver's doings outside: see driverUpdate
    this.flag = this.buildFlag();
    this.flag.visible = false;
    this.scene.add(this.flag);
    this.setupPost();
  }

  buildFlag() {
    const g = new T.Group();
    const pole = new T.Mesh(new T.CylinderGeometry(0.06, 0.08, 9, 8), new T.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.8, roughness: 0.3 }));
    pole.position.y = 4.5;
    const cloth = new T.Mesh(new T.PlaneGeometry(5, 3), new T.MeshStandardMaterial({ color: 0xffffff, side: T.DoubleSide, roughness: 0.9 }));
    cloth.position.set(2.5, 7.5, 0);
    // The flag's stripes and field, by vertex colour.
    const c = document.createElement('canvas');
    c.width = 100; c.height = 60;
    const ctx = c.getContext('2d');
    for (let i = 0; i < 13; i++) { ctx.fillStyle = i % 2 ? '#ffffff' : '#b31942'; ctx.fillRect(0, (i * 60) / 13, 100, 60 / 13 + 1); }
    ctx.fillStyle = '#0a3161';
    ctx.fillRect(0, 0, 40, 60 * 7 / 13);
    ctx.fillStyle = '#fff';
    for (let r = 0; r < 5; r++) for (let k = 0; k < 6; k++) ctx.fillRect(3 + k * 6.5, 3 + r * 6, 1.6, 1.6);
    const tex = new T.CanvasTexture(c);
    tex.colorSpace = T.SRGBColorSpace;
    cloth.material.map = tex;
    pole.castShadow = cloth.castShadow = true;
    g.add(pole, cloth);
    return g;
  }

  setupPost() {
    const size = new T.Vector2();
    this.renderer.getSize(size);
    this.composer = new T.EffectComposer(this.renderer);
    this.composer.addPass(new T.RenderPass(this.scene, this.camera));
    this.bloom = new T.UnrealBloomPass(size, 0.55, 0.6, 0.85);
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
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.5;
    this.sunTarget = new T.Object3D();
    this.scene.add(this.sunTarget);
    this.sun.target = this.sunTarget;
    this.scene.add(this.sun);
    // Earthshine and the ground's bounce: faint, bluish from above, warm
    // grey from below.
    this.scene.add(new T.HemisphereLight(0x3a4457, 0x3a3430, 0.9));
    // A light for the moment of a crash.
    this.flash = new T.PointLight(0xfff0d0, 0, 400, 1.5);
    this.scene.add(this.flash);
  }

  sky() {
    const n = 2500;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      // Points on a far sphere, more of them near the horizon.
      const u = Math.random(), v = Math.random();
      const th = 2 * Math.PI * u, ph = Math.acos(1 - v * 1.15);
      const r = 150000;
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.cos(ph) + 2000;
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
      const b = 0.35 + 0.65 * Math.pow(Math.random(), 3);
      const warm = Math.random() < 0.3;
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
    const nz = (x, y) => noise(x, y);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 512; x++) {
        const u = x / 512, v = y / 256;
        const land = fbm(u * 9 + 2.3, v * 5 + 1.1) + 0.35 * fbm(u * 27, v * 15) - 0.78 + 0.18 * Math.abs(v - 0.5);
        const ice = Math.abs(v - 0.5) > 0.44;
        let r, g, b;
        if (ice) { r = 235; g = 240; b = 245; }
        else if (land > 0) { const t = Math.min(1, land * 6); r = 110 + 40 * t; g = 100 + 30 * t; b = 60 + 20 * t; }
        else { r = 30; g = 70; b = 150; }
        const cloud = Math.max(0, fbm(u * 14 + 7.7, v * 8 + 3.3) - 0.55) * 2.6;
        r = r + (245 - r) * cloud; g = g + (245 - g) * cloud; b = b + (248 - b) * cloud;
        const i = (y * 512 + x) * 4;
        img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    void nz;
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
    if (this.leftovers) this.scene.remove(this.leftovers);
    this.leftovers = new T.Group();
    this.features = this.readFeatures();
    for (let i = 0; i < TERRAIN_N; i++) {
      const f = this.features[i];
      if (f !== FEATURE.OLD_SHIP && f !== FEATURE.FLAG && f !== FEATURE.WRECK_LEFT && f !== FEATURE.WRECK_RIGHT) continue;
      const x = TERRAIN_X0 + i * TERRAIN_DX + TERRAIN_DX / 2;
      const y = this.height(x);
      let o;
      if (f === FEATURE.FLAG) {
        o = this.buildFlag();
      } else {
        o = this.buildCar(f === FEATURE.OLD_SHIP ? 'parked' : 'wreck');
        if (f === FEATURE.WRECK_LEFT) o.rotation.z = 0.5;
        if (f === FEATURE.WRECK_RIGHT) o.rotation.z = -0.5;
      }
      o.position.set(x, y, 0);
      this.leftovers.add(o);
    }
    this.scene.add(this.leftovers);
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
    const lines = new T.LineSegments(g, m);
    const grp = new T.Group();
    grp.add(lines);
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
      // The front slopes: a face proportional to the height, down to a
      // floor with a little grain, never above the crest.
      const w = Math.min(1, d / 1400);
      const w2 = w * w * (3 - 2 * w);
      const ws = Math.min(1, d / 400);
      const base = h0 * (1 - ws) + h1 * ws;
      const far = Math.min(1, Math.max(0, d - 1400) / 20000);
      const floor = Math.min(base, h1 * 0.15) - 40 + (fbm(x / 420, z / 420 + 7.7) - 0.5) * 60 * w + (fbm(x / 6000 + 1.3, z / 6000) - 0.5) * 1200 * far;
      return base * (1 - w2) + floor * w2;
    }
    // Behind: a smoothed profile, so the hills do not copy every spike,
    // then the invented range.
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
    const mat = new T.MeshStandardMaterial({ color: 0x8a8884, roughness: 0.96, metalness: 0.0, flatShading: false });
    // Regolith: grain in the colour, and relief in the normal, from noise
    // in world space: fine grit, a coarser roll, and shallow craters with
    // rims. All of it fades with distance so it never shimmers.
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vW;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvW = (modelMatrix * vec4(position, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec3 vW;
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
    // World-space perturbation folded into the view-space normal.
    vec3 nv = normalize((viewMatrix * vec4(n, 0.0)).xyz);
    normal = normalize(mix(normal, normalize(normal + (nv - normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz))), k));
  }
}`)
        .replace('#include <color_fragment>', '#include <color_fragment>\n{ float g = h21(floor(vW.xz * 3.0)) * 0.25 + vnoise(vW.xz * 0.12) * 0.45 + vnoise(vW.xz * 0.012 + 4.0) * 0.3; diffuseColor.rgb *= 0.84 + 0.3 * g; }');
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
    // Loose rocks along the way, a few thousand, instanced.
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
      const sz = 0.4 + 3.2 * Math.pow(hash(i, 14), 3);
      this.pebbleAt.push([x, z, sz, hash(i, 15) * 6.28, 0.6 + 0.8 * hash(i, 16), 0.5 + 0.6 * hash(i, 17)]);
    }
    this.scene.add(this.pebbles);
    this.fillTerrain();
  }

  placePebbles() {
    const m = new T.Matrix4(), q = new T.Quaternion(), e = new T.Euler(), p = new T.Vector3(), sc = new T.Vector3();
    for (let i = 0; i < this.pebbleAt.length; i++) {
      const [x, z, sz, rot, sx, sy] = this.pebbleAt[i];
      p.set(x, this.heightAt(x, z) + sz * 0.25, z);
      e.set(0, rot, 0);
      q.setFromEuler(e);
      sc.set(sz * sx, sz * sy, sz);
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
    const rockGeo = new T.SphereGeometry(1, 7, 5);
    const rockMat = new T.MeshStandardMaterial({ color: 0x6f6b66, roughness: 1, flatShading: true });
    this.rocks = new T.Group();
    this.placed = []; // [object, x, lift]
    for (let i = 0; i < TERRAIN_N; i++) {
      const f = this.features[i];
      const x = TERRAIN_X0 + i * TERRAIN_DX + TERRAIN_DX / 2;
      if (f === FEATURE.ROCK) {
        const m = new T.Mesh(rockGeo, rockMat);
        const s = 9 + 6 * hash(i, 1);
        m.scale.set(s * (0.8 + 0.5 * hash(i, 2)), s * 0.75, s * (0.8 + 0.5 * hash(i, 3)));
        m.rotation.y = hash(i, 4) * 6;
        m.castShadow = true;
        m.receiveShadow = true;
        this.rocks.add(m);
        this.placed.push([m, x, s * 0.35]);
      }
      if (f === FEATURE.DINER) {
        this.diner = this.buildDiner();
        this.scene.add(this.diner);
        this.placed.push([this.diner, x, 0]);
      }
    }
    this.scene.add(this.rocks);
    this.placeFeatures();
  }

  placeFeatures() {
    for (const [o, x, lift] of this.placed) o.position.set(x, this.height(x) + lift, 0);
  }

  /** A drive-in diner: a glass box under a wide flat roof, a lit interior,
   * a wing over the charging stalls, two big screens on posts angled at
   * the lot, a plain round sign, and the first customer at the end stall. */
  buildDiner() {
    const g = new T.Group();
    const white = new T.MeshStandardMaterial({ color: 0xece9e2, roughness: 0.55, metalness: 0.05 });
    const concrete = new T.MeshStandardMaterial({ color: 0x9a9792, roughness: 0.95 });
    const dark = new T.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.5, metalness: 0.4 });
    const glass = new T.MeshPhysicalMaterial({ color: 0x141a22, roughness: 0.06, metalness: 0.6, transparent: true, opacity: 0.78 });
    const warm = new T.MeshBasicMaterial({ color: 0xc9a470 });
    const add = (mesh, x, y, z, shadow = true) => {
      mesh.position.set(x, y, z);
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      g.add(mesh);
      return mesh;
    };
    add(new T.Mesh(new T.BoxGeometry(110, 1.4, 70), concrete), 0, 0.7, -2, false);
    // The building: lit inside, glass outside, mullions across the front.
    add(new T.Mesh(new T.BoxGeometry(64, 9.5, 28), warm), 0, 6.5, -23, false);
    add(new T.Mesh(new T.BoxGeometry(70, 12.5, 34), glass), 0, 7.5, -22);
    for (let x = -33; x <= 33; x += 6) add(new T.Mesh(new T.BoxGeometry(0.35, 12.5, 0.5), dark), x, 7.5, -4.8, false);
    // Counter and a few interior shapes, dark against the warm light.
    add(new T.Mesh(new T.BoxGeometry(40, 3.5, 2), dark), 0, 3.2, -8, false);
    for (const x of [-22, -8, 8, 22]) add(new T.Mesh(new T.BoxGeometry(5, 4.5, 5), dark), x, 3.6, -30, false);
    // The flat roof, wide, with a soffit line.
    add(new T.Mesh(new T.BoxGeometry(84, 1.3, 46), white), 0, 14.4, -22);
    add(new T.Mesh(new T.BoxGeometry(80, 0.5, 42), dark), 0, 13.6, -22, false);
    // The wing over the stalls on four thin columns.
    add(new T.Mesh(new T.BoxGeometry(96, 0.9, 26), white), 0, 17.5, 14);
    for (const x of [-40, -13, 13, 40]) add(new T.Mesh(new T.CylinderGeometry(0.45, 0.45, 17, 10), white), x, 8.5, 14);
    // Charging stalls, each with a light strip.
    for (let i = -3; i <= 4; i++) {
      add(new T.Mesh(new T.BoxGeometry(1.3, 4.6, 1.0), white), i * 11 - 5.5, 3.7, 24);
      add(new T.Mesh(new T.BoxGeometry(0.2, 2.2, 0.3), warm), i * 11 - 5.5, 3.9, 24.6, false);
    }
    // Two big screens, angled toward the lot, showing the 1973 tube.
    this.screens = [];
    for (const sx of [-112, 112]) {
      const stand = new T.Group();
      stand.position.set(sx, 0, -44);
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
    add(new T.Mesh(new T.CylinderGeometry(0.6, 0.6, 34, 12), dark), 72, 17, 36);
    const disc = add(new T.Mesh(new T.CylinderGeometry(7.5, 7.5, 0.6, 32), white), 72, 38, 36);
    disc.rotation.x = Math.PI / 2;
    const ring = add(new T.Mesh(new T.TorusGeometry(7.6, 0.35, 8, 40), dark), 72, 38, 36);
    void ring;
    // The first customer: the 1973 lander, in light, at the end stall.
    const lander = this.buildLander();
    lander.position.set(-44, 0, 30);
    g.add(lander);
    return g;
  }

  /** The car: a first model from primitives, white, low, long. `kind` is
   * 'live', 'parked' (left by an earlier landing) or 'wreck'. */
  buildCar(kind = 'live') {
    const g = new T.Group();
    // The body rides on the wheels: it can settle on touchdown.
    const b = new T.Group();
    g.add(b);
    const paint = kind === 'wreck'
      ? new T.MeshStandardMaterial({ color: 0x4a4744, roughness: 0.9, metalness: 0.1 })
      : new T.MeshPhysicalMaterial({ color: 0xf2f2ee, roughness: 0.35, metalness: 0.15, clearcoat: 0.8, clearcoatRoughness: 0.2 });
    const glass = new T.MeshPhysicalMaterial({ color: 0x1a2430, roughness: 0.1, metalness: 0.6, transparent: true, opacity: 0.85 });
    const rubber = new T.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 });
    const rim = new T.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.3, metalness: 0.9 });
    const L = CAR_LENGTH, W = CAR_WIDTH;
    // Side profile, nose to the +x: a long hood, the cabin set back, a
    // flat tail. Curves where a car has curves.
    const s = new T.Shape();
    s.moveTo(-L / 2, 0.95);
    s.lineTo(-L / 2 + 0.8, 0.7);
    s.lineTo(L / 2 - 1.6, 0.6);
    s.quadraticCurveTo(L / 2, 0.7, L / 2, 1.4);
    s.quadraticCurveTo(L / 2, 2.0, L / 2 - 0.6, 2.05);
    s.quadraticCurveTo(L * 0.2, 2.35, L * 0.06, 2.6);
    s.quadraticCurveTo(-L * 0.04, 3.45, -L * 0.14, 3.55);
    s.lineTo(-L * 0.3, 3.5);
    s.quadraticCurveTo(-L / 2 + 0.6, 3.2, -L / 2, 2.7);
    s.closePath();
    const body = new T.Mesh(new T.ExtrudeGeometry(s, { depth: W, bevelEnabled: true, bevelThickness: 0.4, bevelSize: 0.36, bevelSegments: 4, curveSegments: 10 }), paint);
    body.position.z = -W / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    b.add(body);
    // Wheel arches: dark discs in the flanks where the cutouts would be.
    const archMat = new T.MeshStandardMaterial({ color: 0x0e0e0f, roughness: 1 });
    for (const [x, z] of [[L * 0.32, W / 2], [L * 0.32, -W / 2], [-L * 0.3, W / 2], [-L * 0.3, -W / 2]]) {
      const arch = new T.Mesh(new T.CylinderGeometry(1.55, 1.55, 0.3, 24), archMat);
      arch.rotation.x = Math.PI / 2;
      arch.position.set(x, 1.3, z + (z > 0 ? 0.2 : -0.2));
      b.add(arch);
    }
    // The cabin bubble and the single seat's canopy.
    // The canopy, hinged at its front edge so it can open.
    const hinge = new T.Group();
    hinge.position.set(-L * 0.12 + 3.0, 3.3, SEAT_Z);
    const canopy = new T.Mesh(new T.SphereGeometry(1.9, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), glass);
    canopy.scale.set(1.6, 0.7, 1.05);
    canopy.position.set(-3.0, 0.05, 0);
    canopy.castShadow = true;
    hinge.add(canopy);
    b.add(hinge);
    if (kind === 'live') this.canopy = hinge;
    // Wheels.
    const wheels = [];
    for (const [x, z] of [[L * 0.32, W / 2], [L * 0.32, -W / 2], [-L * 0.3, W / 2], [-L * 0.3, -W / 2]]) {
      const w = new T.Group();
      const tyre = new T.Mesh(new T.CylinderGeometry(1.25, 1.25, 0.9, 24), rubber);
      tyre.rotation.x = Math.PI / 2;
      const disc = new T.Mesh(new T.CylinderGeometry(0.82, 0.82, 0.3, 16), rubber);
      disc.rotation.x = Math.PI / 2;
      w.add(tyre, disc);
      for (let k = 0; k < 5; k++) {
        const spoke = new T.Mesh(new T.BoxGeometry(0.22, 1.5, 0.12), rim);
        spoke.rotation.z = (k / 5) * Math.PI * 2;
        spoke.position.z = (z > 0 ? 1 : -1) * 0.38;
        w.add(spoke);
      }
      const hub = new T.Mesh(new T.CylinderGeometry(0.22, 0.22, 1.0, 10), rim);
      hub.rotation.x = Math.PI / 2;
      w.add(hub);
      w.position.set(x, 1.25, z);
      tyre.castShadow = true;
      g.add(w);
      wheels.push(w);
    }
    // Thrusters: an array under the floor, and four at the corners.
    const nozzle = new T.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.4, metalness: 0.8 });
    const nozzles = [];
    for (const x of [-L * 0.2, 0, L * 0.2]) {
      const n = new T.Mesh(new T.CylinderGeometry(0.35, 0.5, 0.5, 12), nozzle);
      n.position.set(x, 0.3, 0);
      b.add(n);
      nozzles.push(n);
    }
    const corners = [];
    for (const [x, z] of [[L * 0.42, W * 0.35], [L * 0.42, -W * 0.35], [-L * 0.45, W * 0.35], [-L * 0.45, -W * 0.35]]) {
      const n = new T.Mesh(new T.CylinderGeometry(0.18, 0.24, 0.4, 10), nozzle);
      n.position.set(x, 0.8, z);
      b.add(n);
      corners.push(n);
    }
    // Headlights, on (off on a wreck).
    if (kind !== 'wreck') {
      const lamp = new T.MeshBasicMaterial({ color: 0xfff6e0 });
      for (const z of [-W * 0.33, W * 0.33]) {
        const l = new T.Mesh(new T.BoxGeometry(0.2, 0.35, 1.4), lamp);
        l.position.set(L / 2 + 0.05, 1.6, z);
        b.add(l);
      }
    }
    // A thin light bar across the tail, as cars have now.
    if (kind !== 'wreck') {
      const tail = new T.Mesh(new T.BoxGeometry(0.15, 0.18, W * 0.8), new T.MeshBasicMaterial({ color: 0xff2a1a }));
      tail.position.set(-L / 2 - 0.1, 2.2, 0);
      b.add(tail);
    }
    // The driver, seated under the canopy, the arm toward the camera out
    // on the sill, as in the photographs from 2018.
    if (kind === 'live') {
      // The gas itself: a faint cone under each nozzle, scaled by thrust.
      const jet = new T.MeshBasicMaterial({ color: 0xcfe2ff, transparent: true, opacity: 0.1, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide });
      this.jets = [];
      for (const n of nozzles) {
        const cone = new T.Mesh(new T.ConeGeometry(1.3, 1, 14, 1, true), jet);
        cone.geometry.translate(0, -0.5, 0);
        cone.position.copy(n.position);
        cone.position.y -= 0.2;
        b.add(cone);
        this.jets.push(cone);
      }
      const rider = new Astronaut();
      rider.group.position.set(-L * 0.12 - 0.3, 0.75, SEAT_Z);
      rider.group.scale.setScalar(0.92);
      rider.update(0, 'seated');
      b.add(rider.group);
      this.rider = rider;
      this.body = b;
      this.wheels = wheels;
      this.nozzles = nozzles;
      this.corners = corners;
    }
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

  /** Where the car's reference point is, from the state, interpolated
   * between the program's steps with its own velocities. */
  poseFrom(state, now) {
    // Wall time since the step, in machine seconds (the page may run the
    // machine slower or faster than real time).
    const dt = Math.min(0.25, ((now - this.lastStateWall) / 1000) * (this.rate || 1));
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
    // A new game: the program has run INIT again (TIME starts over).
    if (this.lastState && state.time < this.lastState.time) this.reset();
    this.setScale(this.closeUp(state) ? 0.25 : 1);
    if (state !== this.lastState || state.t !== this.lastT) {
      if (!this.lastState || state.hordis !== this.lastState.hordis || state.verdis !== this.lastState.verdis) this.lastStateWall = now;
      this.lastState = { ...state };
      this.lastT = state.t;
    }
    const target = this.poseFrom(this.lastState, now);
    // Turning: the program clears TURN as soon as it has used it, so read
    // the turn off the angle itself and hold it long enough to see.
    if (this.prevAngle !== undefined && target.a !== this.prevAngle) {
      let d = target.a - this.prevAngle;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      this.turnDir = Math.sign(d);
      this.turnUntil = now + 250;
    }
    this.prevAngle = target.a;
    const turning = this.turnUntil > now ? this.turnDir : 0;
    this.puffing = turning !== 0 && !this.exploded;
    const k = this.first ? 1 : 1 - Math.exp(-dt / 0.06);
    this.pose.x += (target.x - this.pose.x) * k;
    this.pose.y += (target.y - this.pose.y) * k;
    // Angles: the program's are degrees clockwise from up.
    let da = target.a - this.pose.a;
    while (da > 180) da -= 360;
    while (da < -180) da += 360;
    this.pose.a += da * (this.first ? 1 : 1 - Math.exp(-dt / 0.12));

    const ground = this.height(this.pose.x);
    const alt = Math.max(0, this.pose.y - ground);
    // The car: its wheels at VERDIS, pitched by the angle (clockwise
    // positive in the program, so nose down when thrusting to the right).
    const dist = this.camPos.distanceTo(this.camTarget) || 300;
    const scale = Math.max(1, dist / 500);
    this.car.position.set(this.pose.x, this.pose.y, 0);
    this.car.rotation.set(0, 0, -T.MathUtils.degToRad(this.pose.a));
    this.car.scale.setScalar(scale);
    this.car.visible = !this.exploded;

    // Camera: distance follows altitude; looks at a point between the car
    // and the ground under it, from in front and a little above. Far out,
    // it stands well back and higher, so the whole valley reads.
    const close = this.scaleY < 1;
    // Far enough back that the car and the ground under it both fit the
    // frame, whatever its shape (phones are tall and narrow).
    const fit = (alt + 30) / (2 * 1.15 * Math.tan(T.MathUtils.degToRad(this.camera.fov / 2)));
    const d = close ? T.MathUtils.clamp(Math.max(alt * 0.6 + 55, fit), 55, 900) : T.MathUtils.clamp(Math.max(alt * 1.9 + 900, fit), 1200, 36000);
    const look = new T.Vector3(this.pose.x + (state.horvel / 10) * 0.6, ground + alt * (close ? 0.5 : 0.6) + 6, 0);
    let d2 = d;
    if (this.walking && this.driverX !== undefined) {
      // Both the car and the driver in the frame while he walks.
      // Follow the driver; the car comes into the frame as he nears it.
      const gap = Math.abs(this.driverX - this.pose.x);
      const near = T.MathUtils.smoothstep(gap, 10, 30);
      look.x = T.MathUtils.lerp((this.pose.x + this.driverX) / 2, this.driverX, near);
      look.y = ground + 6.5;
      d2 = Math.max(42, T.MathUtils.lerp(gap * 0.9 + 40, 58, near));
    }
    // Low elevation, as the 1973 side view was: the needle mountains read
    // as a skyline, and the depth behind them is the bonus.
    const up = close ? 0.14 : T.MathUtils.lerp(0.06, 0.1, Math.min(1, d / 20000));
    const cam = new T.Vector3(look.x + d2 * 0.1, look.y + d2 * up, look.z + d2 * 0.95);
    // Keep the camera above the ground in front.
    cam.y = Math.max(cam.y, this.heightAt(cam.x, cam.z) + 25);
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
    this.camera.near = Math.max(0.5, d * 0.01);
    this.camera.far = 400000;
    this.camera.updateProjectionMatrix();

    // The sun's shadow camera follows the car.
    const sunR = T.MathUtils.clamp(alt * 1.2 + 200, 120, 4000);
    this.sunTarget.position.set(this.pose.x, ground, 0);
    this.sun.position.copy(this.sunTarget.position).addScaledVector(this.sunDir, sunR * 3);
    const sc = this.sun.shadow.camera;
    sc.left = -sunR; sc.right = sunR; sc.top = sunR; sc.bottom = -sunR;
    sc.near = sunR; sc.far = sunR * 6;
    sc.updateProjectionMatrix();

    // Exhaust: cold gas from the floor array in proportion to thrust.
    const thrust = this.exploded ? 0 : Math.max(0, state.thrust);
    const maxThrust = this.maxThrust || 1;
    if (this.jets) {
      const f = thrust / maxThrust;
      for (const [i, jet] of this.jets.entries()) {
        jet.visible = f > 0 && alt > 0;
        const flick = 0.85 + 0.3 * Math.sin(now * 0.021 + i * 2.1) * Math.sin(now * 0.0137 + i);
        jet.scale.set(0.6 + 0.6 * f, (4 + 14 * f) * flick, 0.6 + 0.6 * f);
        jet.material.opacity = 0.05 + 0.14 * f;
      }
    }
    if (thrust > 0 && alt > 0) {
      const rate = (0.3 + 0.7 * (thrust / maxThrust)) * 2400 * dt;
      const q = new T.Quaternion().setFromEuler(this.car.rotation);
      const down = new T.Vector3(0, -1, 0).applyQuaternion(q);
      for (const n of this.nozzles) {
        const p = n.getWorldPosition(new T.Vector3());
        this.plume.emit(p, down, rate / this.nozzles.length, scale, thrust / maxThrust);
      }
      // Dust where the gas reaches the ground, when the program raises it.
      if (state.dust !== 0 && alt < 160) {
        const foot = new T.Vector3(this.pose.x + down.x * alt, this.height(this.pose.x + down.x * alt), down.z * alt);
        const near = 1 - alt / 160;
        this.dust.emit(foot, near * near * (thrust / maxThrust) * 1200 * dt, scale);
      }
    }
    // Attitude puffs when turning: the pair that lifts its end fires down.
    if (!this.exploded && turning !== 0) {
      const q = new T.Quaternion().setFromEuler(this.car.rotation);
      const down = new T.Vector3(0, -1, 0).applyQuaternion(q);
      // Clockwise (nose down): the rear pair lifts the tail.
      const pair = turning > 0 ? [this.corners[2], this.corners[3]] : [this.corners[0], this.corners[1]];
      for (const c of pair) {
        const p = c.getWorldPosition(new T.Vector3());
        this.plume.emit(p, down, 140 * dt, scale * 0.6, 0.45);
      }
    }
    this.plume.step(dt);
    this.dust.step(dt, (x) => this.height(x));
    this.smoke.step(dt, (x) => this.height(x));

    // Touchdown: the body settles on its springs and comes back.
    if (this.prevRadary > 0 && state.radary <= 0 && state.verdis < 450 && !this.exploded) {
      this.squat = { t: 0, a: Math.min(0.45, 0.08 + Math.abs(this.lastState.vervel) / 400) };
    }
    this.prevRadary = state.radary;
    if (this.squat) {
      this.squat.t += dt;
      const q = this.squat;
      this.body.position.y = -q.a * Math.exp(-q.t / 0.35) * Math.cos(q.t * 11);
      if (q.t > 2) {
        this.squat = null;
        this.body.position.y = 0;
      }
    }
    // A crash: the program stops drawing the ship (SHIPDP cleared) once it
    // has drawn it at least once this game.
    if (state.shipdp !== 0) this.shipSeen = true;
    if (this.shipSeen && state.shipdp === 0 && !this.exploded) this.explode();
    if (this.debris) this.debris.step(dt, (x) => this.height(x));
    if (this.flashAt) {
      const f = (now - this.flashAt) / 1000;
      this.flash.position.copy(this.car.position).add(new T.Vector3(0, 6, 0));
      this.flash.intensity = f < 0.6 ? 4000 * Math.exp(-f * 7) : 0;
      if (f > 1) this.flashAt = 0;
    }
    if (this.rereadAt && this.rereadAt.length && now >= this.rereadAt[0]) {
      this.rereadAt.shift();
      this.rereadTerrain();
    }
    // The diner, if the program says it has been destroyed.
    if (this.diner) this.dinerStands(!!(state.diner & 1));

    this.driverUpdate(state, now, dt);
    // The flag he plants, where the program puts it.
    const flagUp = state.flagx !== 0 && state.verdis < 450 && !this.exploded;
    this.flag.visible = flagUp;
    if (flagUp) {
      const fx = state.lefeet + (state.flagx * 2) / 3;
      this.flag.position.set(fx, this.height(fx), 0);
    }

    this.first = false;
    this.wheelSpin += (state.horvel / 10) * dt / 1.25;
    for (const w of this.wheels) w.rotation.z = -this.wheelSpin;
  }

  render() {
    if (!this.terrain) return;
    this.resize();
    this.tubeTexture.needsUpdate = true;
    this.composer.render();
  }

  explode() {
    this.exploded = true;
    // The program digs a crater as it explodes (ALTER): read it soon.
    this.rereadAt = [performance.now() + 100, performance.now() + 1200];
    this.debris = new Debris(this.scene, this.car.position.clone(), this.car.rotation.clone(), this.car.scale.x);
    const burst = new T.Vector3(0, 1, 0);
    this.plume.emit(this.car.position, burst, 600, this.car.scale.x * 3, 1);
    this.dust.emit(new T.Vector3(this.car.position.x, this.height(this.car.position.x), 0), 500, this.car.scale.x * 2);
    this.smoke.emit(this.car.position.clone(), 300, this.car.scale.x * 4);
    this.flashAt = performance.now();
  }

  /** The diner stands, or lies flattened by a car. */
  dinerStands(up) {
    if (this.dinerUp === up) return;
    this.dinerUp = up;
    this.diner.scale.y = up ? 1 : 0.35;
    for (const [i, sc] of this.screens.entries()) {
      sc.parent.rotation.z = up ? 0 : (i ? -1 : 1) * 0.6;
    }
    if (!up) {
      const at = this.diner.position.clone();
      at.y += 10;
      this.dust.emit(at, 400, 3);
    }
  }

  /** A new game: the car is whole again. */
  /**
   * The driver, outside the car. The program shows its man by pointing
   * DUSTON at the MAN display list; MANX is his position in raster units
   * from the close-up's left edge, two thirds of a foot each. Around that
   * we add what the display could not: the canopy opening, the climb out,
   * a lope in a sixth of a g, a wave at the counter, the flag planted and
   * saluted, and the climb back in before the car leaves.
   */
  driverUpdate(state, now, dt) {
    const shown = state.dust === this.symbols.MAN && state.verdis < 450 && !this.exploded;
    const mx = state.lefeet + (state.manx * 2) / 3;
    const w = this.walker;
    const o = this.out;
    const carX = this.pose.x;
    const seatWorld = () => {
      const v = new T.Vector3();
      this.rider.group.getWorldPosition(v);
      return v;
    };
    if (shown && !o) {
      // He appears: the canopy opens and he climbs out, toward the camera.
      this.out = { phase: 'climb', t: 0, x: mx, lastX: mx, speed: 0, idleSince: now, waved: false, saluted: false, plantAt: 0 };
      w.group.visible = true;
      w.face(1);
    }
    if (!shown && o && o.phase !== 'in' && o.phase !== 'done') {
      // The program has taken him back into the ship (or the game ended).
      if (Math.abs(o.x - carX) < 12 && state.verdis < 450) {
        o.phase = 'in';
        o.t = 0;
      } else {
        this.out = null;
        w.group.visible = false;
      }
    }
    if (!this.out) {
      if (this.rider) this.rider.group.visible = true;
      if (this.canopy) this.canopy.rotation.z = T.MathUtils.lerp(this.canopy.rotation.z, 0, 1 - Math.exp(-dt / 0.25));
      this.walking = false;
      return;
    }
    const d = this.out;
    const ground = (x) => this.height(x);
    const WALK_Z = CAR_WIDTH / 2 + 1.8;
    if (d.phase === 'climb') {
      d.t = Math.min(1, d.t + dt / 1.6);
      this.rider.group.visible = false;
      this.canopy.rotation.z = -1.05 * T.MathUtils.smoothstep(d.t, 0, 0.3);
      const seat = seatWorld();
      const k = T.MathUtils.smoothstep(d.t, 0.35, 1);
      const px = T.MathUtils.lerp(seat.x, carX - 1.0, k);
      const pz = T.MathUtils.lerp(seat.z, WALK_Z, k);
      const py = T.MathUtils.lerp(seat.y - 0.75, ground(px), T.MathUtils.smoothstep(d.t, 0.55, 1));
      w.group.position.set(px, py, pz);
      w.update(dt, 'climb', d.t);
      d.x = px;
      if (d.t >= 1) {
        d.phase = 'walk';
        d.idleSince = now;
      }
      this.walking = true;
      this.driverX = d.x;
      return;
    }
    if (d.phase === 'in') {
      // Back into the seat: the climb in reverse, canopy closing after.
      d.t = Math.min(1, d.t + dt / 1.4);
      const seat = seatWorld();
      const k = T.MathUtils.smoothstep(1 - d.t, 0.35, 1);
      const px = T.MathUtils.lerp(seat.x, carX - 1.0, k);
      const pz = T.MathUtils.lerp(seat.z, WALK_Z, k);
      const py = T.MathUtils.lerp(seat.y - 0.75, ground(px), T.MathUtils.smoothstep(1 - d.t, 0.55, 1));
      w.group.position.set(px, py, pz);
      w.update(dt, 'climb', 1 - d.t);
      this.canopy.rotation.z = -1.05 * (1 - T.MathUtils.smoothstep(d.t, 0.75, 1));
      if (d.t >= 1) {
        d.phase = 'done';
        w.group.visible = false;
        this.rider.group.visible = true;
        this.rider.update(0, 'seated');
      }
      this.walking = true;
      this.driverX = d.x;
      return;
    }
    if (d.phase === 'done') {
      this.rider.group.visible = true;
      this.canopy.rotation.z = T.MathUtils.lerp(this.canopy.rotation.z, 0, 1 - Math.exp(-dt / 0.25));
      if (!shown && state.verdis > 450) this.out = null;
      this.walking = false;
      return;
    }
    // Walking, at the program's position, smoothed.
    const target = mx;
    const kx = 1 - Math.exp(-dt / 0.12);
    const nx = d.x + (target - d.x) * kx;
    const vx = (nx - d.x) / Math.max(1e-3, dt);
    d.speed = d.speed + (vx - d.speed) * (1 - Math.exp(-dt / 0.15));
    d.x = nx;
    const moving = Math.abs(d.speed) > 0.8;
    if (moving) {
      w.face(Math.sign(d.speed));
      d.idleSince = now;
    }
    w.group.position.set(d.x, ground(d.x), WALK_Z);
    // What he is doing: at the counter he waves; by a fresh flag he plants
    // and salutes; otherwise he lopes or stands.
    const order = this.messageIs(state, 'ORDER');
    const flagFresh = state.flagx !== 0 && d.plantAt === 0;
    if (flagFresh) d.plantAt = now;
    const sincePlant = d.plantAt ? (now - d.plantAt) / 1000 : -1;
    if (moving) {
      w.update(dt, 'walk', d.speed);
    } else if (sincePlant >= 0 && sincePlant < 1.2) {
      w.face(1);
      w.update(dt, 'plant', sincePlant / 1.0);
    } else if (sincePlant >= 1.2 && sincePlant < 4.5) {
      w.face(1);
      w.update(dt, 'salute');
    } else if (order && !moving) {
      w.update(dt, 'wave');
    } else {
      w.update(dt, 'idle');
    }
    // When he comes back to the car, start the climb before the program
    // hides him, so the two happen together.
    if (d.phase === 'walk' && d.cameBack === undefined && Math.abs(d.x - carX) > 20) d.cameBack = false;
    if (d.phase === 'walk' && d.cameBack === false && Math.abs(d.x - carX) < 3.5 && !moving) {
      d.phase = 'in';
      d.t = 0;
    }
    this.walking = true;
    this.driverX = d.x;
  }

  /** Whether the program's message pointer names this message. */
  messageIs(state, name) {
    return state.sysmes !== 0 && this.symbols[name] === state.sysmes;
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

  reset() {
    if (this.peek) {
      this.rereadTerrain();
      this.buildLeftovers();
    }
    this.exploded = false;
    this.shipSeen = false;
    this.walking = false;
    this.driverX = undefined;
    this.out = null;
    if (this.walker) this.walker.group.visible = false;
    if (this.rider) this.rider.group.visible = true;
    if (this.canopy) this.canopy.rotation.z = 0;
    if (this.debris) {
      this.debris.dispose();
      this.debris = null;
    }
    this.first = true;
  }

  wheelSpin = 0;
}

/** Cold-gas exhaust: white, fast, expanding, gone in a third of a second. */
class Plume {
  constructor(scene, n) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.age = new Float32Array(n);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.next = 0;
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(this.pos, 3).setUsage(T.DynamicDrawUsage));
    g.setAttribute('aSize', new T.BufferAttribute(this.size, 1).setUsage(T.DynamicDrawUsage));
    g.setAttribute('aAlpha', new T.BufferAttribute(this.alpha, 1).setUsage(T.DynamicDrawUsage));
    const m = new T.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: T.AdditiveBlending,
      uniforms: { color: { value: new T.Color(0.9, 0.95, 1.0) }, pr: { value: 1 } },
      vertexShader: `attribute float aSize; attribute float aAlpha; varying float vA; uniform float pr;
        void main(){ vA = aAlpha; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * pr * 900.0 / max(1.0, -mv.z); }`,
      fragmentShader: `uniform vec3 color; varying float vA;
        void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d) * 2.0; if (r > 1.0) discard;
        float a = (1.0 - r * r); a *= a; gl_FragColor = vec4(color * a * vA, a * vA); }`,
    });
    this.points = new T.Points(g, m);
    this.points.frustumCulled = false;
    this.material = m;
    scene.add(this.points);
    this.live = 0;
  }

  emit(p, dir, count, scale, strength) {
    const n = Math.floor(count + Math.random());
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.n;
      const spread = 0.35;
      const sx = (Math.random() - 0.5) * spread, sy = (Math.random() - 0.5) * spread, sz = (Math.random() - 0.5) * spread;
      // Cold gas leaves fast whatever the throttle; the throttle sets how much.
      const speed = (150 + 100 * Math.random()) * (0.5 + 0.5 * strength) * scale;
      this.pos[i * 3] = p.x + (Math.random() - 0.5) * 0.6 * scale;
      this.pos[i * 3 + 1] = p.y + (Math.random() - 0.5) * 0.6 * scale;
      this.pos[i * 3 + 2] = p.z + (Math.random() - 0.5) * 0.6 * scale;
      this.vel[i * 3] = (dir.x + sx) * speed;
      this.vel[i * 3 + 1] = (dir.y + sy) * speed;
      this.vel[i * 3 + 2] = (dir.z + sz) * speed;
      this.life[i] = 0.25 + 0.2 * Math.random();
      this.age[i] = 0;
      this.size[i] = (1.0 + 1.0 * Math.random()) * scale;
      this.alpha[i] = 0.6 * strength;
    }
  }

  step(dt) {
    const pos = this.pos, vel = this.vel;
    for (let i = 0; i < this.n; i++) {
      if (this.age[i] >= this.life[i]) {
        this.alpha[i] = 0;
        continue;
      }
      this.age[i] += dt;
      const f = this.age[i] / this.life[i];
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      // Gas expands and thins.
      this.size[i] *= 1 + 3.5 * dt;
      this.alpha[i] = (1 - f) * (1 - f) * 0.6;
      vel[i * 3] *= 1 - 0.8 * dt;
      vel[i * 3 + 1] *= 1 - 0.8 * dt;
      vel[i * 3 + 2] *= 1 - 0.8 * dt;
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
    this.material.uniforms.pr.value = Math.min(window.devicePixelRatio || 1, 2);
  }
}

/** Regolith thrown up by the gas: grey, slower, on a ballistic arc at a
 * sixth of a g, settling back. */
class Dust extends Plume {
  constructor(scene, n) {
    super(scene, n);
    this.material.uniforms.color.value = new T.Color(0.55, 0.52, 0.48);
    this.material.blending = T.NormalBlending;
  }

  emit(p, count, scale) {
    const n = Math.floor(count + Math.random());
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.n;
      // Regolith goes out more than up: a low skirt of dust.
      const ang = Math.random() * Math.PI * 2;
      const r = (12 + 40 * Math.random()) * Math.sqrt(scale);
      this.pos[i * 3] = p.x + (Math.random() - 0.5) * 6 * scale;
      this.pos[i * 3 + 1] = p.y + 0.3;
      this.pos[i * 3 + 2] = p.z + (Math.random() - 0.5) * 6 * scale;
      this.vel[i * 3] = Math.cos(ang) * r;
      this.vel[i * 3 + 1] = 3 + 9 * Math.random();
      this.vel[i * 3 + 2] = Math.sin(ang) * r * 0.6;
      this.life[i] = 1.2 + 1.5 * Math.random();
      this.age[i] = 0;
      this.size[i] = (0.6 + 0.9 * Math.random()) * scale;
      this.alpha[i] = 0.35;
    }
  }

  step(dt, ground) {
    const pos = this.pos, vel = this.vel;
    for (let i = 0; i < this.n; i++) {
      if (this.age[i] >= this.life[i]) {
        this.alpha[i] = 0;
        continue;
      }
      this.age[i] += dt;
      const f = this.age[i] / this.life[i];
      vel[i * 3 + 1] -= 5.3 * dt; // the Moon's g, ft/s^2
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      const g = ground(pos[i * 3]);
      if (pos[i * 3 + 1] < g) {
        pos[i * 3 + 1] = g;
        vel[i * 3 + 1] = 0;
        vel[i * 3] *= 0.5;
        vel[i * 3 + 2] *= 0.5;
      }
      this.size[i] *= 1 + 0.3 * dt;
      this.alpha[i] = 0.35 * (1 - f);
    }
    const geo = this.points.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aSize.needsUpdate = true;
    geo.attributes.aAlpha.needsUpdate = true;
  }
}

/** What is left after a crash: pieces of the car, tumbling and settling. */
class Debris {
  constructor(scene, at, rot, scale) {
    this.scene = scene;
    this.group = new T.Group();
    this.pieces = [];
    const mat = new T.MeshStandardMaterial({ color: 0xd8d8d2, roughness: 0.6, metalness: 0.2 });
    const dark = new T.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 });
    for (let i = 0; i < 14; i++) {
      const wheel = i < 4;
      const m = wheel
        ? new T.Mesh(new T.CylinderGeometry(1.25, 1.25, 0.9, 16), dark)
        : new T.Mesh(new T.BoxGeometry(1 + 3 * Math.random(), 0.4 + 0.8 * Math.random(), 1 + 2 * Math.random()), mat);
      if (wheel) m.rotation.x = Math.PI / 2;
      m.position.copy(at);
      m.scale.setScalar(scale);
      m.castShadow = true;
      this.group.add(m);
      const ang = Math.random() * Math.PI * 2;
      this.pieces.push({
        m,
        v: new T.Vector3(Math.cos(ang) * (15 + 40 * Math.random()), 20 + 45 * Math.random(), Math.sin(ang) * (10 + 25 * Math.random())).multiplyScalar(scale),
        w: new T.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(12),
        down: false,
      });
    }
    scene.add(this.group);
  }

  step(dt, ground) {
    for (const p of this.pieces) {
      if (p.down) continue;
      p.v.y -= 5.3 * dt;
      p.m.position.addScaledVector(p.v, dt);
      p.m.rotation.x += p.w.x * dt;
      p.m.rotation.y += p.w.y * dt;
      p.m.rotation.z += p.w.z * dt;
      const g = ground(p.m.position.x);
      if (p.m.position.y < g + 0.6 * p.m.scale.x) {
        p.m.position.y = g + 0.6 * p.m.scale.x;
        if (Math.abs(p.v.y) < 6) {
          p.down = true;
        } else {
          p.v.y = -p.v.y * 0.3;
          p.v.x *= 0.6;
          p.v.z *= 0.6;
          p.w.multiplyScalar(0.5);
        }
      }
    }
  }

  dispose() {
    this.scene.remove(this.group);
  }
}
