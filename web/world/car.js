// The Roadster: a lofted body from a handful of profiles, a single-seat
// cockpit under a canopy hinged at its front edge, wheels on suspension
// that keep to the ground, cold-gas nozzles under the floor and at the
// corners. Car-local coordinates: x forward (the nose), y up, z toward the
// camera; the origin is on the ground midway between the axles, with the
// suspension at its nominal ride height. Units are feet.
//
// No badges, no wordmarks: the shape is the reference.

import * as T from '../vendor/three.js';
import { curve, smoothstep, spow, clamp, lerp } from './shape.js';

export const CAR = {
  HALF: 7.1,
  AXLES: [
    { x: 4.25, r: 1.13 },
    { x: -4.35, r: 1.17 },
  ],
  TRACK: 2.86, // wheel centre, either side
  TYRE_W: 0.92,
  CLEAR: 0.45, // floor height under the body
  FLOOR: 0.62, // the cockpit tub's floor
  COCKPIT: { x0: -2.75, x1: 1.35, hw: 1.62 },
  SEAT: { x: -0.25, y: 1.3 }, // the seated driver's pelvis
  DROOP: 0.32,
  BUMP: 0.26,
  CANOPY_OPEN: 1.66, // radians, 95 degrees: past upright, clear of the cockpit
};

// The cockpit's fittings as boxes: centre, half sizes, tilt about z.
// Used to build them and to keep the driver out of them.
export const FITTINGS = [
  { name: 'cushion', c: [-0.4, 0.76, 0], h: [0.6, 0.14, 0.66], rz: 0 },
  { name: 'back', c: [-1.9, 1.84, 0], h: [0.1, 0.94, 0.7], rz: 0.4 },
  { name: 'dash', c: [1.95, 2.2, 0], h: [0.3, 0.15, 1.2], rz: 0 },
];
// Room for the feet under the front of the body, ahead of the opening.
const FOOTWELL = { x0: CAR.COCKPIT.x1 - 0.15, x1: 3.3, hw: 1.1, y1: 2.36 };

/** What a foot stands on at car-local (x, z): the floor or the seat in
 * the cockpit, the body's top outside it. */
export function carSurface(x, z) {
  if (x > FOOTWELL.x0 && x < FOOTWELL.x1 && Math.abs(z) < FOOTWELL.hw) return CAR.FLOOR;
  if (Math.abs(z) < cockpitHalf(x)) {
    const c = FITTINGS[0];
    if (Math.abs(x - c.c[0]) < c.h[0] && Math.abs(z - c.c[2]) < c.h[2]) return c.c[1] + c.h[1];
    return CAR.FLOOR;
  }
  return surfaceTop(x, z);
}

/** Whether a car-local point is inside one of the fittings. */
export function inFitting(p) {
  for (const f of FITTINGS) {
    const c = Math.cos(-f.rz), s = Math.sin(-f.rz);
    const dx = p.x - f.c[0], dy = p.y - f.c[1];
    const lx = dx * c - dy * s, ly = dx * s + dy * c;
    if (Math.abs(lx) < f.h[0] && Math.abs(ly) < f.h[1] && Math.abs(p.z - f.c[2]) < f.h[2]) return f.name;
  }
  return null;
}

// Profiles along the car, tail (-7.1) to nose (+7.1).
const yTop = curve([[-7.1, 2.3], [-6.95, 2.52], [-6.2, 2.7], [-4.5, 2.92], [-3.3, 2.98], [-2.75, 2.82], [-1.0, 2.64], [0.6, 2.54], [1.35, 2.48], [2.6, 2.36], [4.2, 2.3], [5.6, 2.06], [6.6, 1.66], [7.1, 1.25]]);
const yBot = curve([[-7.1, 1.25], [-6.85, 0.82], [-6.0, 0.6], [-4.4, 0.45], [4.0, 0.45], [5.9, 0.5], [6.85, 0.66], [7.1, 0.92]]);
const hwBase = curve([[-7.1, 3.12], [-4.35, 3.5], [-2.2, 3.16], [-1.0, 3.08], [2.0, 3.14], [4.25, 3.42], [6.0, 3.12], [7.1, 2.9]]);
const canopyH = curve([[CAR.COCKPIT.x0, 0.0], [-2.3, 0.75], [-1.7, 1.3], [-1.0, 1.52], [-0.2, 1.4], [0.6, 0.92], [1.1, 0.42], [CAR.COCKPIT.x1, 0.0]]);

const SECT_N = 3.0;
const ZI = CAR.TRACK - 0.62; // the arch liner's inner wall

function plan(x) {
  // Rounder at the nose, squarer at the tail.
  const p = x > 0 ? 3.5 : 6;
  const u = Math.min(1, Math.abs(x) / CAR.HALF);
  return Math.pow(Math.max(0, 1 - Math.pow(u, p)), 1 / p);
}

function bulge(x) {
  return 0.36 * Math.exp(-(((x - 4.25) / 1.5) ** 2)) + 0.4 * Math.exp(-(((x + 4.35) / 1.6) ** 2));
}

/** Height of the wheel arch's top at station x, or -Infinity. */
function archTop(x) {
  let ya = -Infinity;
  for (const a of CAR.AXLES) {
    const dx = x - a.x, ra = a.r + 0.3;
    if (Math.abs(dx) < ra) ya = Math.max(ya, a.r + Math.sqrt(ra * ra - dx * dx));
  }
  return ya;
}

/** The body's section at station x. */
export function section(x) {
  const e = plan(x);
  const yb = yBot(x), yt = yTop(x);
  const yc = yb + 0.45 * (yt - yb);
  return { e, yb, yt, yc, hu: yt - yc, hl: yc - yb, hw: hwBase(x) * e, bulge: bulge(x) * e };
}

/** The natural outline: upper half, phi from 0 (the side) to pi/2 (the
 * top centre), and lower half, phi from 0 to -pi/2. Returns [z, y]. */
function ringPoint(S, phi) {
  const c = Math.cos(phi), s = Math.sin(phi);
  const zn = spow(c, 2 / SECT_N), yn = spow(s, 2 / SECT_N);
  if (s >= 0) {
    const z = S.hw * zn * (1 - 0.12 * yn * yn);
    const y = S.yc + S.hu * yn + S.bulge * Math.pow(Math.abs(zn), 4) * Math.min(1, yn * 3);
    return [z, y];
  }
  return [S.hw * zn * (1 - 0.1 * yn * yn), S.yc + S.hl * yn];
}

/** The angle in [a, b] at which f(phi) crosses v (f monotone). */
function solve(f, v, a, b) {
  let lo = a, hi = b;
  const up = f(b) > f(a);
  for (let i = 0; i < 32; i++) {
    const m = (lo + hi) / 2;
    if ((f(m) < v) === up) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

// Points in each part of a half section, top centre to bottom centre.
const SEG = { floor: 6, wall: 5, upper: 22, lower: 10, roof: 5, liner: 5, under: 10 };
const HALF_RING = SEG.floor + SEG.wall + SEG.upper + SEG.lower + SEG.roof + SEG.liner + SEG.under;
const DARK_SEGS = new Set(['floor', 'wall', 'roof', 'liner', 'under']);

/**
 * One half of the section at x (z >= 0), as a list of [z, y, part]: the
 * cockpit floor and wall where there is a cockpit, the outer skin, and,
 * where a wheel is, the skin cut away to the arch, the liner's roof and
 * inner wall, then the underside. Every station has the same number of
 * points in each part, so the edges between parts run smoothly along the
 * car instead of stepping from one grid line to the next.
 */
function halfSection(x, carve = true) {
  const S = section(x);
  const out = [];
  const U = (phi) => ringPoint(S, phi);
  const push = (p, part) => out.push([p[0], p[1], part]);
  const spread = (n, f, part) => {
    for (let i = 0; i < n; i++) push(f(n === 1 ? 0 : i / (n - 1)), part);
  };
  // The cockpit.
  const cw = carve ? cockpitHalf(x) : 0;
  const phiEdge = cw > 0 ? solve((p) => U(p)[0], cw, 0, Math.PI / 2) : Math.PI / 2;
  const edge = U(phiEdge);
  const { x0, x1 } = CAR.COCKPIT;
  const depth = cw > 0 ? smoothstep(0, 0.4, Math.min(x - x0, x1 - x)) : 0;
  const yF = lerp(edge[1], CAR.FLOOR, depth);
  const wallZ = Math.max(0, cw - 0.08 * depth);
  spread(SEG.floor, (t) => [t * wallZ, yF], 'floor');
  spread(SEG.wall, (t) => [lerp(wallZ, edge[0], t), lerp(yF, edge[1], t)], 'wall');
  // The arch.
  let ya = carve ? archTop(x) : -Infinity;
  const L = (phi) => ringPoint(S, phi);
  const phiZi = S.hw > ZI + 0.05 ? solve((p) => L(p)[0], ZI, -Math.PI / 2, 0) : 0;
  const yZi = L(phiZi)[1];
  let cut = null;
  if (ya > yZi + 0.01 && S.hw > ZI + 0.2) {
    if (ya > S.yc) {
      const phiC = solve((p) => U(p)[1], ya, 0, phiEdge);
      if (U(phiC)[0] < ZI + 0.15) {
        // Keep some fender above the arch.
        ya = U(solve((p) => U(p)[0], ZI + 0.15, 0, phiEdge))[1];
      }
      cut = { on: 'upper', phi: solve((p) => U(p)[1], ya, 0, phiEdge) };
    } else {
      cut = { on: 'lower', phi: solve((p) => L(p)[1], ya, phiZi, 0) };
    }
  }
  const upperEnd = cut && cut.on === 'upper' ? cut.phi : 0;
  spread(SEG.upper, (t) => U(lerp(phiEdge, upperEnd, t)), 'upper');
  if (!cut) {
    spread(SEG.lower, (t) => L(lerp(0, phiZi, t)), 'lower');
    spread(SEG.roof, () => L(phiZi), 'roof');
    spread(SEG.liner, () => L(phiZi), 'liner');
  } else {
    const cp = cut.on === 'upper' ? U(cut.phi) : L(cut.phi);
    if (cut.on === 'upper') spread(SEG.lower, () => cp, 'lower');
    else spread(SEG.lower, (t) => L(lerp(0, cut.phi, t)), 'lower');
    spread(SEG.roof, (t) => [lerp(cp[0], ZI, t), ya], 'roof');
    spread(SEG.liner, (t) => [ZI, lerp(ya, yZi, t)], 'liner');
  }
  spread(SEG.under, (t) => L(lerp(phiZi, -Math.PI / 2, t)), 'under');
  return out;
}

/** Half width of the cockpit opening at station x, 0 outside it. */
export function cockpitHalf(x) {
  const { x0, x1, hw } = CAR.COCKPIT;
  if (x <= x0 || x >= x1) return 0;
  const u = Math.abs((x - (x0 + x1) / 2) / ((x1 - x0) / 2));
  return hw * Math.pow(Math.max(0, 1 - u * u * u), 1 / 3);
}

/** The height of the body's upper surface at (x, z), the cockpit not
 * carved: for the canopy's base and for standing on the sill. */
export function surfaceTop(x, z) {
  const S = section(x);
  const az = Math.abs(z);
  if (az >= S.hw) return S.yc;
  let lo = 0, hi = Math.PI / 2;
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2;
    if (ringPoint(S, m)[0] > az) lo = m;
    else hi = m;
  }
  return ringPoint(S, (lo + hi) / 2)[1];
}

/** Whether a car-local point is inside the body's solid (not the cockpit,
 * not the wheel arches). For checking that nothing walks through it. */
export function insideBody(p) {
  if (p.x <= -CAR.HALF || p.x >= CAR.HALF) return false;
  const S = section(p.x);
  if (p.y < S.yb || p.y > S.yt + S.bulge + 0.01) return false;
  const cw = cockpitHalf(p.x);
  if (cw > 0 && Math.abs(p.z) < cw && p.y > CAR.FLOOR) return false;
  if (p.x > FOOTWELL.x0 && p.x < FOOTWELL.x1 && Math.abs(p.z) < FOOTWELL.hw && p.y > CAR.FLOOR && p.y < FOOTWELL.y1) return false;
  if (Math.abs(p.z) > ZI && p.y < archTop(p.x)) return false;
  if (p.y >= S.yc) return Math.abs(p.z) < sideAt(S, p.y);
  const yn = (S.yc - p.y) / S.hl;
  const zmax = S.hw * Math.pow(Math.max(0, 1 - Math.pow(yn, SECT_N)), 1 / SECT_N) * (1 - 0.1 * yn * yn);
  return Math.abs(p.z) < zmax;
}

function sideAt(S, y) {
  // The upper outline's half width at height y (by bisection on phi).
  let lo = 0, hi = Math.PI / 2;
  if (y <= S.yc) return S.hw;
  if (y >= ringPoint(S, Math.PI / 2)[1]) return 0;
  for (let i = 0; i < 26; i++) {
    const m = (lo + hi) / 2;
    if (ringPoint(S, m)[1] < y) lo = m;
    else hi = m;
  }
  return ringPoint(S, (lo + hi) / 2)[0];
}

/**
 * Normals, without NaNs. A vertex whose faces all have no area (the
 * collapsed rows where a part of the section has shrunk to a point) gets
 * no normal from computeVertexNormals but a NaN, and one NaN pixel
 * through the bloom pass blacks out the whole frame. Those take the
 * normal of a neighbour along the ring, or point away from the axis.
 */
export function safeNormals(g) {
  g.computeVertexNormals();
  const n = g.attributes.normal, p = g.attributes.position;
  for (let i = 0; i < n.count; i++) {
    const x = n.getX(i), y = n.getY(i), z = n.getZ(i);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && x * x + y * y + z * z > 0.5) continue;
    let fx = 0, fy = p.getY(i) - 1.4, fz = p.getZ(i);
    for (const j of [i - 1, i + 1, i - 2, i + 2]) {
      if (j < 0 || j >= n.count) continue;
      const a = n.getX(j), b = n.getY(j), c = n.getZ(j);
      if (Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && a * a + b * b + c * c > 0.5) {
        fx = a;
        fy = b;
        fz = c;
        break;
      }
    }
    const l = Math.hypot(fx, fy, fz) || 1;
    n.setXYZ(i, fx / l, fy / l, fz / l);
  }
  n.needsUpdate = true;
  return g;
}

/** Build the body (or a slice of it, for debris) as one geometry with two
 * groups: 0 paint, 1 dark (cockpit tub, arch liners, the underside). */
export function bodyGeometry({ x0 = -CAR.HALF, x1 = CAR.HALF, stations = 150, carve = true, caps = true } = {}) {
  const xs = [];
  const whole = x0 === -CAR.HALF && x1 === CAR.HALF;
  for (let i = 0; i < stations; i++) {
    const s = i / (stations - 1);
    // Denser at the ends, where the shape turns fastest.
    xs.push(lerp(x0, x1, whole ? 0.5 - 0.5 * Math.cos(Math.PI * s) : s));
  }
  // A full ring: the half section, then its mirror back up, without
  // repeating the two points on the centre line.
  const ring = HALF_RING * 2 - 2;
  const pos = [];
  let parts = null;
  for (const x of xs) {
    const half = halfSection(x, carve);
    const full = half.concat(half.slice(1, -1).reverse().map(([z, y, part]) => [-z, y, part]));
    if (!parts) parts = full.map((p) => p[2]);
    for (const [z, y] of full) pos.push(x, y, z);
  }
  const idx0 = [], idx1 = [];
  const at = (i, j) => i * ring + (j % ring);
  for (let i = 0; i < stations - 1; i++) {
    for (let j = 0; j < ring; j++) {
      const isDark = carve && (DARK_SEGS.has(parts[j]) && DARK_SEGS.has(parts[(j + 1) % ring]));
      const a = at(i, j), b = at(i, j + 1), c = at(i + 1, j), d = at(i + 1, j + 1);
      (isDark ? idx1 : idx0).push(a, b, c, b, d, c);
    }
  }
  if (caps) {
    for (const [i, flip] of [[0, false], [stations - 1, true]]) {
      let cy = 0, cz = 0;
      for (let j = 0; j < ring; j++) {
        cy += pos[at(i, j) * 3 + 1];
        cz += pos[at(i, j) * 3 + 2];
      }
      const centre = pos.length / 3;
      pos.push(xs[i], cy / ring, cz / ring);
      const into = whole ? idx0 : idx1;
      for (let j = 0; j < ring; j++) {
        const a = at(i, j), b = at(i, j + 1);
        into.push(...(flip ? [centre, a, b] : [centre, b, a]));
      }
    }
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.setIndex([...idx0, ...idx1]);
  g.addGroup(0, idx0.length, 0);
  g.addGroup(idx0.length, idx1.length, 1);
  return safeNormals(g);
}

/** The canopy bubble, in car-local coordinates. */
function canopyGeometry() {
  const { x0, x1 } = CAR.COCKPIT;
  const stations = 40, arc = 28;
  const pos = [];
  for (let i = 0; i < stations; i++) {
    const x = lerp(x0 - 0.02, x1 + 0.02, i / (stations - 1));
    const cw = Math.max(0.02, cockpitHalf(Math.min(x1 - 1e-3, Math.max(x0 + 1e-3, x))) + 0.07);
    const base = surfaceTop(x, cw) - 0.02;
    const h = Math.max(0.0, canopyH(x));
    for (let j = 0; j <= arc; j++) {
      const th = (j / arc) * Math.PI;
      const s = Math.sin(th);
      pos.push(x, base + h * Math.pow(s, 0.85), cw * Math.cos(th));
    }
  }
  const idx = [];
  for (let i = 0; i < stations - 1; i++) {
    for (let j = 0; j < arc; j++) {
      const a = i * (arc + 1) + j, b = a + 1, c = a + arc + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return safeNormals(g);
}

function tyreGeometry(r, w) {
  // A rounded section turned about the axle: sidewall, shoulders, tread.
  const rin = 0.72, half = w / 2, k = 0.16;
  const pts = [new T.Vector2(rin, -half + 0.04)];
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    pts.push(new T.Vector2(r - k + Math.sin(a) * k, -half + k - Math.cos(a) * k));
  }
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    pts.push(new T.Vector2(r - k + Math.cos(a) * k, half - k + Math.sin(a) * k));
  }
  pts.push(new T.Vector2(rin, half - 0.04));
  const g = new T.LatheGeometry(pts, 40);
  g.rotateX(Math.PI / 2);
  return g;
}

function wheel(r, side, mats) {
  const g = new T.Group();
  const spinner = new T.Group();
  g.add(spinner);
  const tyre = new T.Mesh(tyreGeometry(r, CAR.TYRE_W), mats.rubber);
  tyre.castShadow = true;
  spinner.add(tyre);
  // An aero wheel: a dark dished face with ten thin spokes behind a rim lip.
  const face = new T.Mesh(new T.CylinderGeometry(0.71, 0.71, 0.08, 40), mats.rim);
  face.rotation.x = Math.PI / 2;
  face.position.z = side * 0.3;
  spinner.add(face);
  const lip = new T.Mesh(new T.TorusGeometry(0.71, 0.035, 8, 40), mats.metal);
  lip.position.z = side * 0.36;
  spinner.add(lip);
  for (let k = 0; k < 10; k++) {
    const spoke = new T.Mesh(new T.BoxGeometry(0.07, 0.62, 0.05), mats.metal);
    const a = (k / 10) * Math.PI * 2;
    spoke.position.set(Math.sin(a) * 0.36, Math.cos(a) * 0.36, side * 0.35);
    spoke.rotation.z = -a;
    spinner.add(spoke);
  }
  const hub = new T.Mesh(new T.CylinderGeometry(0.13, 0.13, 0.12, 16), mats.metal);
  hub.rotation.x = Math.PI / 2;
  hub.position.z = side * 0.37;
  spinner.add(hub);
  // The brake: a disc and a caliper, which do not turn.
  const caliper = new T.Mesh(new T.BoxGeometry(0.42, 0.22, 0.16), mats.caliper);
  caliper.position.set(-0.32, 0.38, side * 0.18);
  caliper.rotation.z = 0.7;
  g.add(caliper);
  return { group: g, spinner };
}

export class Car {
  /**
   * @param {object} o  kind: 'live' | 'parked' | 'wreck'; env: an environment map
   */
  constructor({ kind = 'live', env = null } = {}) {
    this.kind = kind;
    const wreck = kind === 'wreck';
    this.mats = {
      paint: wreck
        ? new T.MeshStandardMaterial({ color: 0x5c5955, roughness: 0.85, metalness: 0.1, envMap: env, envMapIntensity: 0.4 })
        : new T.MeshPhysicalMaterial({ color: 0xf2f2ef, roughness: 0.3, metalness: 0.0, clearcoat: 1.0, clearcoatRoughness: 0.07, envMap: env, envMapIntensity: 1.0 }),
      dark: new T.MeshStandardMaterial({ color: 0x131416, roughness: 0.75, metalness: 0.15, envMap: env, envMapIntensity: 0.4 }),
      glass: new T.MeshPhysicalMaterial({ color: 0x0b0f14, roughness: 0.04, metalness: 0.2, transparent: true, opacity: 0.5, side: T.DoubleSide, envMap: env, envMapIntensity: 1.4, depthWrite: false }),
      rubber: new T.MeshStandardMaterial({ color: 0x141414, roughness: 0.92, envMap: env, envMapIntensity: 0.2 }),
      rim: new T.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.35, metalness: 0.8, envMap: env }),
      metal: new T.MeshStandardMaterial({ color: 0x9da1a6, roughness: 0.25, metalness: 1.0, envMap: env }),
      caliper: new T.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.5, metalness: 0.6, envMap: env }),
      seat: new T.MeshStandardMaterial({ color: 0x1d1e21, roughness: 0.9 }),
      lamp: new T.MeshBasicMaterial({ color: new T.Color(2.2, 2.15, 2.05) }),
      tail: new T.MeshBasicMaterial({ color: new T.Color(3.2, 0.12, 0.08) }),
    };
    this.group = new T.Group(); // placed on the ground, pitched by the program's angle
    this.body = new T.Group(); // rides on the springs
    this.group.add(this.body);

    const bodyGeo = bodyGeometry();
    if (wreck) crumple(bodyGeo, 0.22);
    const body = new T.Mesh(bodyGeo, [this.mats.paint, this.mats.dark]);
    body.castShadow = true;
    body.receiveShadow = true;
    this.body.add(body);
    this.bodyMesh = body;

    // Cockpit: a seat, a dash, a yoke, a screen.
    for (const f of FITTINGS) {
      const m = new T.Mesh(new T.RoundedBoxGeometry(f.h[0] * 2, f.h[1] * 2, f.h[2] * 2, 2, Math.min(0.08, f.h[0] * 0.8)), f.name === 'dash' ? this.mats.dark : this.mats.seat);
      m.position.set(...f.c);
      m.rotation.z = f.rz;
      m.castShadow = true;
      m.receiveShadow = true;
      this.body.add(m);
    }
    const yoke = new T.Mesh(new T.TorusGeometry(0.42, 0.06, 8, 24, Math.PI * 1.3), this.mats.dark);
    yoke.position.set(0.55, 2.0, 0);
    yoke.rotation.set(0, Math.PI / 2, Math.PI * 0.85);
    yoke.rotation.order = 'YXZ';
    yoke.castShadow = true;
    this.body.add(yoke);
    const column = new T.Mesh(new T.CylinderGeometry(0.05, 0.06, 0.6, 8), this.mats.dark);
    column.position.set(0.95, 2.0, 0);
    column.rotation.z = Math.PI / 2;
    column.scale.y = 1.4;
    this.body.add(column);
    this.yokeAt = new T.Vector3(0.55, 2.0, 0);
    // The car's screen: what it says, it says here too.
    this.screen = new T.Mesh(new T.PlaneGeometry(0.62, 0.36), new T.MeshBasicMaterial({ color: 0x0a0c0e, toneMapped: false }));
    this.screen.position.set(1.22, 2.62, 0);
    this.screen.rotation.y = -Math.PI / 2;
    this.screen.rotation.x = -0.35;
    this.body.add(this.screen);

    // The canopy on its hinge.
    const { x1 } = CAR.COCKPIT;
    this.hingeAt = new T.Vector3(x1 + 0.02, surfaceTop(x1, 0.2), 0);
    this.canopy = new T.Group();
    this.canopy.position.copy(this.hingeAt);
    const cg = canopyGeometry();
    cg.translate(-this.hingeAt.x, -this.hingeAt.y, 0);
    const glass = new T.Mesh(cg, this.mats.glass);
    glass.renderOrder = 2;
    this.canopy.add(glass);
    // Its frame, a thin dark rim along the base.
    const rimPts = [];
    for (let i = 0; i <= 48; i++) {
      const t = i / 48;
      const x = lerp(CAR.COCKPIT.x0 + 0.05, x1 - 0.05, t);
      const cw = cockpitHalf(x) + 0.07;
      rimPts.push(new T.Vector3(x, surfaceTop(x, cw), cw));
    }
    for (let i = 48; i >= 0; i--) {
      const p = rimPts[i];
      rimPts.push(new T.Vector3(p.x, p.y, -p.z));
    }
    const frame = new T.Mesh(new T.TubeGeometry(new T.CatmullRomCurve3(rimPts, true), 160, 0.045, 6, true), this.mats.dark);
    frame.geometry.translate(-this.hingeAt.x, -this.hingeAt.y, 0);
    this.canopy.add(frame);
    this.body.add(this.canopy);
    this.canopyOpen = 0;

    // Lamps: slim strips at the nose, a bar across the tail.
    if (!wreck) {
      for (const side of [-1, 1]) {
        const pts = [];
        for (let i = 0; i <= 8; i++) {
          const x = lerp(6.2, 6.86, i / 8);
          const S = section(x);
          const z = S.hw * 0.62;
          pts.push(new T.Vector3(x, surfaceTop(x, z) - 0.03, side * z));
        }
        const strip = new T.Mesh(new T.TubeGeometry(new T.CatmullRomCurve3(pts), 16, 0.035, 6, false), this.mats.lamp);
        this.body.add(strip);
      }
      const tp = [];
      for (let i = 0; i <= 16; i++) {
        const z = lerp(-1.7, 1.7, i / 16);
        // The tail's back face: find x where the section reaches |z|.
        let x = -7.0;
        for (let k = 0; k < 40 && section(x).hw * 0.9 < Math.abs(z) + 0.05; k++) x += 0.01;
        tp.push(new T.Vector3(x - 0.02, 2.18, z));
      }
      const tail = new T.Mesh(new T.TubeGeometry(new T.CatmullRomCurve3(tp), 32, 0.04, 6, false), this.mats.tail);
      this.body.add(tail);
    }

    // Wheels, on their springs.
    this.wheels = [];
    for (const a of CAR.AXLES) {
      for (const side of [-1, 1]) {
        const w = wheel(a.r, side, this.mats);
        w.group.position.set(a.x, a.r, side * CAR.TRACK);
        this.group.add(w.group);
        this.wheels.push({ ...w, x: a.x, r: a.r, z: side * CAR.TRACK, t: 0, tv: 0, spin: 0, contact: false });
      }
    }
    if (wreck) {
      // Two wheels gone, the others askew.
      this.wheels[1].group.visible = false;
      this.wheels[2].group.visible = false;
      this.wheels[0].group.rotation.x = 0.3;
      this.wheels[3].group.rotation.y = 0.4;
    }

    // Thrusters. Main: four under the floor, firing down. Attitude: pairs
    // at the nose and the tail, firing up or down.
    this.mains = [];
    for (const x of [-1.7, 1.7]) {
      for (const z of [-1.15, 1.15]) {
        const ring = new T.Mesh(new T.CylinderGeometry(0.2, 0.27, 0.12, 16, 1, true), this.mats.metal);
        ring.position.set(x, CAR.CLEAR - 0.03, z);
        this.body.add(ring);
        this.mains.push({ at: new T.Vector3(x, CAR.CLEAR - 0.1, z), dir: new T.Vector3(0, -1, 0) });
      }
    }
    this.rcs = { noseUp: [], noseDown: [], tailUp: [], tailDown: [] };
    for (const z of [-1.2, 1.2]) {
      this.rcs.noseUp.push({ at: new T.Vector3(5.9, surfaceTop(5.9, 1.2) + 0.02, z), dir: new T.Vector3(0, 1, 0) });
      this.rcs.noseDown.push({ at: new T.Vector3(5.9, section(5.9).yb - 0.02, z), dir: new T.Vector3(0, -1, 0) });
      this.rcs.tailUp.push({ at: new T.Vector3(-6.2, surfaceTop(-6.2, 1.2) + 0.02, z), dir: new T.Vector3(0, 1, 0) });
      this.rcs.tailDown.push({ at: new T.Vector3(-6.2, section(-6.2).yb - 0.02, z), dir: new T.Vector3(0, -1, 0) });
    }

    // Points on the hull for keeping it out of the ground when it is not
    // on its wheels (tipped over, or wrecked).
    this.hull = [];
    for (let x = -CAR.HALF + 0.15; x <= CAR.HALF - 0.15; x += 0.9) {
      const S = section(x);
      for (let j = 0; j < 16; j++) {
        const [z, y] = ringPoint(S, (j / 16) * Math.PI * 2);
        this.hull.push(new T.Vector3(x, y, z));
      }
    }
    for (const x of [CAR.COCKPIT.x0 + 0.6, -0.6, CAR.COCKPIT.x1 - 0.5]) {
      this.hull.push(new T.Vector3(x, surfaceTop(x, 0.3) + canopyH(x), 0));
    }

    // Body motion on its springs: heave (feet) and its velocity.
    this.heave = 0;
    this.heaveV = 0;
    this.lift = 0;
    this.airborne = true;
    this._v = new T.Vector3();
    this._q = new T.Quaternion();
  }

  setCanopy(open) {
    this.canopyOpen = clamp(open, 0, 1);
    const k = this.canopyOpen;
    this.canopy.rotation.z = -CAR.CANOPY_OPEN * (k * k * (3 - 2 * k));
  }

  /**
   * Put the car where the program says, resting on the ground where the
   * ground is in the way: the wheels take up what they can on their
   * springs, the body is lifted for the rest.
   * @param {number} x, y   the program's position (feet)
   * @param {number} angle  the program's angle, degrees clockwise from up
   * @param {(x:number)=>number} ground  terrain height at x on the flight plane
   * @param {number} dt     seconds
   */
  place(x, y, angle, ground, dt, scale = 1, vy = null) {
    const th = -T.MathUtils.degToRad(angle);
    const c = Math.cos(th), s = Math.sin(th);
    const W = (lx, ly) => [x + (lx * c - ly * s) * scale, y + (lx * s + ly * c) * scale];
    // What each wheel needs, with the body at its nominal height: the
    // compression that would put the tyre on the ground.
    let lift = 0;
    const need = this.wheels.map((w) => {
      if (!w.group.visible || c < 0.25) return -Infinity;
      const [wx, wy] = W(w.x, w.r);
      const req = (ground(wx) + w.r * scale - wy) / (c * scale);
      if (req > CAR.BUMP) lift = Math.max(lift, (req - CAR.BUMP) * c * scale);
      return req;
    });
    // The hull: when the car is on its side, or worse, it rests on that.
    for (const p of this.hull) {
      const [hx, hy] = W(p.x, p.y + this.heave);
      const g = ground(hx);
      if (hy < g + 0.03) lift = Math.max(lift, g + 0.03 - hy);
    }
    const ts = need.map((r) => r - lift / (c * scale || 1));
    const contact = ts.some((t) => t > -CAR.DROOP);
    // Touchdown: the body keeps some of its speed into the springs. The
    // speed is the program's when it is given, else what the motion shows.
    const by = y + lift;
    if (dt > 0) {
      if (this.airborne) {
        if (vy !== null) this.vAir = vy;
        else if (this.lastBy !== undefined) this.vAir = (by - this.lastBy) / dt;
      }
      if (contact && this.airborne && this.vAir < 0) this.heaveV += clamp(this.vAir, -30, 0) * 0.35;
    }
    this.lastBy = by;
    this.airborne = !contact;
    this.lift = lift;
    // The springs, in small steps whatever the frame (a stiff spring taken
    // in one long step blows up), and not for more than a quarter second.
    const span = Math.min(Math.max(dt, 0), 0.25);
    const n = Math.ceil(span / (1 / 240));
    const h = n ? span / n : 0;
    for (let i = 0; i < n; i++) {
      this.heaveV += (-120 * this.heave - 9 * this.heaveV) * h;
      this.heave += this.heaveV * h;
    }
    this.group.position.set(x, by, 0);
    this.group.rotation.set(0, 0, th);
    this.group.scale.setScalar(scale);
    // Wheels: in contact, they sit on the ground; in the air, they hang.
    let maxT = -CAR.DROOP;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      if (!w.group.visible) continue;
      if (ts[i] > -CAR.DROOP) {
        w.t = clamp(ts[i], -CAR.DROOP, CAR.BUMP);
        w.tv = 0;
        w.contact = true;
      } else {
        for (let k = 0; k < n; k++) {
          w.tv += (-(w.t + CAR.DROOP) * 90 - w.tv * 12) * h;
          w.t = clamp(w.t + w.tv * h, -CAR.DROOP, CAR.BUMP);
        }
        w.contact = false;
      }
      maxT = Math.max(maxT, w.t);
      w.group.position.y = w.r + w.t;
    }
    // The body never sinks onto its tyres.
    this.heave = clamp(this.heave, maxT - 0.28, 0.12);
    this.body.position.y = this.heave;
  }

  /** Turn the wheels by distance travelled along the ground. */
  roll(dx) {
    for (const w of this.wheels) {
      w.spin -= dx / w.r;
      w.spinner.rotation.z = w.spin;
    }
  }

  /** World position and direction of a thruster port. */
  port(p, out = new T.Vector3(), dirOut = new T.Vector3()) {
    this.body.updateWorldMatrix(true, false);
    out.copy(p.at).applyMatrix4(this.body.matrixWorld);
    this.body.getWorldQuaternion(this._q);
    dirOut.copy(p.dir).applyQuaternion(this._q);
    return [out, dirOut];
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
  }
}

/** Dent a geometry: push vertices in by noise, for wrecks and debris. */
export function crumple(g, amount, seed = 1) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = Math.sin(x * 2.1 + seed) * Math.sin(y * 3.3 + seed * 2) * Math.sin(z * 2.7 + seed * 3);
    const n2 = Math.sin(x * 5.3 + seed * 5) * Math.sin(z * 4.1);
    p.setY(i, y - Math.abs(n) * amount - n2 * amount * 0.3);
    p.setZ(i, z * (1 - Math.abs(n2) * amount * 0.08));
  }
  p.needsUpdate = true;
  safeNormals(g);
}
