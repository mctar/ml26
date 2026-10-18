// The driver, run from the program. The 1973 program has a man of a few
// vectors who appears beside the ship four seconds after a good landing,
// walks down to the ground, and either plants a flag or walks to the
// McDonald's, orders, walks back and is taken up into the ship (PALSY,
// PALNOR, MOVMAN). Here the same events drive a man who climbs out of the
// car, lopes after the program's man, orders at a walk-up window, carries
// his order back and climbs in before the car lifts off; or carries a flag
// out, plants it where the program puts it, and salutes.
//
// Everything that happens is the program's; the driver only decides how
// it looks, and starts things early enough to be in time, which it can,
// because the program's timings are fixed: a step every eight ticks, four
// seconds before the man appears, two seconds in the ship before liftoff.

import * as T from '../vendor/three.js';
import { Choreo, EXIT, DOOR, canopyOut } from './choreo.js';
import { Gait, BODY, fwdOf, wrapAngle } from './astronaut.js';
import { clamp, lerp, smoothstep } from './shape.js';

const FT_PER_UNIT = 2 / 3; // a raster unit of the close-up
const STEP_S = 8 / 60; // MOVMAN: one step every eight ticks
const MAN_SPEED = FT_PER_UNIT / STEP_S; // 5 ft/s
const LANE = 5.8; // the walking lane, toward the camera from the flight plane
export const WINDOW = { dx: 16.7, z: 5.15 }; // the walk-up window, from the diner's feature
const LANDINGS = ['GREATM', 'GOODM', 'ROUGHM', 'CRIPM'];

export class Driver {
  /**
   * @param world  the Roadster: car, man, groundAt(x, z), symbols,
   *               terrain (the program's table), props, prints
   */
  constructor(world) {
    this.world = world;
    this.man = world.man;
    this.choreo = new Choreo(EXIT);
    this.gait = new Gait((x, z) => world.groundAt(x, z), this.man);
    this.reset();
  }

  reset() {
    this.mode = 'seated';
    this.t = 0; // choreography time
    this.plan = null; // what the program is going to do, once we know
    this.seen = null; // what we have seen of the program's man
    this.order = null;
    this.flag = null;
    this.blend = null;
    this.carry = null; // 'box' when carrying the order
    this.x = undefined;
    this.speedIn = 1;
    this.armed = false;
    this.world.props.reset();
  }

  /** Whether he is out of the car (the camera follows him then). */
  get isOut() {
    return this.mode !== 'seated';
  }

  messageIs(state, name) {
    const S = this.world.symbols;
    return state.sysmes !== 0 && S[name] === state.sysmes;
  }

  /**
   * MAYBE, read ahead: after one of the landing messages the program lets
   * the man out unless the ship is moving sideways too fast, leans too
   * far, or stands across a step in the ground.
   */
  predict(state) {
    if (!LANDINGS.some((m) => this.messageIs(state, m))) return null;
    const ter = this.world.terrain;
    const i = state.indexl;
    const step = Math.abs((ter[i + 1] ?? 0) - (ter[i] ?? 0));
    if (Math.abs(state.horvel) > 100 || Math.abs(state.angle) > 15 || step >= 48) return null;
    return { flag: !(state.diner & 2) };
  }

  /** The program's man, in feet, and how he is moving. */
  watch(state, mt) {
    const S = this.world.symbols;
    const shown = state.dust === S.MAN;
    const mx = state.lefeet + state.manx * FT_PER_UNIT;
    const s = this.seen || (this.seen = { shown: false, x: mx, many: state.many, vx: 0, dir: 0, at: mt, start: null, foot: null, minMany: Infinity, up: false });
    if (shown && !s.shown) {
      s.start = mx;
      s.many = state.many;
      s.at = mt;
    }
    if (shown) {
      if (state.manx !== s.manx) {
        const d = Math.sign(state.manx - (s.manx ?? state.manx));
        if (d) s.dir = d;
        s.vx = d * MAN_SPEED;
        s.movedAt = mt;
      } else if (mt - (s.movedAt ?? mt) > STEP_S * 1.6) s.vx = 0;
      // The foot of the way down: where the diagonal ends.
      if (state.many < s.minMany) {
        s.minMany = state.many;
        s.foot = mx;
      }
      if (state.many > s.minMany) s.up = true;
      s.manx = state.manx;
      s.many = state.many;
    }
    s.shown = shown;
    s.x = mx;
    return s;
  }

  /**
   * Each frame. `state` is the program's, `mt` machine seconds, `dt` the
   * machine time since the last frame; `landed` whether the car is down.
   */
  update(state, mt, dt, landed) {
    const w = this.world;
    const car = w.car;
    const ground = (x, z) => w.groundAt(x, z);
    // Learn what is coming.
    if (!landed) this.armed = true;
    if (!this.plan && landed && this.armed) {
      const p = this.predict(state);
      if (p) {
        this.plan = { ...p, exitAt: mt + 0.4 };
        this.armed = false;
      }
    }
    const seen = this.watch(state, mt);
    if (this.plan && this.plan.flag && seen.start !== null && seen.dir && this.plan.flagAt === undefined) {
      // PALNOR: 24 steps down and 48 along, the way the clock said; the
      // flag goes 20 units to the right of where he stops.
      const stop = seen.start + seen.dir * 72 * FT_PER_UNIT;
      this.plan.flagAt = stop + 20 * FT_PER_UNIT;
    }
    if (state.flagx !== 0 && this.plan) this.plan.flagAt = state.lefeet + state.flagx * FT_PER_UNIT;

    if (this.mode === 'seated') {
      if (this.plan && mt >= this.plan.exitAt && landed) {
        this.mode = 'exit';
        this.t = 0;
      }
      this.pose(this.choreo.pose(0, car, ground, { carry: this.carry === 'box' }));
      car.setCanopy(Math.max(0, car.canopyOpen - dt / 1.2));
      this.x = undefined;
      return;
    }

    if (this.mode === 'exit') {
      // Out briskly when there is a flag to plant: the program allows ten
      // seconds after it says where it goes, and then starts again.
      this.t = Math.min(this.choreo.duration, this.t + dt * (this.plan && this.plan.flag ? 1.3 : 1));
      car.setCanopy(canopyOut(this.t));
      const pose = this.choreo.pose(this.t, car, ground);
      this.pose(pose);
      this.x = pose.pelvis.x;
      if (this.t >= this.choreo.duration) {
        this.mode = 'out';
        const feet = DOOR.feet.map(([fx, fz]) => this.carPoint(fx, fz));
        this.gait.reset(pose.pelvis.x, pose.pelvis.z, DOOR.yaw, feet);
        this.gait.takePrints();
        for (const f of feet) w.prints.add(f.x, ground(f.x, f.z), f.z, DOOR.yaw);
      }
      return;
    }

    if (this.mode === 'out') {
      this.walkAbout(state, mt, dt, seen);
      return;
    }

    if (this.mode === 'enter') {
      // The climb out, backwards, at the pace that gets him in on time.
      const lifting = w.liftingOff;
      if (lifting) this.speedIn = 6;
      this.t = Math.max(0, this.t - dt * this.speedIn);
      car.setCanopy(canopyOut(this.t));
      let pose = this.choreo.pose(this.t, car, ground, { carry: this.carry === 'box' });
      if (this.blend) {
        // From where the gait left him into the keys.
        this.blend.k = Math.min(1, this.blend.k + dt / 0.45);
        pose = blendPose(this.blend.from, pose, smoothstep(0, 1, this.blend.k));
        if (this.blend.k >= 1) this.blend = null;
      }
      this.pose(pose);
      this.x = pose.pelvis.x;
      if (this.t <= 0) {
        this.mode = 'seated';
        this.plan = null;
        this.x = undefined;
      }
    }
  }

  /** A point beside the car, from its frame, on the ground. */
  carPoint(x, z) {
    const p = new T.Vector3(x, 0, z).applyMatrix4(this.world.car.body.matrixWorld);
    p.y = this.world.groundAt(p.x, p.z);
    return p;
  }

  pose(pose) {
    this.man.apply(pose);
    this.last = pose;
    this.world.props.follow(this.man, this);
  }

  /** Out on the ground: follow the program's man, and do what he does. */
  walkAbout(state, mt, dt, seen) {
    const w = this.world;
    const g = this.gait;
    const props = w.props;
    const door = this.carPoint(DOOR.x, DOOR.z);
    let goal = { x: g.x, z: LANE, face: g.yaw };
    let arms = null;
    let look = null;

    const order = this.messageIs(state, 'ORDER');
    const diner = w.dinerX;
    const win = diner !== null ? { x: diner + WINDOW.dx, z: WINDOW.z } : null;

    if (this.plan && !this.plan.flag && win) {
      // The McDonald's. Out to the window, order, back to the car.
      const o = this.order || (this.order = { phase: 'go', at: 0 });
      if (o.phase === 'go') {
        goal = { x: win.x, z: win.z, face: Math.PI / 2, vmax: 7 };
        if (order) {
          o.phase = 'order';
          o.at = mt;
        }
      }
      if (o.phase === 'order') {
        goal = { x: win.x, z: win.z, face: Math.PI / 2 };
        const s = mt - o.at;
        look = 0.1;
        if (s < 2.6) {
          // A hand up to the window: one, please.
          arms = [null, { wrist: new T.Vector3(win.x + 0.35, w.groundAt(win.x, win.z) + 4.6, win.z - 1.05) }];
        } else if (s < 4.4) {
          props.boxAt(win.x, w.groundAt(win.x, win.z) + 3.72, win.z - 0.98, smoothstep(2.6, 3.6, s));
          if (s > 3.7) {
            const bx = new T.Vector3(win.x, w.groundAt(win.x, win.z) + 3.92, win.z - 0.98);
            arms = [{ wrist: bx.clone().add(new T.Vector3(-0.42, 0.05, 0.05)) }, { wrist: bx.clone().add(new T.Vector3(0.42, 0.05, 0.05)) }];
          }
        } else {
          this.carry = 'box';
          props.carryBox(true);
        }
        if (!order && s > 4.5) o.phase = 'back';
      }
      if (o.phase === 'back') {
        // Back to the car, his back to it at the door, then in. The program
        // walks back to where it came down, climbs 22 steps, and holds two
        // seconds before it lifts off.
        goal = { x: door.x, z: door.z, face: DOOR.yaw, vmax: 6.5 };
        const toFoot = seen.foot !== null ? Math.abs(seen.x - seen.foot) / MAN_SPEED : 0;
        const steps = seen.up ? Math.max(0, 22 - (state.many - seen.minMany)) : 22;
        const lift = mt + (seen.shown ? toFoot + steps * STEP_S : 0) + 2.0;
        const there = Math.hypot(g.x - door.x, g.z - door.z) < 0.12 && Math.abs(wrapAngle(g.yaw - DOOR.yaw)) < 0.08 && g.mode === 'stand';
        const left = lift - mt - 0.35;
        const D = this.choreo.duration;
        if ((there && left < D * 1.05) || w.liftingOff || (!seen.shown && there)) {
          this.speedIn = clamp(D / Math.max(0.5, left), 1, 3);
          this.enter();
          return;
        }
      }
    } else if (this.plan && this.plan.flag) {
      // The flag: walk to where it goes, plant it, salute.
      const f = this.flag || (this.flag = { phase: 'go', at: 0 });
      const fx = this.plan.flagAt;
      if (fx === undefined) {
        goal = { x: seen.shown ? seen.x : g.x, z: LANE, v: seen.vx, vmax: 8 };
      } else {
        if (f.side === undefined) f.side = Math.sign(fx - g.x) || 1;
        const spot = fx - f.side * 1.75;
        const face = f.side > 0 ? 0 : Math.PI;
        if (f.phase === 'go') {
          goal = { x: spot, z: LANE, face, vmax: 8 };
          if (state.flagx !== 0 && Math.abs(g.x - spot) < 0.15 && g.mode === 'stand') {
            f.phase = 'plant';
            f.at = mt;
          }
        }
        if (f.phase === 'plant' || f.phase === 'done') {
          const s = mt - f.at;
          const back = s > 3.05 ? spot - f.side * 1.5 : spot;
          goal = { x: back, z: LANE, face };
          const r = props.plantFlag(s, this.man, fx, LANE, f.side);
          arms = r.arms;
          look = r.look;
          if (s > 3.5) {
            // Salute, then stand and look at it.
            const sal = smoothstep(3.5, 4.0, s) * (1 - smoothstep(6.2, 6.7, s));
            if (sal > 0.01) arms = [null, { salute: sal }];
            look = -0.1;
          }
        }
      }
    } else {
      // Nothing planned (or the McDonald's not drawn): go with him.
      goal = { x: seen.shown ? seen.x : door.x, z: LANE, v: seen.vx };
    }

    const pose = g.update(dt, goal);
    if (this.carry === 'box') {
      pose.arms = [{ local: new T.Vector3(0.74, 0.78, -0.32) }, { local: new T.Vector3(0.74, 0.78, 0.32) }];
    }
    if (arms) {
      for (let i = 0; i < 2; i++) {
        if (!arms[i]) continue;
        if (arms[i].salute !== undefined) {
          // The right hand to the brow of the helmet.
          pose.arms[i] = { local: new T.Vector3(lerp(0.3, 0.55, arms[i].salute), lerp(0.8, 2.45, arms[i].salute), lerp(0.75, 0.62, arms[i].salute)), pole: new T.Vector3(0, -0.2, 1).applyQuaternion(pose.orient) };
        } else pose.arms[i] = arms[i];
      }
    }
    if (look !== null) pose.look = look;
    this.pose(pose);
    for (const p of g.takePrints()) w.prints.add(p[0], p[1], p[2], p[3]);
    this.x = g.x;
  }

  enter() {
    this.mode = 'enter';
    this.t = this.choreo.duration;
    this.blend = { from: this.last, k: 0 };
  }
}

/** Mix two poses (a from the gait, b from the keys). */
function blendPose(a, b, k) {
  const out = { ...b };
  out.pelvis = a.pelvis.clone().lerp(b.pelvis, k);
  out.orient = a.orient.clone().slerp(b.orient, k);
  for (const n of ['hipPitch', 'lean', 'look']) out[n] = lerp(a[n] || 0, b[n] || 0, k);
  out.feet = b.feet.map((f, i) => ({ ...f, ankle: a.feet[i].ankle.clone().lerp(f.ankle, k), dir: a.feet[i].dir.clone().lerp(f.dir, k).normalize(), up: a.feet[i].up.clone().lerp(f.up, k).normalize() }));
  return out;
}
