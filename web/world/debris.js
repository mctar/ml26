// A crash. The program calls it from where it judges the car too low over
// something (fifteen feet over a boulder, twenty-six over a car left from
// an earlier game, thirty over the diner, nothing over bare ground), and
// stops drawing the ship. Here the car comes on as it was going until it
// meets what is there; then it comes apart.
//
// What breaks it is the car itself: the gas tanks for the jets go, and
// the battery. A flash, and a puff of gas that is gone in a blink (it
// expands into nothing and there is no air to hold it). The body tears
// into a few pieces, the wheels come off and roll, the canopy shatters,
// small pieces fly. The gas drives the dust off the ground in a sheet,
// and the blow throws regolith up and out on arcs at a sixth of a g; it
// all comes down where it comes down, and the ground it lands on is
// lighter afterwards. Hit fast, the car digs a crater (the program does
// that) and the ejecta go up in a curtain, more of it down range. No
// smoke, no fireball: nothing to burn, nothing to make a cloud of.

import * as T from '../vendor/three.js';
import { bodyGeometry, crumple, CAR, safeNormals } from './car.js';
import { Ballistic, rng } from './ballistic.js';
import { Rigid, STEP, G, boxInertia } from './rigid.js';
import { carBody, poseCar, COM } from './topple.js';

const _v = new T.Vector3(), _q = new T.Quaternion(), _m = new T.Matrix4();

/** Tear a slice's cut ends: push the cut faces in and out by a noise of
 * where they are, so the pieces do not look sawn. */
function tear(g, x0, x1, seed) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const jag = Math.abs(0.42 * Math.sin(y * 3.7 + seed) * Math.sin(z * 2.9 + seed * 1.7) + 0.22 * Math.sin(z * 8.3 + y * 6.1 + seed * 3.1));
    if (Math.abs(x - x0) < 0.05 && x0 > -CAR.HALF + 0.1) p.setX(i, x + jag);
    else if (Math.abs(x - x1) < 0.05 && x1 < CAR.HALF - 0.1) p.setX(i, x - jag);
  }
  p.needsUpdate = true;
}

/** Damage a piece the way a blow does: a few broad dents, each pushing
 * the skin in about a point, and a bend through the whole piece. */
function dent(g, R, depth) {
  const p = g.attributes.position;
  g.computeBoundingBox();
  const bb = g.boundingBox, c = bb.getCenter(new T.Vector3()), size = bb.getSize(new T.Vector3());
  const dents = [];
  for (let k = 0; k < 3; k++) {
    const at = new T.Vector3(bb.min.x + size.x * R(), bb.max.y - size.y * 0.3 * R(), bb.min.z + size.z * R());
    dents.push({ at, r: 0.8 + 1.2 * R(), d: depth * (0.5 + R()) });
  }
  const bend = (R() - 0.5) * depth * 0.6;
  const a = p.array;
  for (let i = 0; i < a.length; i += 3) {
    let x = a[i], y = a[i + 1], z = a[i + 2];
    for (const d of dents) {
      const dx = x - d.at.x, dy = y - d.at.y, dz = z - d.at.z;
      const f = 1 - Math.sqrt(dx * dx + dy * dy + dz * dz) / d.r;
      if (f > 0) {
        // In toward the middle of the piece.
        const ix = c.x - x, iy = c.y - y, iz = c.z - z;
        const l = Math.sqrt(ix * ix + iy * iy + iz * iz) || 1;
        const k = (d.d * f * f * (3 - 2 * f)) / l;
        x += ix * k;
        y += iy * k;
        z += iz * k;
      }
    }
    const u = (x - c.x) / Math.max(0.5, size.x * 0.5);
    a[i] = x;
    a[i + 1] = y + bend * u * u;
    a[i + 2] = z;
  }
  p.needsUpdate = true;
}

/** A small torn piece of panel: a few points round a bent plate. */
function shard(size, R) {
  const n = 4 + Math.floor(R() * 3);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + R() * 0.6;
    const r = size * (0.45 + 0.55 * R());
    pts.push(new T.Vector3(Math.cos(a) * r, (R() - 0.5) * size * 0.25, Math.sin(a) * r * (0.5 + 0.5 * R())));
  }
  const pos = [];
  for (let i = 1; i < n - 1; i++) pos.push(pts[0], pts[i], pts[i + 1]);
  const g = new T.BufferGeometry().setFromPoints(pos);
  return safeNormals(g);
}

/** Where a grain thrown from p at v comes down on `solid`: the height
 * there, below which it is gone. Coarse, which is all it needs. */
function landing(p, v, solid) {
  // When it comes down to height h, after rising first.
  const when = (h) => (v.y + Math.sqrt(Math.max(0, v.y * v.y + 2 * G * (p.y - h)))) / G;
  let h = solid(p.x, p.z), t = when(h);
  for (let k = 0; k < 2; k++) {
    h = solid(p.x + v.x * t, p.z + v.z * t);
    t = when(h);
  }
  return { floor: h - 0.05, t };
}

/**
 * What a crash draws with, made once when the page loads so that nothing
 * has to be built (or compiled for the GPU) at the moment it happens: the
 * particle rings, and the materials for the torn pieces. Kept in the scene
 * with nothing in flight.
 */
export class CrashKit {
  constructor(scene, car) {
    this.puff = new Ballistic(scene, { n: 500, color: [0.9, 0.93, 1.0], opacity: 0.035, additive: true, streak: 0.001, g: 0, order: 5 });
    this.sheet = new Ballistic(scene, { n: 6000, color: [0.98, 0.95, 0.9], opacity: 0.13, streak: 0.03 });
    this.ejecta = new Ballistic(scene, { n: 18000, color: [0.56, 0.54, 0.5], opacity: 0.38, streak: 0.012 });
    this.clods = new Ballistic(scene, { n: 900, color: [0.42, 0.4, 0.37], opacity: 0.95, streak: 0.006 });
    this.sparks = new Ballistic(scene, { n: 220, color: [2.2, 0.95, 0.32], opacity: 0.95, additive: true, streak: 0.025, cool: 1, order: 6 });
    this.all = [this.puff, this.sheet, this.ejecta, this.clods, this.sparks];
    // The body in the slices it tears into, gently or fast.
    this.cuts = { gentle: [-CAR.HALF, -2.8, 1.6, CAR.HALF], hard: [-CAR.HALF, -4.4, -1.9, 0.5, 3.0, CAR.HALF] };
    this.slices = {};
    for (const [k, cuts] of Object.entries(this.cuts)) {
      this.slices[k] = [];
      for (let i = 0; i < cuts.length - 1; i++) this.slices[k].push(bodyGeometry({ x0: cuts[i], x1: cuts[i + 1], stations: 26, caps: false }));
    }
    // Torn open, the pieces show their insides.
    this.paint = car.mats.paint.clone();
    this.dark = car.mats.dark.clone();
    this.paint.side = this.dark.side = T.DoubleSide;
    this.glass = car.mats.glass.clone();
    this.glass.opacity = 0.7;
    this.glass.depthWrite = true;
    // A speck of each, out of sight below the ground, so the GPU has
    // their programs before they are needed.
    this.warm = new T.Group();
    const tri = new T.BufferGeometry().setFromPoints([new T.Vector3(), new T.Vector3(0.01, 0, 0), new T.Vector3(0, 0.01, 0)]);
    for (const m of [this.paint, this.dark, this.glass]) {
      const mesh = new T.Mesh(tri, m);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      this.warm.add(mesh);
    }
    this.warm.position.y = -5000;
    scene.add(this.warm);
    this.fresh = 3;
    this.practise();
  }

  /** Each frame with no crash: drawn for the first few (so that the GPU
   * compiles all of it at the start), then not at all. */
  idle() {
    if (this.fresh > 0 && --this.fresh > 0) return;
    for (const b of this.all) b.mesh.visible = false;
    this.warm.visible = false;
  }

  /** Run the work a crash does once, on nothing, so that the browser has
   * it compiled before the first real one (a cold first run of it costs a
   * visible pause). */
  practise() {
    const R = rng(7);
    for (const slices of Object.values(this.slices)) {
      for (const s of slices) {
        const g = s.clone();
        dent(g, R, 0.3);
        tear(g, -1, 1, 1);
        safeNormals(g);
        g.computeBoundingBox();
        g.dispose();
      }
    }
    const flat = () => 0;
    const p = new T.Vector3(), v = new T.Vector3();
    for (let i = 0; i < 400; i++) {
      p.set(R(), 0.1, R());
      v.set(R() - 0.5, 1 + R(), R() - 0.5).multiplyScalar(20);
      landing(p, v, flat);
      const g = shard(0.3, R);
      g.dispose();
    }
    const body = new Rigid({ inertia: [1, 1, 1], points: [{ p: new T.Vector3(0.5, 0.5, 0.5) }, { p: new T.Vector3(-0.5, -0.5, -0.5) }], mu: 0.8, e: 0.2, damp: 1.8 });
    body.set(new T.Vector3(0, 1, 0), new T.Quaternion(), new T.Vector3(3, 0, 1), new T.Vector3(1, 2, 3));
    for (let i = 0; i < 300; i++) body.step(flat);
  }

  clear() {
    for (const b of this.all) {
      b.clear();
      b.time = 0;
      b.uniforms.uTime.value = 0;
    }
  }
}

class Piece {
  constructor(object, body) {
    this.o = object;
    this.body = body;
    this.big = false; // one the eye follows: the body, the wheels, the seat, the frame
  }

  /** Drawn `k` of the way through the body's last step. */
  pose(k = 1) {
    const { x, q } = this.body.lerped(k, this.o.position, this.o.quaternion);
    this.o.position.copy(x);
    this.o.quaternion.copy(q);
  }
}

export class Crash {
  /**
   * @param o scene; car (the Car, as drawn now); v its velocity (ft/s);
   *          random (seeded); solid (height of whatever is solid at x, z);
   *          ground (the terrain alone)
   */
  constructor({ scene, car, kit, v, random, solid, ground, aim = null }) {
    this.kit = kit;
    this.scene = scene;
    this.car = car;
    this.R = random;
    this.solid = solid;
    this.ground = ground;
    this.group = new T.Group();
    scene.add(this.group);
    this.pieces = [];
    this.effects = [];
    this.time = 0;
    this.acc = 0;
    this.events = [];
    // Coming on as it was going, turning as it was not.
    car.group.updateMatrixWorld(true);
    this.body = carBody(car);
    const q = car.group.quaternion.clone();
    this.body.set(COM.clone().applyQuaternion(q).add(car.group.position), q, v, new T.Vector3());
    // Over a car left from an earlier game: the program counts it as under
    // this one, but here it may lie a few yards off, so drift onto it.
    if (aim) {
      const x = this.body.x, h = Math.max(0, x.y - COM.y - aim.top);
      const down = Math.max(0, -v.y);
      const t = Math.max(0.3, (-down + Math.sqrt(down * down + 2 * G * h)) / G);
      const side = (d) => Math.max(-12, Math.min(12, d / t));
      this.body.v.x = side(aim.x - x.x);
      this.body.v.z = side(aim.z - x.z);
    }
    this.burst = null;
  }

  /** Machine seconds; returns what happened (for the view and the sound). */
  update(dt) {
    this.acc = Math.min(this.acc + dt, 0.25);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      this.time += STEP;
      if (!this.burst) {
        this.body.step(this.solid);
        // The first blow, or long enough: it goes.
        if (this.body.contacts.length || this.time > 3) this.breakUp();
      } else {
        for (const p of this.pieces) p.body.step(this.solid);
      }
    }
    const k = this.acc / STEP;
    if (!this.burst) {
      poseCar(this.car, this.body, 1, k);
      this.car.freeWheels(this.body.wheels, dt);
    } else {
      for (const p of this.pieces) p.pose(k);
      // The particles by the same clock, not stepwise.
      const t = this.time + this.acc - this.burst.time;
      if (this.jobs.length) this.pump(t, 5);
      for (const e of this.effects) e.update(t);
    }
    const ev = this.events;
    this.events = [];
    return ev;
  }

  /**
   * What the camera should keep in the picture: where it hit, and the big
   * pieces where they are and where they will be in a moment (so it is
   * already drawing back when they fly).
   */
  framePoints(ahead = 0.6) {
    const out = [];
    if (!this.burst) return out;
    out.push(this.burst.at);
    for (const p of this.pieces) {
      if (!p.big) continue;
      const b = p.body;
      out.push(b.x);
      if (b.asleep) continue;
      const q = b.x.clone().addScaledVector(b.v, ahead);
      q.y = Math.max(q.y - 0.5 * G * ahead * ahead, this.solid(q.x, q.z));
      out.push(q);
    }
    return out;
  }

  breakUp() {
    const R = this.R, car = this.car, b = this.body;
    poseCar(car, b);
    car.group.updateMatrixWorld(true);
    // Where it hit and how hard.
    const hit = b.contacts.length ? b.contacts.reduce((a, c) => (c.vin > a.vin ? c : a)) : null;
    const at = hit ? hit.r.clone().add(b.x) : b.x.clone().setY(this.solid(b.x.x, b.x.z));
    const n = hit ? hit.n.clone() : new T.Vector3(0, 1, 0);
    const speed = b.v.length();
    const hard = speed > 60;
    this.burst = { time: this.time, at, hard, speed };
    this.events.push({ kind: 'burst', at: at.clone(), hard, speed });
    const centre = b.x.clone();
    const vIn = b.v.clone();
    const vn = vIn.dot(n);
    const vt = vIn.clone().addScaledVector(n, -vn);
    // What each piece leaves with: what the car had where it was, the
    // blow taken out of it, and the burst.
    const keep = hard ? 0.3 : 0.6;
    const vMax = hard ? 55 : 30;
    const leave = (p, kick, up) => {
      const v = vt.clone().multiplyScalar(keep * (0.6 + 0.6 * R()));
      if (v.length() > vMax) v.setLength(vMax * (0.7 + 0.3 * R()));
      v.addScaledVector(n, Math.max(0, -vn) * (0.1 + 0.25 * R()));
      const out = p.clone().sub(centre);
      out.y = Math.max(out.y, 0) + 0.6;
      out.add(new T.Vector3(R() - 0.5, R() - 0.5, R() - 0.5).multiplyScalar(1.2)).normalize();
      v.addScaledVector(out, kick * (0.6 + 0.8 * R()));
      v.y += up * (0.5 + R());
      // Not so high, nor so far, that it is still in the air, or out of
      // the picture, when the program starts the next game: a few seconds
      // up and down at a sixth of a g. Softly, so they do not all go
      // alike.
      const soft = (x, m) => m * Math.tanh(x / m);
      const along = Math.hypot(v.x, v.z), farMax = hard ? 30 : 18;
      if (along > 0) {
        const k = soft(along, farMax) / along;
        v.x *= k;
        v.z *= k;
      }
      if (v.y > 0) v.y = soft(v.y, hard ? 15 : 11);
      return v;
    };
    const spin = (k) => new T.Vector3(R() - 0.5, R() - 0.5, R() - 0.5).multiplyScalar(2 * k);
    const M = car.body.matrixWorld;
    const Q = new T.Quaternion().setFromRotationMatrix(_m.extractRotation(M));
    const add = (mesh, body, p, v, w) => {
      // Centre the mesh on what it turns about.
      mesh.geometry.computeBoundingBox();
      const c = mesh.geometry.boundingBox.getCenter(new T.Vector3());
      mesh.geometry.translate(-c.x, -c.y, -c.z);
      const holder = new T.Group();
      holder.add(mesh);
      this.group.add(holder);
      const world = p.clone().add(c.clone().applyQuaternion(Q));
      body.set(world, Q, v, w);
      const piece = new Piece(holder, body);
      piece.pose();
      this.pieces.push(piece);
      return piece;
    };
    const boxBody = (geo, mu = 0.8, e = 0.25, maxSpin = 9) => {
      geo.computeBoundingBox();
      const s = geo.boundingBox.getSize(new T.Vector3());
      const h = s.clone().multiplyScalar(0.5);
      const pts = [];
      // The corners; and for a big piece the middles of its edges and
      // faces too, so it does not sink into a boulder between corners.
      const big = Math.max(s.x, s.y, s.z) > 1.5;
      for (let i = 0; i < 27; i++) {
        const u = [(i % 3) - 1, (Math.floor(i / 3) % 3) - 1, Math.floor(i / 9) - 1];
        const zeros = u.filter((c) => c === 0).length;
        if (zeros === 3 || (zeros > 0 && !big)) continue;
        pts.push({ p: new T.Vector3(u[0] * h.x, u[1] * h.y, u[2] * h.z) });
      }
      return new Rigid({ inertia: boxInertia(Math.max(s.x, 0.1), Math.max(s.y, 0.1), Math.max(s.z, 0.1)), points: pts, mu, e, damp: 1.8, maxSpin });
    };

    const paint = this.kit.paint, dark = this.kit.dark;
    // The body, torn in a few places, each piece dented its own way.
    const cuts = this.kit.cuts[hard ? 'hard' : 'gentle'];
    for (let i = 0; i < cuts.length - 1; i++) {
      const x0 = cuts[i], x1 = cuts[i + 1];
      const g = this.kit.slices[hard ? 'hard' : 'gentle'][i].clone();
      dent(g, R, hard ? 0.55 : 0.32);
      tear(g, x0, x1, R() * 10);
      safeNormals(g);
      const m = new T.Mesh(g, [paint, dark]);
      m.castShadow = true;
      m.receiveShadow = true;
      const p = new T.Vector3().applyMatrix4(M);
      const v = leave(new T.Vector3((x0 + x1) / 2, 1.4, 0).applyMatrix4(M), hard ? 6 : 3.5, 2);
      const body = boxBody(g, 0.85, 0.2, 5);
      add(m, body, p, v, spin(hard ? 2.5 : 1.2).add(b.w)).big = true;
    }
    // The wheels, whole, turning: they roll off where they land.
    for (const w of car.wheels) {
      if (!w.group.visible) continue;
      const wg = w.group.clone(true);
      wg.traverse((o) => (o.userData.shared = true)); // its geometry is the car's
      w.group.updateMatrixWorld(true);
      const p = new T.Vector3().setFromMatrixPosition(w.group.matrixWorld);
      wg.position.set(0, 0, 0);
      wg.quaternion.identity();
      const holder = new T.Group();
      holder.add(wg);
      this.group.add(holder);
      // Rolling on its tread; lying down or tipping, on the rims' edges.
      const rim = [];
      for (let a = 0; a < 12; a++) {
        for (const s of [-1, 1]) rim.push({ p: new T.Vector3(Math.cos((a / 12) * 2 * Math.PI) * w.r, Math.sin((a / 12) * 2 * Math.PI) * w.r, (s * CAR.TYRE_W) / 2), mu: 0.8, e: 0.2 });
      }
      const body = new Rigid({ inertia: [(3 * w.r * w.r + 0.85) / 12, (3 * w.r * w.r + 0.85) / 12, (w.r * w.r) / 2], points: rim, wheels: [{ c: new T.Vector3(), axis: new T.Vector3(0, 0, 1), r: w.r, hw: CAR.TYRE_W / 2, rollMu: 0.3, mu: 0.8 }], damp: 0.4 });
      const v = leave(p, hard ? 7 : 3, 1.2);
      const axle = new T.Vector3(0, 0, 1).applyQuaternion(Q);
      const wv = spin(hard ? 3 : 1.5).addScaledVector(axle, -(v.x / w.r) * 0.8);
      body.set(p, new T.Quaternion().setFromRotationMatrix(_m.extractRotation(w.group.matrixWorld)), v, wv);
      const piece = new Piece(holder, body);
      piece.big = true;
      piece.pose();
      this.pieces.push(piece);
    }
    // The canopy's frame, bent, and its glass in pieces.
    const frame = car.canopy.children.find((c) => c.geometry && c.geometry.type === 'TubeGeometry');
    if (frame) {
      const g = frame.geometry.clone();
      g.translate(car.hingeAt.x, car.hingeAt.y, 0);
      crumple(g, 0.12, 5 + R() * 5);
      const m = new T.Mesh(g, car.mats.dark);
      m.castShadow = true;
      const p = new T.Vector3().applyMatrix4(M);
      add(m, boxBody(g, 0.7, 0.3, 8), p, leave(new T.Vector3(-0.7, 3.2, 0).applyMatrix4(M), 4, 1.5), spin(3)).big = true;
    }
    const glass = this.kit.glass;
    for (let i = 0; i < (hard ? 22 : 14); i++) {
      const g = shard(0.18 + 0.32 * R(), R);
      const m = new T.Mesh(g, glass);
      const lp = new T.Vector3(CAR.COCKPIT.x0 + (CAR.COCKPIT.x1 - CAR.COCKPIT.x0) * R(), 3.1 + R() * 0.7, (R() - 0.5) * 2.6);
      const p = lp.applyMatrix4(M);
      add(m, boxBody(g, 0.5, 0.35), p, leave(p, 12 + 8 * R(), 4), spin(10));
    }
    // The seat, and small torn pieces of panel, white and dark.
    for (const f of car.body.children.filter((c) => c.material === car.mats.seat)) {
      const g = f.geometry.clone();
      const mm = new T.Matrix4().compose(f.position, f.quaternion, f.scale);
      g.applyMatrix4(mm);
      const m = new T.Mesh(g, f.material);
      m.castShadow = true;
      const p = new T.Vector3().applyMatrix4(M);
      add(m, boxBody(g, 0.9, 0.2, 8), p, leave(f.position.clone().applyMatrix4(M), 7, 3), spin(3)).big = true;
    }
    for (let i = 0; i < (hard ? 46 : 22); i++) {
      const dark = R() < 0.35;
      const g = shard(0.2 + 0.45 * R() * R(), R);
      crumple(g, 0.05, R() * 9);
      const m = new T.Mesh(g, dark ? this.kit.dark : this.kit.paint);
      m.castShadow = true;
      const lx = (R() - 0.5) * 2 * (CAR.HALF - 0.5), lz = (R() - 0.5) * 3;
      const p = new T.Vector3(lx, 1.0 + R() * 1.6, lz).applyMatrix4(M);
      add(m, boxBody(g, 0.8, 0.3), p, leave(p, 9 + 12 * R(), 3), spin(9));
    }
    this.effectsAt(at, n, vt, hard, speed, centre);
  }

  effectsAt(at, n, vt, hard, speed, centre) {
    const R = this.R, solid = this.solid;
    const gy = this.ground(at.x, at.z);
    const down = vt.lengthSq() > 1 ? vt.clone().setY(0).normalize() : new T.Vector3(1, 0, 0);
    const kit = this.kit;
    kit.clear();
    // Thrown over the first few frames rather than all at once: the blow
    // goes on digging for a moment, and the page does not stop for it.
    this.jobs = [];
    const throwOf = (ball, count, make) => {
      this.jobs.push({ ball, count, make, i: 0 });
      if (!this.effects.includes(ball)) this.effects.push(ball);
    };
    // The gas: a white puff that opens and is gone.
    throwOf(kit.puff, 500, (p, v) => {
      p.copy(centre);
      v.set(R() - 0.5, R() * 0.8 - 0.15, R() - 0.5).normalize().multiplyScalar(25 + 70 * R());
      return [0.08 + 0.18 * R(), 0.25 + 0.45 * R(), 1, gy - 2];
    });
    // The sheet: the gas drives the dust off the ground, fast and flat.
    throwOf(kit.sheet, 6000, (p, v) => {
      const a = R() * Math.PI * 2;
      const r = 1.5 + 4 * R();
      p.set(at.x + Math.cos(a) * r, 0, at.z + Math.sin(a) * r);
      const g = this.ground(p.x, p.z);
      p.y = g + 0.08;
      const el = (1 + 7 * R()) * (Math.PI / 180);
      const sp = (hard ? 90 : 50) + 140 * R() * R();
      v.set(Math.cos(a) * Math.cos(el) * sp, Math.sin(el) * sp, Math.sin(a) * Math.cos(el) * sp);
      return [0.25 + 0.7 * R(), 0.03 + 0.03 * R(), 0.7 + 0.5 * R(), g - 0.6];
    });
    // The regolith the blow throws: fine grains on arcs, and clods. Fast,
    // it is a curtain, most of it down range.
    const grains = hard ? 18000 : 2600;
    throwOf(kit.ejecta, grains, (p, v) => {
      let a = R() * Math.PI * 2;
      if (hard && R() < 0.45) a = Math.atan2(down.z, down.x) + (R() - 0.5) * 1.6;
      const el = (hard ? 35 + 30 * R() : 30 + 45 * R()) * (Math.PI / 180);
      const sp = hard ? 8 + 110 * Math.pow(R(), 2.2) : 3 + 12 * Math.pow(R(), 1.6);
      const r = (hard ? 6 : 2.5) * Math.sqrt(R());
      p.set(at.x + Math.cos(a) * r, 0, at.z + Math.sin(a) * r);
      p.y = Math.max(this.ground(p.x, p.z), at.y - 0.3) + 0.1;
      v.set(Math.cos(a) * Math.cos(el) * sp, Math.sin(el) * sp, Math.sin(a) * Math.cos(el) * sp);
      return [60, 0.025 + 0.05 * R(), 0.55 + 0.6 * R()];
    });
    const clods = hard ? 900 : 160;
    throwOf(kit.clods, clods, (p, v) => {
      const a = R() * Math.PI * 2;
      const el = (25 + 50 * R()) * (Math.PI / 180);
      const sp = hard ? 6 + 50 * Math.pow(R(), 2) : 3 + 10 * Math.pow(R(), 1.6);
      p.set(at.x + Math.cos(a) * 1.5 * R(), 0, at.z + Math.sin(a) * 1.5 * R());
      p.y = Math.max(this.ground(p.x, p.z), at.y - 0.3) + 0.15;
      v.set(Math.cos(a) * Math.cos(el) * sp, Math.sin(el) * sp, Math.sin(a) * Math.cos(el) * sp);
      return [60, 0.07 + 0.14 * R(), 0.6 + 0.6 * R()];
    });
    // Hot fragments from the battery, cooling as they go.
    const sparks = hard ? 220 : 90;
    throwOf(kit.sparks, sparks, (p, v) => {
      p.copy(centre);
      v.set(R() - 0.5, R() * 0.9, R() - 0.5).normalize().multiplyScalar(12 + 55 * R());
      return [0.3 + 1.1 * R() * R(), 0.02 + 0.025 * R(), 0.6 + 0.6 * R()];
    });
    // The puff and the sheet now, the rest as it comes.
    this.pump(0, Infinity, 2);
  }

  /** Throw what is waiting to be thrown, for up to `ms` (or just the
   * first `jobs` of them, whole), born at `t` after the blow. */
  pump(t, ms, jobs = Infinity) {
    const t0 = performance.now();
    const p = new T.Vector3(), v = new T.Vector3();
    for (const [k, j] of this.jobs.entries()) {
      if (k >= jobs) break;
      j.ball.time = t;
      while (j.i < j.count) {
        const [life, size, shade, floor] = j.make(p, v);
        if (floor === undefined) {
          const l = landing(p, v, this.solid);
          j.ball.throw(p, v, Math.min(life, l.t + 0.3), size, l.floor, shade);
        } else j.ball.throw(p, v, life, size, floor, shade);
        j.i++;
        if ((j.i & 127) === 0 && performance.now() - t0 > ms) break;
      }
      j.ball.update(t);
      if (performance.now() - t0 > ms) break;
    }
    this.jobs = this.jobs.filter((j) => j.i < j.count);
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry && !o.userData.shared) o.geometry.dispose();
    });
    // The kit stays for the next one, emptied.
    this.kit.clear();
  }
}
