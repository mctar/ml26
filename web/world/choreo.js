// Getting out of the car and back in, keyed in the car's own frame (x to
// the nose, y up from the ground at ride height, z toward the camera), so
// that feet land on the floor and the sill wherever the car is and however
// it sits. The last keys are on the ground beside the car: those follow
// the terrain, which is not the car's to know.
//
// Out: sit up, stand in the cockpit, turn to the side, step up onto the
// sill, and hop down, slowly, in a sixth of a g. In: the same backwards.
// Every key is checked in the lab against the car's body and fittings.

import * as T from '../vendor/three.js';
import { CAR, surfaceTop, carSurface } from './car.js';
import { BODY, footOn, fwdOf } from './astronaut.js';
import { monotone, lerp, clamp, smoothstep } from './shape.js';

const OUT = -Math.PI / 2; // facing +z: out of the car, toward the camera
const SEAT = CAR.SEAT;
const F = CAR.FLOOR;
const sill = (x, z) => surfaceTop(x, z);
const RELAX = [0.14, 0.17, 0.5];

/**
 * Keys. t in seconds. pelvis [x, y, z]; on: 'car' (default) or 'ground',
 * then y is above the terrain. feet: soles [x, y, z] standing on whatever
 * is there (floor, seat, sill; y is ignored), or `air` at height y, or on
 * the ground; with yaw, pitch, arc (lift on the way here). hands: wrist {p, pole} in the car, or {fk}.
 * hop: the pelvis flies here from the last key, ballistic.
 */
export const EXIT = [
  {
    t: 0,
    pelvis: [SEAT.x, SEAT.y, 0], yaw: 0, hipPitch: -0.24, lean: -0.16, look: 0.12,
    feet: [{ p: [2.3, F, -0.42], pitch: -0.25 }, { p: [2.3, F, 0.42], pitch: -0.25 }],
    hands: [{ p: [0.55, 1.95, -0.4], pole: [-0.5, -0.4, -0.15] }, { p: [0.55, 1.95, 0.4], pole: [-0.5, -0.4, 0.15] }],
  },
  {
    // The canopy is up. Sit up, feet drawn back, hands to the sills.
    t: 1.6,
    pelvis: [SEAT.x + 0.05, SEAT.y + 0.03, 0], yaw: 0, hipPitch: 0, lean: 0.2, look: 0.1,
    feet: [{ p: [0.56, F, -0.4], arc: 0.25 }, { p: [0.56, F, 0.4], arc: 0.25 }],
    hands: [{ p: [-0.2, sill(-0.2, 1.68) + 0.36, -1.68], pole: [-1, 1, -0.2], arc: 1.0 }, { p: [-0.2, sill(-0.2, 1.68) + 0.36, 1.68], pole: [-1, 1, 0.2], arc: 1.0 }],
  },
  {
    // Halfway up, pushing on the sills.
    t: 2.3,
    pelvis: [0.32, 2.62, 0], yaw: 0, hipPitch: 0.35, lean: 0.4, look: 0.3,
    feet: [{ p: [0.56, F, -0.4] }, { p: [0.56, F, 0.4] }],
    hands: [{ p: [0.05, sill(0.05, 1.62) + 0.36, -1.62], pole: [-1, 1, -0.2] }, { p: [0.05, sill(0.05, 1.62) + 0.36, 1.62], pole: [-1, 1, 0.2] }],
  },
  {
    // Standing in the cockpit.
    t: 3.0,
    pelvis: [0.45, F + BODY.STAND - 0.1, 0], yaw: 0, hipPitch: 0.05, lean: 0.05, look: 0,
    feet: [{ p: [0.56, F, -0.38] }, { p: [0.56, F, 0.38] }],
    hands: [{ fk: [0.25, 0.3, 0.6] }, { fk: [0.25, 0.3, 0.6] }],
  },
  {
    // Turned to the side, stepping round.
    t: 3.8,
    pelvis: [0.36, F + BODY.STAND - 0.1, 0.1], yaw: OUT, hipPitch: 0.05, lean: 0.08, look: 0.1,
    feet: [{ p: [0.68, F, 0.1], yaw: OUT, arc: 0.2 }, { p: [-0.06, F, 0.1], yaw: OUT, arc: 1.0, pole: [-0.2, 1, 0.6] }],
    hands: [{ fk: [0.3, 0.3, 0.6] }, { fk: [0.3, 0.3, 0.6] }],
  },
  {
    // The left foot up, inside the opening.
    t: 4.4,
    pelvis: [0.38, F + BODY.STAND - 0.3, 0.35], yaw: OUT, hipPitch: 0.15, lean: 0.15, look: 0.2,
    feet: [{ p: [0.7, 2.95, 0.8], yaw: OUT, air: true, arc: 0.4, pole: [0, 1, 0.3] }, { p: [-0.06, F, 0.1], yaw: OUT }],
    hands: [{ fk: [0.6, 0.35, 0.5] }, { fk: [0.5, 0.35, 0.5] }],
  },
  {
    // ... and onto the sill.
    t: 5.0,
    pelvis: [0.38, 3.45, 0.95], yaw: OUT, hipPitch: 0.3, lean: 0.3, look: 0.2,
    feet: [{ p: [0.7, 0, 2.0], yaw: OUT, arc: 0.15 }, { p: [-0.06, F, 0.1], yaw: OUT, pole: [0, 1, 0.15] }],
    hands: [{ fk: [0.7, 0.35, 0.5] }, { fk: [0.6, 0.35, 0.5] }],
  },
  {
    // The right foot lifted, straight up.
    t: 5.45,
    pelvis: [0.38, 3.75, 0.98], yaw: OUT, hipPitch: 0.25, lean: 0.3, look: 0.25,
    feet: [{ p: [0.7, 0, 2.0], yaw: OUT }, { p: [-0.02, 2.55, 0.3], yaw: OUT, air: true, arc: 0.3, pole: [0, 1, 0.15] }],
    hands: [{ fk: [0.8, 0.4, 0.45] }, { fk: [0.8, 0.4, 0.45] }],
  },
  {
    // Up on the left leg, the right foot over the edge.
    t: 6.0,
    pelvis: [0.38, 4.25, 1.7], yaw: OUT, hipPitch: 0.25, lean: 0.25, look: 0.25,
    feet: [{ p: [0.7, 0, 2.0], yaw: OUT }, { p: [0.04, 3.0, 1.35], yaw: OUT, air: true, arc: 0.2, pole: [0, 1, 0.4] }],
    hands: [{ fk: [0.8, 0.4, 0.45] }, { fk: [0.8, 0.4, 0.45] }],
  },
  {
    // Both feet on the sill, crouched.
    t: 6.55,
    pelvis: [0.36, sill(0.36, 2.0) + 2.45, 2.0], yaw: OUT, hipPitch: 0.35, lean: 0.25, look: 0.3,
    feet: [{ p: [0.7, 0, 2.0], yaw: OUT }, { p: [0.02, 0, 2.0], yaw: OUT, arc: 0.15 }],
    hands: [{ fk: [0.9, 0.3, 0.4] }, { fk: [0.9, 0.3, 0.4] }],
  },
  {
    // Down: a slow hop, landing bent.
    t: 7.9,
    hop: 0.55,
    pelvis: [0.36, 2.45, 4.35], on: 'ground', yaw: OUT, hipPitch: 0.3, lean: 0.25, look: 0.25,
    feet: [{ p: [0.7, 0, 4.4], yaw: OUT, on: 'ground' }, { p: [0.02, 0, 4.4], yaw: OUT, on: 'ground' }],
    hands: [{ fk: [0.75, 0.5, 0.3] }, { fk: [0.75, 0.5, 0.3] }],
  },
  {
    // Standing beside the car.
    t: 8.75,
    pelvis: [0.36, BODY.STAND - 0.12, 4.35], on: 'ground', yaw: OUT, hipPitch: 0.05, lean: 0.05, look: 0,
    feet: [{ p: [0.7, 0, 4.4], yaw: OUT, on: 'ground' }, { p: [0.02, 0, 4.4], yaw: OUT, on: 'ground' }],
    hands: [{ fk: RELAX }, { fk: RELAX }],
  },
];

/** Where the climb leaves him, and where the climb in starts: the pelvis
 * x and z in the car's frame, the way he faces, the feet. */
const LAST = EXIT[EXIT.length - 1];
export const DOOR = { x: LAST.pelvis[0], z: LAST.pelvis[2], yaw: OUT, feet: LAST.feet.map((f) => [f.p[0], f.p[2]]) };

/** The canopy during the climb out: open as he sits up. */
export function canopyOut(t) {
  return clamp((t - 0.1) / 1.3, 0, 1);
}

const ease = (s) => s * s * (3 - 2 * s);
const Y = new T.Vector3(0, 1, 0);

/**
 * Play keys: pose(t) for t in [0, duration]. `car` is the Car (its body's
 * world matrix places the car frame), `ground(x, z)` the terrain.
 */
export class Choreo {
  constructor(keys) {
    this.keys = keys;
    this.duration = keys[keys.length - 1].t;
    this.times = keys.map((k) => k.t);
    // Angles through the keys, smooth and without overshoot.
    this.ang = {};
    for (const name of ['hipPitch', 'lean', 'look', 'yaw']) this.ang[name] = monotone(this.times, keys.map((k) => k[name] || 0));
  }

  /** A key's pelvis in world space. */
  pelvisAt(k, M, ground) {
    const p = new T.Vector3(...k.pelvis);
    if (k.on === 'ground') {
      p.y = 0;
      p.applyMatrix4(M);
      p.y = ground(p.x, p.z) + k.pelvis[1];
    } else p.applyMatrix4(M);
    return p;
  }

  /** A key's foot in world space: {ankle, dir, up, sole}. */
  footAt(f, M, Mq, ground) {
    const yaw = f.yaw || 0;
    const pitch = f.pitch || 0;
    if (f.on === 'ground') {
      const p = new T.Vector3(f.p[0], 0, f.p[2]).applyMatrix4(M);
      p.y = ground(p.x, p.z) + f.p[1];
      const r = footOn(p, fwdOf(yaw), pitch, ground);
      r.sole = p;
      return r;
    }
    // In the air at the height given, or standing on whatever is there.
    const surf = f.air ? () => f.p[1] : carSurface;
    const local = new T.Vector3(f.p[0], surf(f.p[0], f.p[2]), f.p[2]);
    const r = footOn(local, fwdOf(yaw), pitch, surf, f.air ? carSurface : surf);
    r.ankle.applyMatrix4(M);
    r.dir.applyQuaternion(Mq);
    r.up.applyQuaternion(Mq);
    r.sole = local.applyMatrix4(M);
    return r;
  }

  /**
   * The pose at time t. `opts.carry`: the left hand holds something at
   * the belly instead of doing what the keys say.
   */
  pose(t, car, ground, opts = {}) {
    const keys = this.keys;
    t = clamp(t, 0, this.duration);
    let i = 0;
    while (i < keys.length - 2 && t > keys[i + 1].t) i++;
    const k1 = keys[i], k2 = keys[i + 1];
    const s = clamp((t - k1.t) / (k2.t - k1.t), 0, 1);
    const e = ease(s);
    car.body.updateWorldMatrix(true, false);
    const M = car.body.matrixWorld;
    const Mq = car.body.getWorldQuaternion(new T.Quaternion());

    // The pelvis: a smooth path through the keys, or a hop.
    const P = keys.map((k) => this.pelvisAt(k, M, ground));
    let pelvis;
    if (k2.hop !== undefined) {
      // Ballistic from k1 to k2: x and z at constant speed, y under g.
      const dur = k2.t - k1.t, tt = s * dur;
      const a = P[i], b = P[i + 1];
      const vy = (b.y - a.y + 0.5 * BODY.G * dur * dur) / dur;
      pelvis = new T.Vector3(lerp(a.x, b.x, s), a.y + vy * tt - 0.5 * BODY.G * tt * tt, lerp(a.z, b.z, s));
    } else {
      const fx = monotone(this.times, P.map((p) => p.x)), fy = monotone(this.times, P.map((p) => p.y)), fz = monotone(this.times, P.map((p) => p.z));
      pelvis = new T.Vector3(fx(t), fy(t), fz(t));
    }
    const yaw = this.ang.yaw(t);
    // In the car the body tilts with the car; on the ground it stands up.
    const onCar = (k) => (k.on === 'ground' ? 0 : 1);
    const tilt = lerp(onCar(k1), onCar(k2), e);
    const tiltQ = Mq.clone().slerp(new T.Quaternion(), 1 - tilt);
    const orient = tiltQ.clone().multiply(new T.Quaternion().setFromAxisAngle(Y, yaw));

    // Feet: each from its place at k1 to its place at k2, lifted on the
    // way. In a hop they keep under the body.
    const feet = [0, 1].map((j) => {
      const a = this.footAt(k1.feet[j], M, Mq, ground);
      const b = this.footAt(k2.feet[j], M, Mq, ground);
      let ankle;
      if (k2.hop !== undefined) {
        const pa = a.ankle.clone().sub(P[i]), pb = b.ankle.clone().sub(P[i + 1]);
        ankle = pelvis.clone().add(pa.lerp(pb, s));
        ankle.y += k2.hop * Math.sin(Math.PI * s);
      } else {
        ankle = a.ankle.clone().lerp(b.ankle, e);
        if (a.ankle.distanceToSquared(b.ankle) > 1e-6) ankle.y += (k2.feet[j].arc ?? 0.12) * Math.sin(Math.PI * e);
      }
      const dir = a.dir.clone().lerp(b.dir, e).normalize();
      const up = a.up.clone().lerp(b.up, e).normalize();
      // Knees forward, a little up; or where the keys say.
      const kp = (f) => (f.pole ? new T.Vector3(...f.pole).applyQuaternion(Mq) : fwdOf(yaw).applyQuaternion(tiltQ).add(new T.Vector3(0, 0.35, 0)).normalize());
      // A foot on the move takes its knee where the next key says, at once
      // (a straight leg hardly shows it); a foot at rest blends.
      const moving = a.ankle.distanceToSquared(b.ankle) > 1e-6;
      const pole = kp(k1.feet[j]).lerp(kp(k2.feet[j]), moving ? smoothstep(0, 0.15, s) : e);
      return { ankle, dir, up, pole };
    });

    // Hands.
    const wristAt = (h) => (h.fk ? null : new T.Vector3(...h.p).applyMatrix4(M));
    const poleAt = (h) => (h.pole ? new T.Vector3(...h.pole).applyQuaternion(Mq) : null);
    const arms = [0, 1].map((j) => {
      const a = k1.hands[j], b = k2.hands[j];
      const pa = wristAt(a), pb = wristAt(b);
      if (!pa && !pb) return { fk: a.fk.map((v, n) => lerp(v, b.fk[n], e)) };
      if (pa && pb) {
        const w = pa.clone().lerp(pb, e);
        if (pa.distanceToSquared(pb) > 1e-4) w.y += (b.arc ?? 0.2) * Math.sin(Math.PI * e);
        const pole = poleAt(a) && poleAt(b) ? poleAt(a).lerp(poleAt(b), e) : poleAt(b) || poleAt(a);
        return { wrist: w, pole };
      }
      // From a hold to a free arm, or back: let go (or take hold) halfway.
      return (pa ? e < 0.5 : e >= 0.5) ? { wrist: pa || pb, pole: poleAt(pa ? a : b) } : { fk: (a.fk || b.fk) };
    });
    if (opts.carry) arms[0] = { local: new T.Vector3(0.8, 0.75, -0.12) };
    return { pelvis, orient, hipPitch: this.ang.hipPitch(t), lean: this.ang.lean(t), look: this.ang.look(t), feet, arms };
  }
}
