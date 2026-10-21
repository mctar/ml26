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
import { Car, CAR } from './world/car.js';
import { Astronaut } from './world/astronaut.js';
import { Driver, WINDOW } from './world/driver.js';
import { Props, Flag } from './world/props.js';
import { Exhaust } from './world/plume.js';
import { DustSheet, rng } from './world/ballistic.js';
import { Crash, CrashKit } from './world/debris.js';
import { Topple, carBody, poseCar, COM } from './world/topple.js';
import { STEP } from './world/rigid.js';
import { Land, landRings, ringIndex, ringChunks, landSurfaces } from './world/land.js';
import { Prints } from './world/prints.js';
import { makeEnvironment } from './world/env.js';
import { hash } from './world/shape.js';

const ease = (x) => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};

/** Unit vector a turned toward unit vector b by fraction k. */
function slerpDir(a, b, k) {
  const cos = Math.min(1, Math.max(-1, a.dot(b)));
  const ang = Math.acos(cos);
  if (ang < 1e-5) return a.clone();
  const s = Math.sin(ang);
  return a.clone().multiplyScalar(Math.sin((1 - k) * ang) / s).addScaledVector(b, Math.sin(k * ang) / s);
}

const TERRAIN_N = 911; // words in TERAIN
const TERRAIN_X0 = -22400; // feet at index 0
const TERRAIN_DX = 32; // feet per index
// The diner's lot: a slab, its extent about the DINER feature.
const PAD = { x0: -55, x1: 55, z0: -37, z1: 33 };
/** The lot's edge: a chamfer, so that its kerb is stepped onto, not up a
 * wall: it drops this much (ft) over this width. */
const KERB = { drop: 1.0, width: 1.5 };

/** The lot's slab: a level top, chamfered edges, and straight sides down
 * to `depth` below the top. Its top is at y = 0. */
function padGeometry(depth) {
  const { x0, x1, z0, z1 } = PAD, c = KERB.width, k = KERB.drop;
  const top = [[x0 + c, z0 + c], [x1 - c, z0 + c], [x1 - c, z1 - c], [x0 + c, z1 - c]];
  const rim = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
  const pos = [];
  const quad = (a, b, c2, d) => pos.push(...a, ...b, ...c2, ...a, ...c2, ...d);
  const at = ([x, z], y) => [x, y, z];
  // Wound so the faces look up and out.
  quad(at(top[0], 0), at(top[3], 0), at(top[2], 0), at(top[1], 0));
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    quad(at(top[i], 0), at(top[j], 0), at(rim[j], -k), at(rim[i], -k));
    quad(at(rim[i], -k), at(rim[j], -k), at(rim[j], -Math.max(depth, k + 0.1)), at(rim[i], -Math.max(depth, k + 0.1)));
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
// The program's verdicts on a landing that leaves the ship standing.
const LANDINGS = ['GREATM', 'GOODM', 'ROUGHM', 'CRIPM'];

/** Burness's lander, from the DESIGN table: moves (M) and lines (L) in
 * raster units about the ship's centre, with the intensity level (I). */
const LANDER_1973 = [['I', 4], ['M', -6, 0], ['L', -14, 8], ['L', -14, 20], ['L', -6, 29], ['L', 6, 29], ['L', 14, 20], ['L', 14, 8], ['L', 6, 0], ['L', -6, 0], ['M', -17, 0], ['L', -17, -16], ['L', 17, -16], ['L', 17, 0], ['L', -17, 0], ['I', 3], ['L', -32, -24], ['M', 17, 0], ['L', 32, -24], ['I', 1], ['M', -17, -14], ['L', -28, -18], ['M', 17, -14], ['L', 28, -18], ['I', 4], ['M', 36, -24], ['L', 28, -24], ['M', -28, -24], ['L', -36, -24], ['M', -3, -16], ['L', -7, -21], ['L', 7, -21], ['L', 3, -16]];

export const FEATURE = { NONE: 0, OLD_SHIP: 1, FLAG: 2, WRECK_LEFT: 3, WRECK_RIGHT: 4, ROCK: 5, DINER_SIDE: 6, DINER: 7 };

/** A car left on the ground, as a solid: the ellipsoid of its hull. */
function carSolid(car) {
  car.group.updateMatrixWorld(true);
  const box = new T.Box3();
  for (const p of car.hull) box.expandByPoint(p.clone().applyMatrix4(car.body.matrixWorld));
  const c = box.getCenter(new T.Vector3()), h = box.getSize(new T.Vector3()).multiplyScalar(0.5);
  return { x: c.x, y: c.y, z: c.z, hx: h.x * 1.05, hy: h.y, hz: h.z * 1.05 };
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
    this.renderer.shadowMap.type = T.PCFShadowMap;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.scene = new T.Scene();
    this.scene.background = new T.Color(0x000000);
    this.camera = new T.PerspectiveCamera(42, 4 / 3, 1, 1500000);
    this.camTarget = new T.Vector3();
    this.camPos = new T.Vector3();
    this.first = true;
    // The opening, set by the page each frame: null, or { t, k }: seconds
    // into the shot, and how far it has drawn back into the flight's own.
    this.opening = null;
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
    this.crashKit = new CrashKit(this.scene, this.car);
    this.blasts = [];
    this.exploded = false; // the car has come apart
    this.crash = null; // from the program's crash until a new game
    this.topple = null; // the car going over
    this.events = []; // for the sound: blows, the burst
    this.wreckPoses = new Map(); // terrain index: how a tipped car came to lie
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
    // From the front left, sixteen degrees up: about where it stood for the
    // Apollo landings, which were timed for long shadows to judge by.
    const el = T.MathUtils.degToRad(16), az = Math.atan2(0.75, -0.45);
    this.sunDir = new T.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
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
      const r = 1200000;
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
    // The Earth, far and high to the left: NASA's Blue Marble with its
    // clouds, glossy where there is open sea, in a thin shell of air lit
    // on the side the sun is on. It is lit by the same sun as the ground.
    const load = (f, srgb) => {
      const t = new T.TextureLoader().load(new URL(`./world/${f}`, import.meta.url).href, () => (earth.visible = true));
      if (srgb) t.colorSpace = T.SRGBColorSpace;
      t.anisotropy = 4;
      return t;
    };
    const ER = 2600;
    const earth = new T.Mesh(
      new T.SphereGeometry(ER, 96, 64),
      new T.MeshStandardMaterial({ map: load('earth.jpg', true), roughnessMap: load('earth_rough.jpg', false), roughness: 1, metalness: 0.0, emissive: 0x03050a, emissiveIntensity: 1 }),
    );
    earth.visible = false; // until its picture comes
    // The air: a halo just outside the disc, from how close each line of
    // sight passes to the planet (drawn behind it, so inside the disc the
    // planet hides it whatever the depth buffer's precision), and a haze
    // over the disc's edge in the planet's own shader.
    const air = new T.Mesh(
      new T.SphereGeometry(ER * 1.04, 96, 64),
      new T.ShaderMaterial({
        uniforms: { uSun: { value: this.sunDir }, uR: { value: ER }, uR2: { value: ER * 1.04 } },
        vertexShader: `varying vec3 vW; varying vec3 vC;
void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vC = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
        fragmentShader: `uniform vec3 uSun; uniform float uR; uniform float uR2; varying vec3 vW; varying vec3 vC;
void main() {
  vec3 d = normalize(vW - cameraPosition);
  vec3 oc = vC - cameraPosition;
  vec3 near = cameraPosition + d * dot(oc, d);
  float b = length(near - vC);
  float a = clamp((uR2 - b) / (uR2 - uR), 0.0, 1.0);
  a = a * a * a;
  float lit = smoothstep(-0.2, 0.5, dot(normalize(near - vC), normalize(uSun)));
  gl_FragColor = vec4(vec3(0.3, 0.55, 1.0) * a * lit * 0.8, 1.0);
}`,
        side: T.BackSide,
        blending: T.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    earth.material.onBeforeCompile = (sh) => {
      sh.uniforms.uSunE = { value: this.sunDir };
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uSunE;').replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
{
  vec3 nW = normalize(inverseTransformDirection(normal, viewMatrix));
  float edge = 1.0 - saturate(dot(normal, normalize(vViewPosition)));
  float lit = smoothstep(-0.2, 0.5, dot(nW, normalize(uSunE)));
  gl_FragColor.rgb += vec3(0.25, 0.45, 0.9) * pow(edge, 3.0) * lit * 0.55;
}`,
      );
    };
    earth.add(air);
    earth.position.set(-42000, 52000, -118000);
    earth.rotation.y = 4.8; // Africa and Europe toward the Moon
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
    this.land = new Land(h, TERRAIN_X0, TERRAIN_DX);
    this.land.setScale(this.scaleY);
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
        // A tipped car lies as it came to rest; one from before this page
        // (a replay's earlier games are all on this page) as a car lies
        // on its roof.
        const lay = f === FEATURE.OLD_SHIP ? null : this.wreckPoses.get(i) || this.wreckPoses.get(i - 1) || this.wreckPoses.get(i + 1);
        const car = new Car({ kind: f === FEATURE.OLD_SHIP ? 'parked' : 'tipped', env: this.env });
        car.setCanopy(f === FEATURE.OLD_SHIP ? 1 : 0);
        this.leftovers.add(car.group);
        this.leftoverAt.push({ kind: 'car', car, x, a: 0, lay, wreck: f !== FEATURE.OLD_SHIP });
      }
    }
    this.scene.add(this.leftovers);
    this.placeLeftovers();
  }

  placeLeftovers() {
    for (const l of this.leftoverAt || []) {
      if (l.kind === 'flag') l.o.position.set(l.x, this.groundAt(l.x, l.z) - 0.25, l.z);
      else if (l.wreck) this.layWreck(l);
      else l.car.place(l.x, this.height(l.x), l.a, (x) => this.groundAt(x, 0), 0);
      if (l.car) l.solid = carSolid(l.car);
    }
  }

  /** A tipped car where it came to rest; or, not having seen it go over,
   * upside down where the program keeps it, let fall into place. */
  layWreck(l) {
    const car = l.car;
    if (l.lay) {
      car.group.position.copy(l.lay.p);
      car.group.quaternion.copy(l.lay.q);
      // The ground there may have changed height with the close-up.
      if (l.lay.scaleY !== this.scaleY) car.group.position.y += this.height(l.lay.p.x) - l.lay.h;
      for (const [i, w] of car.wheels.entries()) {
        w.group.position.y = w.r + (l.lay.wheels ? l.lay.wheels[i] : -CAR.DROOP);
        w.spinner.rotation.z = i * 1.7;
      }
      car.group.updateMatrixWorld(true);
      return;
    }
    if (!l.settled || l.settled.scaleY !== this.scaleY) {
      const solid = (x, z) => this.groundAt(x, z);
      const body = carBody(car);
      const q = new T.Quaternion().setFromAxisAngle(new T.Vector3(1, 0, 0), Math.PI * 0.97);
      body.set(new T.Vector3(l.x, this.height(l.x) + 6, 0), q, new T.Vector3(), new T.Vector3());
      for (let i = 0; i < 6 / STEP && !body.asleep; i++) body.step(solid);
      l.settled = { scaleY: this.scaleY, x: body.x.clone(), q: body.q.clone() };
    }
    const b = { x: l.settled.x, q: l.settled.q };
    poseCar(car, b);
    for (const w of car.wheels) w.group.position.y = w.r - CAR.DROOP;
    car.group.updateMatrixWorld(true);
  }

  /**
   * The height of whatever is solid at (x, z): the ground, the boulders,
   * the diner's roof, cars left from earlier games. For things that fall
   * on them.
   */
  solidAt(x, z) {
    let h = this.groundAt(x, z);
    const near = this.rockCells && this.rockCells.get(Math.floor(x / 64));
    for (const r of near || []) {
      const dx = x - r.x, dz = z - r.z;
      if (Math.abs(dx) > r.reach || Math.abs(dz) > r.reach) continue;
      const lx = dx * r.c - dz * r.s, lz = dx * r.s + dz * r.c;
      const u = 1 - (lx / r.sx) ** 2 - (lz / r.sz) ** 2;
      if (u > 0) h = Math.max(h, r.y + r.sy * Math.sqrt(u));
    }
    if (this.diner && this.pad) {
      // The roof, and the wing over the stalls in front of it.
      const dx = Math.abs(x - this.diner.position.x), k = this.diner.scale.y;
      if (dx < 42 && z > -45 && z < 1) h = Math.max(h, this.pad.y + 14.35 * k);
      if (dx < 48 && z >= 1 && z < 27) h = Math.max(h, this.pad.y + 17.25 * k);
    }
    for (const l of this.leftoverAt || []) {
      const c = l.solid;
      if (!c) continue;
      const dx = (x - c.x) / c.hx, dz = (z - c.z) / c.hz;
      const u = 1 - dx * dx - dz * dz;
      if (u > 0) h = Math.max(h, c.y + c.hy * Math.sqrt(u));
    }
    return h;
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
      if (lx > p.x0 && lx < p.x1 && z > p.z0 && z < p.z1) {
        // Down the chamfer at the edge.
        const c = KERB.width;
        const out = Math.max(p.x0 + c - lx, lx - (p.x1 - c), p.z0 + c - z, z - (p.z1 - c), 0);
        return Math.max(h, this.pad.y - (out / c) * KERB.drop);
      }
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
    this.land.setScale(sy);
    this.fillTerrain();
    this.placeFeatures();
    this.placeLeftovers();
    this.prints.reground((x, z) => this.groundAt(x, z));
    this.prints.visible = sy < 1;
    this.first = true; // the camera cuts, as the 1973 display did
  }

  /** Height off the plane: Burness's profile along it, the country
   * round it from world/land.js. */
  heightAt(x, z) {
    return this.land.height(x, z);
  }

  buildTerrain() {
    // Rings of mesh round the line, finest on it (world/land.js); their
    // heights are worked out off the page's thread, for both of the
    // program's scales, and swapped in as they come.
    this.rings = landRings(TERRAIN_X0);
    const geos = [];
    for (const [i, ring] of this.rings.entries()) {
      for (const { c0, c1 } of ringChunks(ring, i)) {
        const w = c1 - c0 + 1, rows = ring.zs.length;
        const pos = new Float32Array(w * rows * 3);
        let k = 0;
        for (let r = 0; r < rows; r++) {
          for (let c = c0; c <= c1; c++) {
            pos[k++] = ring.xs[c];
            pos[k++] = 0;
            pos[k++] = ring.zs[r];
          }
        }
        const g = new T.BufferGeometry();
        g.setAttribute('position', new T.BufferAttribute(pos, 3));
        g.setAttribute('normal', new T.BufferAttribute(new Float32Array(w * rows * 3), 3));
        g.setAttribute('sunVis', new T.BufferAttribute(new Float32Array(w * rows).fill(1), 1));
        g.setIndex(ringIndex(ring, c0, c1));
        g.userData = { ring: i, c0, c1 };
        geos.push(g);
      }
    }
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
      // The sunlight worked out for each vertex (world/land.js): the
      // shadows of the land on itself, out to the horizon.
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vW;\nattribute float sunVis;\nvarying float vSunVis;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvW = (modelMatrix * vec4(position, 1.0)).xyz;\nvSunVis = sunVis;');
      // The Moon's own way with light (Lommel-Seeliger, mostly): its dust
      // is as bright tilted toward the sun as flat, and brighter seen
      // from low down, so the ground reads as one even sunlit sheet cut
      // by black shadow, as in the photographs, not modelled in greys.
      const lunar = T.ShaderChunk.lights_physical_pars_fragment.replace(
        'vec3 irradiance = dotNL * directLight.color;',
        `float dotNVm = saturate( dot( geometryNormal, geometryViewDir ) );
        vec3 irradiance = mix( dotNL, 1.1 * dotNL / ( dotNL + dotNVm + 0.08 ), 0.65 ) * directLight.color * vSunVis;`,
      );
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <lights_physical_pars_fragment>', lunar)
        .replace('#include <common>', `#include <common>
varying vec3 vW;
varying float vSunVis;
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
// Craters in feet: a bowl a third as deep as it is wide across the
// radius, a rim, a few per cell.
float craterFt(vec2 p, float cell, float rmin, float rmax, float keep){
  vec2 i = floor(p / cell), f = fract(p / cell);
  float h = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 c = i + g;
    if (h21(c + 3.3) > keep) continue;
    vec2 centre = g + vec2(h21(c + 9.1), h21(c + 27.7)) * 0.8 + 0.1;
    float rad = mix(rmin, rmax, pow(h21(c + 5.5), 2.0));
    float d = length(f - centre) * cell / rad;
    if (d < 2.2) h += rad * (d < 1.0 ? -0.33 * (1.0 - d * d) + 0.07 : 0.07 * pow(max(0.0, 2.2 - d) / 1.2, 2.5));
  }
  return h;
}
// The land seen from far off: craters from a few hundred feet to a mile,
// and a slow swell, for the light to catch where the mesh is coarse.
float reliefFar(vec2 p){
  return craterFt(p + 300.0, 500.0, 25.0, 110.0, 0.6) + craterFt(p - 2200.0, 1800.0, 90.0, 300.0, 0.5)
       + vnoise(p * 0.0011) * 60.0 + vnoise(p * 0.004 + 5.0) * 18.0;
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
  float kf = smoothstep(900.0, 4000.0, dist) * (1.0 - smoothstep(50000.0, 120000.0, dist)) * 0.85;
  vec2 grad = vec2(0.0);
  vec2 p = vW.xz;
  if (k > 0.001) {
    float e = 0.4;
    float h0 = relief(p);
    grad += k * vec2(relief(p + vec2(e, 0.0)) - h0, relief(p + vec2(0.0, e)) - h0) / e;
  }
  if (kf > 0.001) {
    float e = 6.0 + dist * 0.0012;
    float h0 = reliefFar(p);
    grad += kf * vec2(reliefFar(p + vec2(e, 0.0)) - h0, reliefFar(p + vec2(0.0, e)) - h0) / e;
  }
  if (k + kf > 0.001) {
    vec3 n = normalize(vec3(-grad.x, 1.0, -grad.y));
    vec3 nv = normalize((viewMatrix * vec4(n, 0.0)).xyz);
    normal = normalize(normal + (nv - normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz)));
  }
}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
{
  float blast = blastAt(vW.xz);
  // Grain close to, fading out before it can shimmer; patches of lighter
  // and darker ground at every size; fresh crater rims a little bright.
  float dd = length(cameraPosition - vW);
  float fine = 1.0 - smoothstep(150.0, 1500.0, dd);
  float g = (h21(floor(vW.xz * 3.0)) * 0.25 - 0.125) * fine + 0.125 + vnoise(vW.xz * 0.12) * 0.45 + vnoise(vW.xz * 0.012 + 4.0) * 0.3;
  g += (vnoise(vW.xz * 0.0006 + 2.0) - 0.5) * 0.25 + (vnoise(vW.xz * 0.00009 + 7.0) - 0.5) * 0.35;
  g = mix(g, 0.55, blast * 0.6);
  diffuseColor.rgb *= (0.84 + 0.3 * g) * (1.0 + 0.24 * blast);
  // Looking down-sun the grains hide their own shadows: a bright patch
  // about the antisolar point.
  vec3 toEye = normalize(cameraPosition - vW);
  float o = max(0.0, dot(toEye, normalize(uSunDir)));
  diffuseColor.rgb *= 1.0 + 0.3 * pow(o, 24.0) + 0.1 * pow(o, 4.0);
}`);
    };
    this.groundMeshes = geos.map((g) => {
      const mesh = new T.Mesh(g, mat);
      mesh.receiveShadow = true;
      // The far rings are past any shadow camera; their shadows are in
      // the sunlight worked out for them.
      mesh.castShadow = g.userData.ring < 3;
      mesh.visible = false; // until its heights come
      this.scene.add(mesh);
      return mesh;
    });
    this.landCache = new Map(); // scale -> ring surfaces
    this.landAsk = 0;
    this.landReady = new Promise((done) => (this.landDone = done));
    this.askLand();

    // The 1973 vectors: a faint phosphor line along the profile.
    const lg = new T.BufferGeometry();
    lg.setAttribute('position', new T.BufferAttribute(new Float32Array(TERRAIN_N * 3), 3).setUsage(T.DynamicDrawUsage));
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

  /** Ask for the land's surfaces at both scales, from the program's
   * heights as they are now. */
  askLand() {
    const id = ++this.landAsk;
    this.landCache.clear();
    const got = ({ id: from, scale, rings, lit = true }) => {
      if (from !== this.landAsk) return; // the heights have changed since
      if (!lit && this.landCache.has(scale)) return;
      rings.lit = lit;
      this.landCache.set(scale, rings);
      if (scale === this.scaleY) this.fillTerrain();
    };
    if (!this.landWorker && typeof Worker !== 'undefined') {
      try {
        this.landWorker = new Worker(new URL('./world/landworker.js', import.meta.url), { type: 'module' });
        this.landWorker.onmessage = (ev) => got(ev.data);
        this.landWorker.onerror = () => {
          // No worker after all: the page works them out itself.
          this.landWorker = null;
          this.askLand();
        };
      } catch (e) {
        this.landWorker = null;
      }
    }
    // The scale on show first, its shape before its sunlight.
    for (const scale of [this.scaleY, this.scaleY === 1 ? 0.25 : 1]) {
      const terrain = Int16Array.from(this.terrain);
      const sun = this.sunDir.toArray();
      if (this.landWorker) this.landWorker.postMessage({ id, terrain, x0: TERRAIN_X0, dx: TERRAIN_DX, scale, sun, early: scale === this.scaleY });
      else got({ id, scale, rings: landSurfaces(terrain, TERRAIN_X0, TERRAIN_DX, scale, sun) });
    }
  }

  /** The land's mesh and the trace at the current scale. */
  fillTerrain() {
    const rings = this.landCache && this.landCache.get(this.scaleY);
    if (rings && this.groundMeshes) {
      for (const mesh of this.groundMeshes) {
        const g = mesh.geometry, { ring, c0, c1 } = g.userData;
        const src = rings[ring], cols = this.rings[ring].xs.length, rows = this.rings[ring].zs.length;
        const pos = g.attributes.position.array, nor = g.attributes.normal.array, sun = g.attributes.sunVis.array;
        let k = 0;
        for (let r = 0; r < rows; r++) {
          for (let c = c0; c <= c1; c++, k++) {
            const j = r * cols + c;
            pos[k * 3 + 1] = src.y[j];
            nor[k * 3] = src.n[j * 3];
            nor[k * 3 + 1] = src.n[j * 3 + 1];
            nor[k * 3 + 2] = src.n[j * 3 + 2];
            sun[k] = src.sun ? src.sun[j] : 1;
          }
        }
        g.attributes.position.needsUpdate = true;
        g.attributes.normal.needsUpdate = true;
        g.attributes.sunVis.needsUpdate = true;
        g.computeBoundingSphere();
        mesh.visible = true;
      }
      this.landShown = this.scaleY;
      if (rings.lit) this.landDone();
    }
    const lp = this.traceGeometry.attributes.position.array;
    for (let c = 0; c < TERRAIN_N; c++) {
      lp[c * 3] = TERRAIN_X0 + c * TERRAIN_DX;
      lp[c * 3 + 1] = this.terrain[c] * this.scaleY + 1.5;
      lp[c * 3 + 2] = 0;
    }
    this.traceGeometry.attributes.position.needsUpdate = true;
    this.traceGeometry.computeBoundingSphere();
    if (this.pebbles) this.placePebbles();
  }

  /** Leave everything but the land out of the shadow map, or put it back. */
  coarseShadows(on) {
    if (on === !!this.shadowsOff) return;
    if (on) {
      const land = new Set(this.groundMeshes);
      this.shadowsOff = [];
      this.scene.traverse((o) => {
        if (o.castShadow && !o.isLight && !land.has(o)) {
          o.castShadow = false;
          this.shadowsOff.push(o);
        }
      });
    } else {
      for (const o of this.shadowsOff) o.castShadow = true;
      this.shadowsOff = null;
    }
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
        this.padSlab.geometry.dispose();
        this.padSlab.geometry = padGeometry(this.pad.y - low + 1.5);
      } else o.position.set(x, this.height(x) + lift, z);
    }
    // The boulders as solids: their ellipsoids, a little inside the
    // facets.
    this.rockCells = new Map();
    for (const r of this.rocks ? this.rocks.children : []) {
      const sx = r.scale.x * 0.95, sy = r.scale.y * 0.95, sz = r.scale.z * 0.95;
      const solid = { x: r.position.x, y: r.position.y, z: r.position.z, sx, sy, sz, c: Math.cos(r.rotation.y), s: Math.sin(r.rotation.y), reach: Math.max(sx, sz) };
      // Filed by 64-foot column, in every column it reaches into.
      for (let c = Math.floor((solid.x - solid.reach) / 64); c <= Math.floor((solid.x + solid.reach) / 64); c++) {
        if (!this.rockCells.has(c)) this.rockCells.set(c, []);
        this.rockCells.get(c).push(solid);
      }
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
    this.padSlab = add(new T.Mesh(padGeometry(2), concrete), 0, 0, 0, false);
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
      this.baseFov = w / h < 1 ? 62 : w / h < 1.4 ? 50 : 42;
      if (!this.opening) this.camera.fov = this.baseFov;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Whether the ship is standing on the ground. Not from RADARY: the
   * program works its radar out against the full-height terrain and then
   * the close-up's quarter-height one, and a snapshot can catch either,
   * so it reads zero or less tens of feet up. The verdict message is
   * certain: from GREATM, GOODM, ROUGHM or CRIPM until the program lifts
   * the ship off again (PALOFF puts it four feet up first).
   */
  groundState(state, close) {
    const S = this.symbols;
    if (close && !this.touch && !this.crash && LANDINGS.some((m) => S[m] !== undefined && S[m] === state.sysmes)) {
      this.touch = { verdis: state.verdis };
      this.lifting = false;
    }
    if (this.touch && (!close || state.verdis >= this.touch.verdis + 3)) {
      this.touch = null;
      this.lifting = close;
    }
    if (!close) this.lifting = false;
    return !!this.touch;
  }

  /**
   * Follow the program's position. The program moves the ship a few times
   * a second, a foot or two at a time in the close-up (HORDIS and VERDIS
   * are whole feet), and far more far out. So the car is carried on the
   * program's own velocities every frame, and drawn slowly toward where
   * the program says it is, read as the middle of the foot it reported,
   * carried on from the moment it reported it. Its steps never show, and
   * the car is never far from the program. A velocity the program has
   * left set while it no longer moves the ship is not used. On the ground
   * the car stands on the ground. A jump (a new game) is taken at once.
   */
  track(state, mt, mdt, down) {
    const now = state.t / 1e6;
    let tr = this.tracker;
    if (!tr || this.first) {
      tr = this.tracker = { x: state.hordis + 0.5, y: state.verdis + 0.5, ax: { v: state.hordis, at: now, gap: 0.17 }, ay: { v: state.verdis, at: now, gap: 0.17 } };
    }
    for (const [a, v] of [[tr.ax, state.hordis], [tr.ay, state.verdis]]) {
      if (v !== a.v) {
        a.gap = Math.min(0.5, Math.max(0.02, 0.7 * a.gap + 0.3 * (now - a.at)));
        a.v = v;
        a.at = now;
      }
    }
    const axis = (a, vel) => {
      let v = vel / 10;
      const e = Math.max(0, mt - a.at);
      // Moving, as far as the program is concerned, only if the value has
      // changed about as recently as it should have.
      if (e > Math.max(0.35, 3 * a.gap, 2.5 / Math.max(1e-3, Math.abs(v)))) v = 0;
      // Where the program has it: in the middle of the foot it reported,
      // carried on at its velocity, no further than its next step.
      const at = a.v + 0.5 + v * Math.min(e, 1.5 * a.gap);
      return { v, at };
    };
    const X = axis(tr.ax, state.horvel), Yv = axis(tr.ay, state.vervel);
    const ty = down ? this.groundAt(state.hordis, 0) - 0.06 : Yv.at;
    const far = (v) => 12 + 0.35 * Math.abs(v);
    if (Math.abs(X.at - tr.x) > far(X.v) || Math.abs(ty - tr.y) > far(Yv.v)) {
      tr.x = X.at;
      tr.y = ty;
      return tr;
    }
    // Carried on, but never into the ground: a ship coming down fast
    // meets it before the program says so, and stops there.
    if (!tr.struck) tr.x += X.v * mdt;
    if (!down) tr.y += Yv.v * mdt;
    const kx = 1 - Math.exp(-mdt / 0.6);
    const ky = 1 - Math.exp(-mdt / (down ? 0.1 : 0.6));
    tr.x += (X.at - tr.x) * kx;
    tr.y += (ty - tr.y) * ky;
    const floor = this.groundAt(tr.x, 0) - 0.06;
    if (!down && tr.y < floor) {
      tr.y = floor;
      if (Yv.v < -30) tr.struck = true;
    } else if (tr.y > floor + 2) tr.struck = false;
    return tr;
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
      this.lastStateWall = now;
      this.lastState = { ...state };
      this.lastT = state.t;
    }
    // A steady clock in machine time for everything that moves: the
    // machine runs in uneven chunks against the display, so the clock
    // advances by the frame and is drawn gently to the machine's.
    const st = state.t / 1e6;
    if (this.first || !(Math.abs(st - this.mtime) < 0.25)) this.mtime = st;
    else {
      const was = this.mtime;
      this.mtime += mdt;
      this.mtime += (st - this.mtime) * Math.min(1, dt * 3);
      this.mtime = Math.max(was, this.mtime);
    }
    const down = this.groundState(state, this.closeUp(state));
    this.liftingOff = this.lifting && !this.crash;
    const tracked = this.track(state, this.mtime, mdt, down);
    const target = { x: tracked.x, y: tracked.y, a: state.angle };

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
    const prevX = this.pose.x;
    this.pose.x = target.x;
    this.pose.y = target.y;
    // Angles: the program's are degrees clockwise from up. On the ground a
    // big change is the ship falling over (TILT): let it fall, not snap.
    let da = target.a - this.pose.a;
    while (da > 180) da -= 360;
    while (da < -180) da += 360;
    this.pose.a += da * (this.first ? 1 : 1 - Math.exp(-dt / 0.12));

    // Over: the program has the ship tipped (FSUBC holds the message).
    if (!this.topple && !this.crash && this.scaleY < 1 && down && this.tipMessage(state)) this.startTopple(state);
    // A crash: the program stops drawing the ship (SHIPDP cleared) once it
    // has drawn it at least once this game.
    if (state.shipdp !== 0) this.shipSeen = true;
    const said = state.sysmes !== this.sysmesWas && this.crashMessage(state);
    this.sysmesWas = state.sysmes;
    if (this.shipSeen && (state.shipdp === 0 || said) && !this.crash && this.scaleY < 1) this.startCrash(state);
    if (!this.crash) this.crashKit.idle();
    if (this.crash) {
      for (const e of this.crash.update(mdt)) this.happened(e);
      if (!this.exploded) this.followCar();
      else {
        this.pose.x = this.crashAt.x;
        this.pose.y = this.crashAt.y;
      }
    } else if (this.topple) {
      for (const h of this.topple.update(mdt)) this.happened({ kind: 'blow', at: h.at, speed: h.speed });
      this.followCar();
      if (this.topple.resting && !this.toppleKept) this.keepWreck();
    }

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
    const dist = this.camRig ? this.camRig.dist : this.first ? d : this.camPos.distanceTo(this.camTarget) || d;
    const scale = Math.max(1, dist / 500);
    this.car.group.visible = !this.exploded;
    if (!this.topple && !this.crash) {
      const wasAir = this.car.airborne;
      this.car.place(this.pose.x, this.pose.y, this.pose.a, (x) => this.groundAt(x, 0), mdt, scale, down ? 0 : state.vervel / 10);
      if (this.car.wheels.some((w) => w.contact)) this.car.roll(this.pose.x - prevX);
      // Touchdown: the tyres kick the dust up where they meet it.
      if (wasAir && !this.car.airborne && close && this.car.vAir < -2) this.tyreDust(-this.car.vAir);
      if (this.opening) this.openingPose(this.opening, dt);
    }

    // The driver.
    this.man.root.visible = !this.exploded;
    this.man.root.scale.setScalar(this.driver.isOut ? 1 : scale);
    if (!this.exploded) this.driver.update(state, this.mtime, mdt, down);
    this.walking = this.driver.isOut && close;
    const driverX = this.driver.x;

    // Ahead of the car by its speed, while it flies; the program leaves its
    // velocity set after a crash or a tip, and the camera should not go on.
    const lead = this.crash || this.topple ? 0 : state.horvel / 10;
    const look = new T.Vector3(this.pose.x + lead * 0.6, ground + alt * (close ? 0.5 : 0.6) + 6, 0);
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
    let kc = this.first ? 1 : 1 - Math.exp(-dt / 0.5);
    let fov = this.baseFov || this.camera.fov;
    let near = Math.max(0.5, Math.min(d, d2) * 0.01);
    if (this.opening && this.openingCentre) {
      // The opening shot, turning and drawing back into the flight's own.
      // Both cameras as where they stand from the car and which way they
      // look, each turned and stretched from one to the other, so the car
      // stays in the frame all the way.
      const o = this.opening, c = this.openingCentre;
      const hero = this.heroShot(o.t, c);
      const e = ease(o.k);
      const offH = hero.cam.clone().sub(c), offC = cam.clone().sub(c);
      const lh = Math.log(offH.length()), lc = Math.log(offC.length());
      const len = Math.exp(lh + (lc - lh) * e);
      const vH = hero.look.clone().sub(hero.cam).normalize(), vC = look.clone().sub(cam).normalize();
      cam.copy(c).addScaledVector(slerpDir(offH.normalize(), offC.normalize(), e), len);
      look.copy(cam).addScaledVector(slerpDir(vH, vC, e), len);
      fov = Math.exp(Math.log(hero.fov) + (Math.log(fov) - Math.log(hero.fov)) * e);
      near = Math.max(0.5, Math.min(0.3 * cam.distanceTo(c), near));
      kc = 1;
    }
    if (this.camRig) {
      // For the lab: a camera set from where the car is this frame.
      this.camRig.place(this, cam, look);
      fov = this.camRig.fov || fov;
      near = Math.max(0.5, Math.min(near, 0.3 * this.camRig.dist));
      kc = 1;
    }
    if (this.camera.fov !== fov) this.camera.fov = fov;
    if (this.debugCam) {
      // For tests: a fixed camera.
      cam.set(...this.debugCam.pos);
      look.set(...this.debugCam.look);
    }
    this.camTarget.lerp(look, kc);
    this.camPos.lerp(cam, kc);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget);
    this.camera.near = near;
    this.camera.far = 1500000;
    this.camera.updateProjectionMatrix();

    // The sun's shadow camera follows what is being looked at.
    // Far out it takes in all the country in view, so the mountains throw
    // their shadows across it; close in, the car and the ground round it.
    let sunR = close ? T.MathUtils.clamp(alt * 1.2 + 70, 70, 900) : T.MathUtils.clamp(dist * 1.3, 3000, 60000);
    // In the opening, close on the car: its own shadows on itself.
    if (this.opening && this.openingCentre) {
      const e = ease(this.opening.k);
      sunR = T.MathUtils.lerp(Math.max(30, this.camPos.distanceTo(this.openingCentre) * 0.4), sunR, e * e);
    }
    const back = close ? sunR * 3 : Math.max(sunR * 3, 40000);
    this.sunTarget.position.copy(this.camTarget);
    this.sun.position.copy(this.sunTarget.position).addScaledVector(this.sunDir, back);
    const sc = this.sun.shadow.camera;
    sc.left = -sunR; sc.right = sunR; sc.top = sunR; sc.bottom = -sunR;
    sc.near = Math.max(1, back - 3 * sunR - 20000 * (close ? 0 : 1));
    sc.far = back + 3 * sunR;
    sc.updateProjectionMatrix();
    // Bias by the size of a shadow texel, so the ground does not shadow itself.
    const texel = (2 * sunR) / this.sun.shadow.mapSize.x;
    this.sun.shadow.normalBias = Math.max(0.04, texel * 1.2);
    // When a texel is wider than a car, only the land's shadows show: the
    // rest is left out of the shadow map rather than drawn into it for
    // nothing.
    this.coarseShadows(texel > 4);
    // And close in, only the finest ring is under the shadow camera.
    if (this.groundMeshes) for (const m of this.groundMeshes) m.castShadow = m.geometry.userData.ring < (close ? 1 : 3);

    // Exhaust. THRUST stays where it was when the program stops flying,
    // so on the ground there is none, whatever it says.
    const maxThrust = this.maxThrust || 1;
    // Gas only while the program draws the flame (FSUBC); THRUST keeps its
    // last value when the program stops flying the ship.
    const power = this.opening || this.crash || this.topple || down || state.flame === 0 ? 0 : Math.max(0, Math.min(1, state.thrust / maxThrust)) * (state.fuel > 0 ? 1 : 0);
    this.thrustNow = power;
    // (The program is held through the opening: its puffs go by the clock.)
    const xdt = this.opening ? dt : mdt;
    const jet = this.crash ? { hit: null } : this.exhaust.update(this.mtime + (this.openingClock || 0), xdt, power, this.camera, (x, z) => this.groundAt(x, z), scale);
    if (this.crash) this.exhaust.hide();
    if (jet.hit) {
      this.dust.emit(mdt, jet.hit, jet.strength, jet.alt, (x, z) => this.groundAt(x, z), scale);
      this.scour(jet.hit, jet.strength, jet.alt, mdt);
    } else this.dust.stop();
    this.dust.update(this.mtime);

    if (this.flashAt !== undefined) {
      const f = this.mtime - this.flashAt;
      this.flash.position.copy(this.crashAt).add(new T.Vector3(0, 4, 3));
      this.flash.intensity = f < 0.4 ? this.flashPower * Math.exp(-f * 16) : 0;
      if (f > 1) this.flashAt = undefined;
    }
    // The ground the ejecta come down on lightens as they land.
    if (this.halo) {
      const k = Math.min(1, (this.mtime - this.halo.at) / this.halo.over);
      this.halo.b.s = this.halo.s * k * k * (3 - 2 * k);
      this.pushBlasts();
      if (k >= 1) this.halo = null;
    }
    if (this.rereadAt && this.rereadAt.length && this.mtime >= this.rereadAt[0]) {
      this.rereadAt.shift();
      this.rereadTerrain();
    }
    // The diner, if the program says it has been destroyed.
    if (this.diner) this.dinerStands(!!(state.diner & 1) || (this.crash && !this.exploded), mdt);
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
    this.pushBlasts();
  }

  pushBlasts() {
    this.blastUniform.value.forEach((v, i) => {
      const z = this.blasts[i];
      if (z) v.set(z.x, z.z, z.r, z.s);
      else v.set(0, 0, 1, 0);
    });
  }

  /**
   * The car in the opening: drifting, turning a little this way and that
   * for as long as the opening waits, then brought round on its corner jets
   * to the attitude the program starts it at, turning about its middle.
   */
  openingPose(o, dt) {
    const g = this.car.group;
    const qFlight = g.quaternion.clone();
    const com = COM.clone().multiplyScalar(g.scale.x);
    const c = com.clone().applyQuaternion(qFlight).add(g.position);
    const t = o.t;
    const w = (p) => Math.sin((2 * Math.PI * t) / p);
    const qHero = new T.Quaternion().setFromEuler(new T.Euler(0.8 + 0.12 * w(29), -0.5 + 0.24 * w(41), 0.15 + 0.08 * w(19), 'YXZ'));
    const e = ease(T.MathUtils.clamp((o.k - 0.04) / 0.55, 0, 1));
    const q = qHero.slerp(qFlight, e);
    g.quaternion.copy(q);
    g.position.copy(c).sub(com.applyQuaternion(q));
    g.updateMatrixWorld(true);
    this.openingCentre = c;
    // The corner jets, in short bursts while it turns.
    this.openingClock = (this.openingClock || 0) + dt;
    const turning = e > 0.02 && e < 0.9;
    const beat = Math.floor(this.openingClock / 0.32);
    if (turning && beat !== this.openingBeat) {
      this.openingBeat = beat;
      const pair = beat % 2 ? ['noseDown', 'tailUp'] : ['noseUp', 'tailDown'];
      for (const p of pair) this.exhaust.puff(p, 0.14);
      this.puffing = true;
    } else this.puffing = false;
  }

  /** The opening shot: the car, near, against the Earth, on a long lens,
   * the camera easing in and out and round a little as it waits. */
  heroShot(t, c) {
    const aspect = this.camera.aspect || 16 / 9;
    // About fifteen degrees across, whatever the screen.
    const hfov = 10.5;
    const vfov = T.MathUtils.radToDeg(2 * Math.atan(Math.tan(T.MathUtils.degToRad(hfov / 2)) / aspect));
    const e = this.earth.position.clone().sub(c).normalize();
    const up = new T.Vector3(0, 1, 0).addScaledVector(e, -e.y).normalize();
    const right = new T.Vector3().crossVectors(e, up).normalize();
    // The car beside the Earth on a wide screen, under it on a tall one;
    // drifting a little closer as the shot goes on.
    const wide = aspect >= 1;
    const w = (p) => Math.sin((2 * Math.PI * t) / p);
    const sep = T.MathUtils.degToRad((wide ? hfov * 0.42 : vfov * 0.3) * (1 - 0.06 * w(33)));
    const toCar = e.clone().multiplyScalar(Math.cos(sep)).addScaledVector(wide ? right : up, -Math.sin(sep)).normalize();
    toCar.applyAxisAngle(e, 0.06 * w(47));
    const D = 185 * (1 - 0.06 * w(27));
    const cam = c.clone().addScaledVector(toCar, -D);
    // Both a little above the middle, to leave room for the title below.
    const dir = toCar.clone().add(e).normalize().addScaledVector(up, -Math.tan(T.MathUtils.degToRad(vfov * 0.13))).normalize();
    return { cam, look: cam.clone().addScaledVector(dir, D), fov: vfov };
  }

  render() {
    if (!this.terrain) return;
    this.resize();
    this.tubeTexture.needsUpdate = true;
    this.composer.render();
  }

  /** Whether the program has just said the ship has crashed. */
  crashMessage(state) {
    const S = this.symbols;
    return ['DEADM', 'ROCKMS', 'OLDMS', 'OLDTLT', 'MACDED'].some((m) => S[m] !== undefined && S[m] === state.sysmes);
  }

  /** Whether the program has the ship tipped over. */
  tipMessage(state) {
    const S = this.symbols;
    return ['SIDEM', 'ANGLEM', 'BUMPYM'].some((m) => S[m] !== undefined && S[m] === state.flame);
  }

  startTopple(state) {
    const v = new T.Vector3(state.horvel / 10, Math.min(0, state.vervel / 10), 0);
    const fall = state.angle >= 0 ? 1 : -1;
    const seed = (Math.abs(state.indexl * 0.618034) + (state.t / 1e6) * 0.37) % 1;
    const home = TERRAIN_X0 + state.indexl * TERRAIN_DX + TERRAIN_DX / 2;
    this.topple = new Topple(this.car, v, fall, (x, z) => this.solidAt(x, z), seed, home);
    this.toppleIndex = state.indexl;
    this.toppleKept = false;
  }

  /** A fresh Moon: no wrecks on it to remember. */
  forgetWrecks() {
    this.topple = null;
    this.wreckPoses.clear();
    this.blasts.length = 0;
    this.halo = null;
    if (this.blastUniform) this.pushBlasts();
  }

  /** Remember how the tipped car lies, for the games after. */
  keepWreck() {
    if (!this.topple) return;
    this.toppleKept = true;
    const g = this.car.group;
    this.wreckPoses.set(this.toppleIndex, {
      p: g.position.clone(), q: g.quaternion.clone(), scaleY: this.scaleY, h: this.height(g.position.x),
      wheels: this.car.wheels.map((w) => w.t),
    });
  }

  startCrash(state) {
    this.flashPower = 0;
    const v = new T.Vector3(state.horvel / 10, state.vervel / 10, 0);
    // Onto a car left from before: the nearest one.
    let aim = null;
    const S = this.symbols;
    if (state.sysmes === S.OLDMS || state.sysmes === S.OLDTLT) {
      const x = this.car.group.position.x;
      for (const l of this.leftoverAt || []) {
        if (!l.solid || Math.abs(l.solid.x - x) > 40) continue;
        if (!aim || Math.abs(l.solid.x - x) < Math.abs(aim.x - x)) aim = { x: l.solid.x, z: l.solid.z, top: l.solid.y + l.solid.hy };
      }
    }
    this.crash = new Crash({ scene: this.scene, car: this.car, kit: this.crashKit, v, random: this.random, solid: (x, z) => this.solidAt(x, z), ground: (x, z) => this.groundAt(x, z), aim });
    // The program digs a crater as it explodes (ALTER): read it soon.
    this.rereadAt = [this.mtime + 0.1, this.mtime + 1.2];
    this.exhaust.hide();
    this.dust.stop();
  }

  /** The camera and the rest follow the car as the free body has it. */
  followCar() {
    this.pose.x = this.car.group.position.x;
    this.pose.y = this.car.group.position.y;
  }

  /** Something the sound, the light or the ground should know about. */
  happened(e) {
    this.events.push(e);
    if (e.kind === 'burst') {
      this.exploded = true;
      this.crashAt = e.at.clone();
      this.flashAt = this.mtime;
      this.flashPower = e.hard ? 900 : 450;
      // The ejecta blanket: light ground, in rays, as they come down.
      const b = { x: e.at.x, z: e.at.z, r: e.hard ? 48 : 18, s: 0 };
      this.blasts.push(b);
      if (this.blasts.length > 4) this.blasts.shift();
      this.halo = { b, s: e.hard ? 0.9 : 0.6, at: this.mtime, over: e.hard ? 4 : 1.6 };
    }
    if (e.kind === 'blow' && e.speed > 3) this.dust.kick(e.at, e.speed * 0.6, (x, z) => this.groundAt(x, z), 1);
  }

  /** The tyres meeting the ground at `speed` ft/s throw a little dust. */
  tyreDust(speed) {
    this.car.group.updateMatrixWorld(true);
    for (const w of this.car.wheels) {
      if (!w.group.visible) continue;
      const p = new T.Vector3().setFromMatrixPosition(w.group.matrixWorld);
      p.y -= w.r;
      this.dust.kick(p, speed, (x, z) => this.groundAt(x, z), 0.25);
    }
  }

  /** What has happened since the last call, for the sound. */
  takeEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  /** The diner stands, or lies flattened by a car. */
  dinerStands(up, dt = 0) {
    // Down in a second when a car comes through the roof; at once when a
    // new game finds it gone.
    const was = this.dinerUp;
    this.dinerUp = up;
    const goal = up ? 1 : 0.3;
    const k = was === undefined || up || !this.exploded ? 1 : Math.min(1, dt * 2.5);
    this.diner.scale.y += (goal - this.diner.scale.y) * k;
    const f = (1 - this.diner.scale.y) / 0.7;
    for (const [i, sc] of this.screens.entries()) sc.parent.rotation.z = (i ? -1 : 1) * 0.6 * f;
  }

  /** The terrain as the program has it now: a crash digs a crater. */
  rereadTerrain() {
    if (!this.peek) return;
    let lo = TERRAIN_N, hi = -1;
    for (let i = 0; i < TERRAIN_N; i++) {
      const v = (this.peek(this.symbols.TERAIN + 2 * i) << 16) >> 16;
      if (v !== this.terrain[i]) {
        this.terrain[i] = v;
        lo = Math.min(lo, i);
        hi = i;
      }
    }
    if (hi >= 0) {
      this.land.refresh();
      if (hi - lo < 40) this.patchLand(lo, hi);
      this.askLand();
      this.fillTerrain();
      this.placeFeatures();
    }
  }

  /** A crater dug into the program's heights shows at once: the finest
   * ring round it is worked out here, until the whole land comes back
   * from the worker. */
  patchLand(lo, hi) {
    if (!this.groundMeshes || this.landShown !== this.scaleY) return;
    const ring = this.rings[0], zs = ring.zs, land = this.land;
    const xa = TERRAIN_X0 + lo * TERRAIN_DX - 640, xb = TERRAIN_X0 + hi * TERRAIN_DX + 640;
    const h = (x, z) => land.height(x, z, 0);
    for (const mesh of this.groundMeshes) {
      const g = mesh.geometry, { ring: ri, c0, c1 } = g.userData;
      if (ri !== 0 || ring.xs[c1] < xa || ring.xs[c0] > xb) continue;
      const w = c1 - c0 + 1;
      const pos = g.attributes.position.array, nor = g.attributes.normal.array;
      for (let r = 1; r < zs.length - 1; r++) {
        const z = zs[r];
        if (Math.abs(z) > 320) continue;
        for (let c = c0; c <= c1; c++) {
          const x = ring.xs[c];
          if (x < xa || x > xb) continue;
          const k = r * w + (c - c0);
          pos[k * 3 + 1] = h(x, z);
          // As the rings' own normals: differences across the grid.
          const gx = (h(x + ring.cell, z) - h(x - ring.cell, z)) / (2 * ring.cell);
          const gz = (h(x, zs[r + 1]) - h(x, zs[r - 1])) / (zs[r + 1] - zs[r - 1]);
          const l = Math.hypot(gx, 1, gz);
          nor[k * 3] = -gx / l;
          nor[k * 3 + 1] = 1 / l;
          nor[k * 3 + 2] = -gz / l;
        }
      }
      g.attributes.position.needsUpdate = true;
      g.attributes.normal.needsUpdate = true;
    }
  }

  /** A new game: the car is whole again, and the driver in it. */
  reset() {
    if (this.topple && !this.toppleKept) this.keepWreck();
    if (this.peek) {
      this.rereadTerrain();
      this.buildLeftovers();
    }
    this.exploded = false;
    this.shipSeen = false;
    this.walking = false;
    this.touch = null;
    this.lifting = false;
    this.tracker = null;
    this.driver.reset();
    this.car.setCanopy(0);
    this.topple = null;
    if (this.crash) {
      this.crash.dispose();
      this.crash = null;
    }
    this.flashAt = undefined;
    this.halo = null;
    this.dust.clear();
    this.exhaust.hide();
    this.first = true;
  }
}
