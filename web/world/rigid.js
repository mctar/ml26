// A rigid body against the ground, for the car when it goes over and for
// the pieces when it comes apart. The ground is a height function with
// everything solid folded into it (the terrain, the boulders, the diner's
// roof, cars left from earlier games). Contacts are points on the body:
// corners of a hull, and wheels, which touch at the lowest point of
// their rim and roll freely along it while gripping across it.
//
// Impulses, not springs: each step the contact points that are in the
// ground get the impulse that stops them going further in (with a little
// bounce for a hard blow and a push back out for what has sunk), and
// friction up to its share of that, solved over the contacts a few times
// round. A fixed step, so that the same start always ends the same way:
// the tip-over chooses its start by trying a few, and what it shows must
// be what it tried.

import * as T from '../vendor/three.js';

export const G = 5.32; // ft/s/s
export const STEP = 1 / 120;

const _P = new T.Vector3(), _r = new T.Vector3(), _n = new T.Vector3(), _u = new T.Vector3(), _a = new T.Vector3();
const _J = new T.Vector3(), _vp = new T.Vector3(), _t1 = new T.Vector3(), _t2 = new T.Vector3(), _q = new T.Quaternion();
const _R = new T.Matrix3(), _m4 = new T.Matrix4();

/** The ground's normal at (x, z) from the height function. */
export function normalAt(solid, x, z, out, e = 0.25) {
  const hx = solid(x + e, z) - solid(x - e, z);
  const hz = solid(x, z + e) - solid(x, z - e);
  return out.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize();
}

export class Rigid {
  /**
   * @param o inertia: [Ixx, Iyy, Izz] about the centre of mass, per unit mass;
   *          points: body-frame contact points, { p, mu, e };
   *          wheels: { c, axis, r, hw } body-frame centre, axle, radius,
   *          half-width; rollMu: rolling friction for the wheels
   */
  constructor({ inertia, points = [], wheels = [], mu = 0.65, e = 0.2, rollMu = 0.04, wheelMu = 0.9, damp = 0 }) {
    this.damp = damp; // on the ground: what ploughing through the dust takes, per second
    this.invI = new T.Vector3(1 / inertia[0], 1 / inertia[1], 1 / inertia[2]);
    this.points = points.map((p) => ({ p: p.p ?? p, mu: p.mu ?? mu, e: p.e ?? e }));
    this.wheels = wheels.map((w) => ({ ...w, mu: w.mu ?? wheelMu, rollMu: w.rollMu ?? rollMu, contact: false, spin: 0 }));
    this.x = new T.Vector3();
    this.q = new T.Quaternion();
    this.v = new T.Vector3();
    this.w = new T.Vector3();
    this.asleep = false;
    this.still = 0;
    this.time = 0;
    this.contacts = [];
    this.hits = []; // blows since last read: { at, speed }
    this.R = new T.Matrix3();
  }

  set(x, q, v, w) {
    this.x.copy(x);
    this.q.copy(q).normalize();
    this.v.copy(v);
    this.w.copy(w);
    this.asleep = false;
    this.still = 0;
    return this;
  }

  /** A copy, for trying a start without disturbing this one. */
  clone() {
    const b = Object.create(Rigid.prototype);
    Object.assign(b, this);
    b.x = this.x.clone();
    b.q = this.q.clone();
    b.v = this.v.clone();
    b.w = this.w.clone();
    b.wheels = this.wheels.map((w) => ({ ...w }));
    b.contacts = [];
    b.hits = [];
    b.R = new T.Matrix3();
    return b;
  }

  /** World inverse inertia applied to u (in place). */
  applyInvI(u) {
    // R diag(invI) R^T u
    const e = this.R.elements;
    const bx = e[0] * u.x + e[1] * u.y + e[2] * u.z;
    const by = e[3] * u.x + e[4] * u.y + e[5] * u.z;
    const bz = e[6] * u.x + e[7] * u.y + e[8] * u.z;
    const ix = bx * this.invI.x, iy = by * this.invI.y, iz = bz * this.invI.z;
    return u.set(e[0] * ix + e[3] * iy + e[6] * iz, e[1] * ix + e[4] * iy + e[7] * iz, e[2] * ix + e[5] * iy + e[8] * iz);
  }

  impulse(r, J) {
    this.v.add(J);
    _u.crossVectors(r, J);
    this.w.add(this.applyInvI(_u));
  }

  /** Effective inverse mass along n at r. */
  kAlong(r, n) {
    _u.crossVectors(r, n);
    this.applyInvI(_u);
    _a.crossVectors(_u, r);
    return 1 + n.dot(_a);
  }

  addContact(P, mu, e, solid, tangent = null, rollMu = 0) {
    const h = solid(P.x, P.z);
    let depth = h - P.y;
    if (depth < -0.01) return null;
    const n = normalAt(solid, P.x, P.z, new T.Vector3());
    // Deep in something with a steep side (a boulder, the diner's wall):
    // that is a wall, met from the side, not ground to be lifted onto.
    if (depth > 1.2 && n.y < 0.5) {
      n.y = 0;
      if (n.lengthSq() < 1e-6) n.set(1, 0, 0);
      n.normalize();
      depth = 0.05;
    } else depth *= n.y;
    const r = P.clone().sub(this.x);
    const c = { r, n, depth, mu, e, jn: 0, j1: 0, j2: 0, roll: tangent ? rollMu : mu };
    // Tangent directions: along the wheel's roll, and across it.
    if (tangent) c.t1 = tangent.clone().addScaledVector(n, -tangent.dot(n)).normalize();
    else {
      c.t1 = Math.abs(n.y) < 0.9 ? new T.Vector3(0, 1, 0).cross(n).normalize() : new T.Vector3(1, 0, 0).cross(n).normalize();
    }
    if (!(c.t1.lengthSq() > 0.5)) c.t1 = new T.Vector3(1, 0, 0).cross(n).normalize();
    c.t2 = new T.Vector3().crossVectors(n, c.t1);
    c.kn = 1 / this.kAlong(r, n);
    c.k1 = 1 / this.kAlong(r, c.t1);
    c.k2 = 1 / this.kAlong(r, c.t2);
    // How fast it is going in, for the bounce and for the blow.
    _vp.crossVectors(this.w, r).add(this.v);
    const vn = _vp.dot(n);
    c.target = vn < -1.5 ? -vn * e : 0;
    c.target = Math.max(c.target, Math.min(2, (Math.max(0, depth - 0.02) * 0.25) / STEP));
    c.vin = -vn;
    this.contacts.push(c);
    return c;
  }

  step(solid) {
    const dt = STEP;
    this.time += dt;
    if (this.asleep) return;
    this.v.y -= G * dt;
    this.R.setFromMatrix4(_m4.makeRotationFromQuaternion(this.q));
    this.contacts.length = 0;
    // The hull.
    for (const pt of this.points) {
      _P.copy(pt.p).applyMatrix3(this.R).add(this.x);
      this.addContact(_P, pt.mu, pt.e, solid);
    }
    // The wheels: the lowest point of each tyre's edges.
    for (const wh of this.wheels) {
      wh.contact = false;
      const C = _P.copy(wh.c).applyMatrix3(this.R).add(this.x).clone();
      const a = _a.copy(wh.axis).applyMatrix3(this.R).normalize().clone();
      const d = new T.Vector3(0, -1, 0).addScaledVector(a, a.y); // down, in the wheel's plane
      if (d.lengthSq() < 1e-4) d.set(1, 0, 0).cross(a);
      d.normalize();
      const roll = new T.Vector3().crossVectors(a, d); // the way the rim moves at the bottom
      for (const s of [-1, 1]) {
        const P = C.clone().addScaledVector(d, wh.r).addScaledVector(a, s * wh.hw);
        const c = this.addContact(P, wh.mu, 0.25, solid, roll, wh.rollMu);
        if (c) {
          c.wheel = wh;
          wh.contact = true;
        }
      }
      // Turning freely, or with the ground.
      if (wh.contact) {
        _vp.crossVectors(this.w, C.clone().sub(this.x)).add(this.v);
        wh.spin = -_vp.dot(roll) / wh.r;
      } else wh.spin *= 1 - dt * 0.05;
    }
    // Solve.
    let blow = 0, blowAt = null;
    for (const c of this.contacts) {
      if (c.vin > blow) {
        blow = c.vin;
        blowAt = c.r;
      }
    }
    for (let it = 0; it < 8; it++) {
      for (const c of this.contacts) {
        _vp.crossVectors(this.w, c.r).add(this.v);
        const vn = _vp.dot(c.n);
        let jn = Math.max(0, c.jn + (c.target - vn) * c.kn);
        let dj = jn - c.jn;
        c.jn = jn;
        if (dj !== 0) this.impulse(c.r, _J.copy(c.n).multiplyScalar(dj));
        // Friction, each way, within what the contact carries.
        _vp.crossVectors(this.w, c.r).add(this.v);
        const lim1 = c.roll * c.jn, lim2 = c.mu * c.jn;
        let j1 = Math.max(-lim1, Math.min(lim1, c.j1 - _vp.dot(c.t1) * c.k1));
        dj = j1 - c.j1;
        c.j1 = j1;
        if (dj !== 0) this.impulse(c.r, _J.copy(c.t1).multiplyScalar(dj));
        _vp.crossVectors(this.w, c.r).add(this.v);
        const j2 = Math.max(-lim2, Math.min(lim2, c.j2 - _vp.dot(c.t2) * c.k2));
        dj = j2 - c.j2;
        c.j2 = j2;
        if (dj !== 0) this.impulse(c.r, _J.copy(c.t2).multiplyScalar(dj));
      }
    }
    if (blow > 2.5) this.hits.push({ at: blowAt.clone().add(this.x), speed: blow });
    if (this.damp && this.contacts.length) {
      const k = Math.max(0, 1 - this.damp * dt);
      this.w.multiplyScalar(k);
      this.v.x *= k;
      this.v.z *= k;
    }
    // Integrate.
    this.x.addScaledVector(this.v, dt);
    const wl = this.w.length();
    if (wl > 1e-6) {
      _q.setFromAxisAngle(_u.copy(this.w).divideScalar(wl), wl * dt);
      this.q.premultiply(_q).normalize();
    }
    // At rest: still, on the ground, for a while.
    if (this.contacts.length && this.v.lengthSq() < 0.01 && this.w.lengthSq() < 0.0025) this.still += dt;
    else this.still = 0;
    if (this.still > 0.6) {
      this.asleep = true;
      this.v.set(0, 0, 0);
      this.w.set(0, 0, 0);
    }
  }

  /** The body's up, in the world. */
  up(out = new T.Vector3()) {
    return out.set(0, 1, 0).applyQuaternion(this.q);
  }
}

/** Unit-mass inertia of a box of these sizes, a little lighter at the ends. */
export function boxInertia(sx, sy, sz, k = 1) {
  return [(k * (sy * sy + sz * sz)) / 12, (k * (sx * sx + sz * sz)) / 12, (k * (sx * sx + sy * sy)) / 12];
}
