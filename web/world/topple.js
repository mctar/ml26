// The car going over. The program says when it has tipped (SIDEM, ANGLEM,
// BUMPYM) and keeps an angle for the 1973 picture; here the car is a rigid
// body that comes down the way the program brought it in, takes the
// landing, and goes over onto its side, or on over onto its roof. If it
// is going over already, it is let go. Otherwise it is rolled over an
// edge, a wheel catching, a spring giving: not with a blow (at a sixth of
// a g, any blow that rolls a car also throws it into the air) but
// steadily, the edge kept on the ground, up onto two wheels and over the
// balance; from there it falls by itself. Over the way it leans, or down
// the slope, or either way on the flat.

import * as T from '../vendor/three.js';
import { Rigid, STEP, G, boxInertia } from './rigid.js';
import { CAR } from './car.js';

/** Where the car's mass is, in its own frame. */
export const COM = new T.Vector3(-0.1, 1.45, 0);

/** The car as a rigid body: hull points, four wheels. */
export function carBody(car) {
  const points = [];
  // Every third station and every other point round it: enough to sit on.
  const per = 16;
  const stations = car.hull.length - 3;
  for (let i = 0; i < stations; i += per * 3) {
    for (let j = 0; j < per; j += 2) points.push({ p: car.hull[i + j].clone().sub(COM) });
  }
  // The last station, and the tops of the canopy.
  for (let j = 0; j < per; j += 2) points.push({ p: car.hull[stations - per + j].clone().sub(COM) });
  for (let k = stations; k < car.hull.length; k++) points.push({ p: car.hull[k].clone().sub(COM), mu: 0.5 });
  const wheels = [];
  for (const w of car.wheels) {
    if (!w.group.visible) continue;
    wheels.push({ c: new T.Vector3(w.x, w.r, w.z).sub(COM), axis: new T.Vector3(0, 0, 1), r: w.r, hw: CAR.TYRE_W / 2, ref: w });
  }
  return new Rigid({ inertia: boxInertia(14.2, 3.4, 6.4, 0.8), points, wheels, mu: 0.9, e: 0.15, rollMu: 0.8, wheelMu: 1.0 });
}

/** The car's group pose from the body, `k` of the way through its last
 * step (1: where the step left it); or from a pose kept, { x, q }. */
export function poseCar(car, body, scale = 1, k = 1) {
  const { x, q } = body.lerped ? body.lerped(k, _x, _q) : body;
  car.group.quaternion.copy(q);
  car.group.position.copy(COM).multiplyScalar(-scale).applyQuaternion(q).add(x);
  car.group.scale.setScalar(scale);
}
const _x = new T.Vector3(), _q = new T.Quaternion();
const _ax = new T.Vector3(), _pv = new T.Vector3(), _pv2 = new T.Vector3(), _arm = new T.Vector3(), _off = new T.Vector3(), _acr = new T.Vector3();
const _al = new T.Vector3(), _J = new T.Vector3(), _rest = new T.Vector3(), _Y = new T.Vector3(0, 1, 0), _rq = new T.Quaternion();

export class Topple {
  /**
   * @param car    the Car, posed where it touched down
   * @param v      its velocity then, ft/s (world)
   * @param solid  the height of whatever is solid at (x, z)
   * @param seed   a number in 0..1 for the small things
   */
  constructor(car, v, solid, seed = 0.5) {
    this.car = car;
    this.solid = solid;
    this.seed = seed;
    car.group.updateMatrixWorld(true);
    const body = carBody(car);
    body.damp = 1.5; // down on its body, the dust takes a good deal of it
    const q0 = car.group.quaternion.clone();
    body.set(COM.clone().applyQuaternion(q0).add(car.group.position), q0, v, new T.Vector3());
    this.body = body;
    this.acc = 0;
    this.time = 0;
    this.touched = -1; // when it first met the ground
    this.begun = false; // the landing over, the way over chosen
    this.driving = null;
    this.side = 0;
    this.again = false; // tried the other way
    this.events = []; // for the sound and the view: creaks
    this.down = false; // over, and come down on its body
  }

  /** Over its tyres on that side (+1, -1: the car's own z). */
  way(side) {
    const edge = CAR.TRACK + CAR.TYRE_W / 2;
    return { axis: new T.Vector3(side, 0, 0).applyQuaternion(this.body.q).normalize(), pivot: new T.Vector3(0, 0.1, side * edge).sub(COM) };
  }

  /** The landing is over: which way it goes, and if it needs taking. */
  begin() {
    const b = this.body;
    this.begun = true;
    if (b.up().y < 0.4) return; // over already, by itself
    const across = new T.Vector3(0, 0, 1).applyQuaternion(b.q);
    const lean = b.up().dot(across);
    if (Math.abs(lean) > 0.08) this.side = Math.sign(lean);
    else {
      const p = b.x, h = this.solid;
      const dh = h(p.x + across.x * 3, p.z + across.z * 3) - h(p.x - across.x * 3, p.z - across.z * 3);
      this.side = Math.abs(dh) > 0.15 ? -Math.sign(dh) : this.seed < 0.5 ? 1 : -1;
    }
    this.driving = this.start(this.way(this.side), b);
    this.events.push({ kind: 'creak', at: b.x.clone(), k: 1 });
  }

  /** A way, ready to drive a body from where it is now. */
  start(w, b) {
    return { ...w, q0inv: b.q.clone().invert(), steps: 0, slide: null, h0: null, rest: null, spin: null, piv: w.pivot.clone(), on: 'start' };
  }

  /**
   * One step of rolling the body over the way's edge. The body is led:
   * turning about the edge, which stays on the ground and slides on as it
   * was going, slowing as the ground drags at it; or, once its body is
   * down on the ground further out than the tyres (a bump, a bulging
   * side), about that. It turns as fast as an edge on the ground could be
   * held to (faster, and it would come off), and slower toward the top,
   * as a thing thrown up slows, so it comes over slowly and falls from
   * there faster and faster, as things do. Returns false once the centre
   * is past all it rests on: from there it falls by itself.
   */
  roll(b, w) {
    if (++w.steps > 4 / STEP) return false;
    const axis = _ax.copy(w.axis).applyQuaternion(_rq.copy(b.q).multiply(w.q0inv)).normalize();
    const across = _acr.crossVectors(axis, _Y).normalize();
    // What it turns about: the edge, once that is down (leaning the other
    // way on rough ground, it is not, at first); and whatever it rests on
    // that is further out, a good deal further, so as not to flit between
    // points of the same side.
    if (w.on === 'start') {
      const edge = _pv.copy(w.pivot).applyQuaternion(b.q).add(b.x);
      if (edge.y - this.solid(edge.x, edge.z) < 0.3 || !b.contacts.length) w.on = 'edge';
    }
    const pivot = _pv2.copy(w.piv).applyQuaternion(b.q).add(b.x);
    let lead = w.on === 'start' ? -Infinity : pivot.clone().sub(b.x).dot(across);
    for (const c of b.contacts) {
      const a = c.r.dot(across);
      if (a > lead + 0.15) {
        lead = a;
        pivot.copy(b.x).add(c.r);
        w.piv.copy(c.r).applyQuaternion(_rq.copy(b.q).invert());
        w.on = 'body';
      }
    }
    const onEdge = w.on === 'edge';
    if (lead <= 0) return false;
    const arm = _arm.copy(b.x).sub(pivot);
    const off = _off.copy(arm).addScaledVector(axis, -arm.dot(axis)); // the edge to the centre, square to it
    const d = off.length();
    const s = Math.sqrt(Math.max(0.01, 1 - axis.y * axis.y)); // how much of g turns it about the edge
    _al.copy(axis).applyQuaternion(_rq.copy(b.q).invert());
    const ic = (_al.x * _al.x) / b.invI.x + (_al.y * _al.y) / b.invI.y + (_al.z * _al.z) / b.invI.z;
    const hold = 0.85 * Math.sqrt((G * Math.max(0.3 * s, off.y / d)) / d);
    const carry = Math.sqrt(0.35 * 0.35 + (2.4 * G * Math.max(0, d * s - off.y)) / (ic + d * d));
    const target = Math.min(1.1, hold, carry);
    const now = b.w.dot(axis);
    // Its own count of how fast, not what the ground made of it last step.
    if (w.spin === null) w.spin = now;
    const spin = (w.spin += T.MathUtils.clamp(target - w.spin, -2.5 * STEP, 2.5 * STEP));
    // The edge: where it was going, level, slowing; and on the ground.
    if (!w.slide) {
      w.slide = _J.crossVectors(b.w, arm).negate().add(b.v).setY(0).clone();
      w.rest = b.w.clone().addScaledVector(axis, -now);
    }
    if (onEdge && w.h0 === null) w.h0 = Math.max(0, pivot.y - this.solid(pivot.x, pivot.z));
    // What else it was turning with, from the landing: let go of over a
    // third of a second, not at once.
    const rest = _rest.copy(w.rest).multiplyScalar(Math.max(0, 1 - (w.steps * STEP) / 0.35));
    // Nothing touching: the edge is a little above the ground; let it down.
    if (onEdge && !b.contacts.length) w.h0 -= 0.4 * STEP;
    const sl = w.slide.length();
    if (sl > 0) w.slide.multiplyScalar(Math.max(0, sl - 0.9 * G * STEP) / sl);
    const ahead = _J.copy(pivot).addScaledVector(w.slide, STEP);
    const rise = onEdge ? (this.solid(ahead.x, ahead.z) + w.h0 - pivot.y) / STEP : (this.solid(ahead.x, ahead.z) - this.solid(pivot.x, pivot.z)) / STEP;
    b.w.copy(axis).multiplyScalar(spin).add(rest);
    b.v.crossVectors(b.w, arm).add(w.slide);
    b.v.y += rise;
    return true;
  }

  /** Advance by dt seconds of machine time; pose the car. Returns what
   * happened since the last call (blows, creaks), for the sound, the
   * dust and the camera. */
  update(dt) {
    this.acc = Math.min(this.acc + dt, 0.25);
    const b = this.body;
    while (this.acc >= STEP) {
      // Until the blow is over and it is down on the ground again, not in
      // a hop; then over.
      if (!this.begun) {
        if (this.touched < 0 && b.contacts.length) this.touched = this.time;
        const down = this.touched >= 0 && this.time - this.touched >= 0.3 && b.contacts.length >= 3 && Math.abs(b.v.y) < 0.5;
        if (down || this.time > 2.5) this.begin();
      }
      if (this.driving && !this.roll(b, this.driving)) {
        // Caught on something and still up after all that: the other way.
        const stuck = this.driving.steps > 4 / STEP && b.up().y > 0.6;
        this.driving = null;
        if (stuck && !this.again) {
          this.again = true;
          this.driving = this.start(this.way(-this.side), b);
        }
      }
      b.step(this.solid);
      if (this.marks) this.marks.traceBody(b, { scrape: 1.4 });
      // Over the balance and down on its side: the body meets the ground,
      // however gently it came.
      if (this.begun && !this.driving && !this.down) {
        const body = b.contacts.filter((c) => !c.wheel);
        if (body.length) {
          this.down = true;
          const c = body.reduce((a, x) => (x.vin > a.vin ? x : a));
          this.events.push({ kind: 'blow', at: c.r.clone().add(b.x), speed: Math.max(5, c.vin), down: true });
          this.blowAt = this.time;
        }
      }
      this.time += STEP;
      this.acc -= STEP;
    }
    poseCar(this.car, b, 1, this.acc / STEP);
    this.car.freeWheels(b.wheels, dt);
    const ev = this.events;
    // A blow is heard and seen once, not at every step it lasts: the
    // hardest in each quarter second, if it is a blow at all.
    if (b.hits.length && this.time - (this.blowAt ?? -1) > 0.25) {
      const h = b.hits.reduce((a, c) => (c.speed > a.speed ? c : a));
      if (h.speed > 4) {
        this.blowAt = this.time;
        ev.push({ kind: 'blow', at: h.at, speed: h.speed });
      }
    }
    b.hits = [];
    this.events = [];
    return ev;
  }

  get resting() {
    return this.body.asleep;
  }
}
