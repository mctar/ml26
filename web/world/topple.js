// The car going over. The program says when it has tipped (SIDEM, ANGLEM,
// BUMPYM) and keeps an angle for the 1973 picture; here the car is a rigid
// body that comes down the way the program brought it in, and falls the
// way a car falls: over its wheels onto its side or its roof, end over end
// if it came in fast and nose down. Where the ground alone would leave it
// on its wheels, it is given the smallest push that will not: a wheel
// catching, a spring giving. The push is found by running the few
// candidates through to rest while the car takes the blow, before it is
// given, so what is shown is one of them, step for step.

import * as T from '../vendor/three.js';
import { Rigid, STEP, boxInertia } from './rigid.js';
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

/** The car's group pose from the body. */
export function poseCar(car, body, scale = 1) {
  car.group.quaternion.copy(body.q);
  car.group.position.copy(COM).multiplyScalar(-scale).applyQuaternion(body.q).add(body.x);
  car.group.scale.setScalar(scale);
}

export class Topple {
  /**
   * @param car    the Car, posed where it touched down
   * @param v      its velocity then, ft/s (world)
   * @param fall   +1 or -1: the way the program has it falling along x
   * @param solid  the height of whatever is solid at (x, z)
   * @param seed   a number in 0..1 for the small things
   * @param home   x where the program keeps the wreck: it should end near
   */
  constructor(car, v, fall, solid, seed = 0.5, home = null) {
    this.car = car;
    this.solid = solid;
    this.home = home;
    car.group.updateMatrixWorld(true);
    const body = carBody(car);
    const q0 = car.group.quaternion.clone();
    body.set(COM.clone().applyQuaternion(q0).add(car.group.position), q0, v, new T.Vector3());
    this.body = body;
    this.steps = 0;
    this.acc = 0;
    this.tries = 0;
    // First the landing itself, as it comes: until the blow is over and it
    // has settled into it a little.
    const pre = body.clone();
    let touched = -1;
    let n = 0;
    while (n < 1.5 / STEP) {
      pre.step(solid);
      n++;
      if (touched < 0 && pre.contacts.length) touched = n;
      if (touched >= 0 && n - touched >= 0.35 / STEP) break;
    }
    pre.hits = [];
    this.branchAt = n;
    // Trying the ways it can go over takes a while: a few at each frame
    // until the car gets there, the rest then.
    this.search = this.choose(pre, v, fall, seed);
  }

  *choose(pre, v, fall, seed) {
    // The ways it can go over, each turning about the edge it goes over:
    // one side's tyres, or the front or back pair.
    const q = pre.q, x = pre.x;
    const at = (lx, ly, lz) => new T.Vector3(lx, ly, lz).sub(COM).applyQuaternion(q).add(x);
    const side = seed < 0.5 ? 1 : -1;
    const edge = CAR.TRACK + CAR.TYRE_W / 2;
    const front = 4.25 + 0.75, back = -4.35 - 0.75;
    const way = (axis, about) => ({ axis: new T.Vector3(...axis).applyQuaternion(q), arm: x.clone().sub(about) });
    const roll = [way([side, 0, 0], at(0, 0.1, side * edge)), way([-side, 0, 0], at(0, 0.1, -side * edge))];
    const pitch = [way([0, 0, -fall], at(fall > 0 ? front : back, 0.1, 0)), way([0, 0, fall], at(fall > 0 ? back : front, 0.1, 0))];
    // Coming in fast, end over end the way it was going; else on its side.
    const fast = Math.abs(v.x) > 8;
    const ways = fast ? [pitch[0], ...roll, pitch[1]] : [...roll, pitch[0], pitch[1]];
    // A little twist in every push, so nothing goes over too squarely.
    const twist = new T.Vector3(((seed * 7.3) % 1) * 0.12 - 0.06, (seed - 0.5) * 0.2, 0).applyQuaternion(q);
    // The blow has taken the speed along the ground: the tyres dug in.
    const dig = new T.Vector3(-pre.v.x, 0, -pre.v.z);
    const push = (w, m) => {
      const dw = w.axis.clone().multiplyScalar(m).add(twist);
      return { dw, dv: new T.Vector3().crossVectors(dw, w.arm).add(dig) };
    };
    let chosen = null;
    // Over by itself?
    const none = { dw: new T.Vector3(), dv: dig.clone() };
    const end0 = yield* this.trial(pre, none);
    if (end0.tipped) chosen = { ...none, end: end0 };
    // Else the first way that goes over, with about the least push that
    // does it and a little more, so it does not hang on the edge; and
    // that leaves it about where the program has it.
    const MAX = 2.6;
    let spare = null;
    for (const w of ways) {
      if (chosen) break;
      let hi = push(w, MAX);
      let endHi = yield* this.trial(pre, hi);
      if (!endHi.over) continue;
      let lo = 0.3, mHi = MAX;
      for (let k = 0; k < 3; k++) {
        const m = (lo + mHi) / 2;
        const p = push(w, m);
        const e = yield* this.trial(pre, p);
        if (e.over) {
          mHi = m;
          hi = p;
          endHi = e;
        } else lo = m;
      }
      const firm = push(w, Math.min(MAX, mHi * 1.15));
      const e = yield* this.trial(pre, firm);
      const pick = e.over ? { ...firm, end: e } : { ...hi, end: endHi };
      if (pick.end.tipped) chosen = pick;
      else if (!spare || pick.end.dist < spare.end.dist) spare = pick;
    }
    chosen = chosen || spare || { ...push(ways[0], MAX), end: { tipped: false, over: false, up: 1, dist: 0 } };
    this.push = chosen;
    this.result = chosen.end;
  }

  /** Go on with the search for `ms` milliseconds, or to the end. */
  think(ms = Infinity) {
    const t0 = performance.now();
    while (this.search) {
      if (this.search.next().done) this.search = null;
      else if (performance.now() - t0 > ms) break;
    }
  }

  /** From the landing, push and run through to rest (or five and a half
   * seconds), and see how it lies. */
  *trial(pre, p) {
    this.tries++;
    const b = pre.clone();
    b.w.add(p.dw);
    b.v.add(p.dv);
    const x0 = b.x.clone();
    for (let i = 0; i < 5.5 / STEP && !b.asleep; i++) {
      b.step(this.solid);
      if (i % 40 === 39) {
        yield;
        // Gone well away while still moving: not one to keep.
        if (Math.abs(b.x.x - x0.x) > 16 || Math.abs(b.x.z) > 12) break;
      }
      // Settled upside down or on its side: that is how it ends.
      if (i % 12 === 0 && b.v.lengthSq() < 0.25 && b.w.lengthSq() < 0.04 && b.up().y < 0.1 && b.contacts.length > 2) break;
    }
    const up = b.up();
    const over = up.y < 0.4;
    // Over, and still about where it came down, in the program's column
    // of ground and not far off the line, so that the next car to come
    // down there finds it there.
    const inHome = this.home === null || Math.abs(b.x.x - this.home) < 18;
    const tipped = over && inHome && Math.abs(b.x.x - x0.x) < 7 && Math.abs(b.x.z) < 6;
    return { over, tipped, up: up.y, dist: Math.hypot(b.x.x - x0.x, b.x.z), x: b.x.clone(), q: b.q.clone() };
  }

  /** Advance by dt seconds of machine time; pose the car. Returns the
   * blows since the last call, for the sound and the dust. */
  update(dt) {
    this.think(6);
    this.acc = Math.min(this.acc + dt, 0.25);
    while (this.acc >= STEP) {
      if (this.steps === this.branchAt) {
        this.think();
        this.body.w.add(this.push.dw);
        this.body.v.add(this.push.dv);
      }
      this.body.step(this.solid);
      this.steps++;
      this.acc -= STEP;
    }
    poseCar(this.car, this.body);
    this.car.freeWheels(this.body.wheels, dt);
    const hits = this.body.hits;
    this.body.hits = [];
    return hits;
  }

  get resting() {
    return this.body.asleep;
  }
}
