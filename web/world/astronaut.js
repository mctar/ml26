// The driver: a suited figure with real joints, posed by inverse
// kinematics so that his feet are exactly where they are put: on the
// ground, on the car's sill, in the footwell. Two layers drive him: a
// gait, which plants feet on the terrain and lopes the way people moved in
// a sixth of a g, and choreographies (choreo.js), keyed in the car's own
// frame for climbing out and back in. Units are feet; the figure faces +x.

import * as T from '../vendor/three.js';
import { smoothstep, clamp, lerp, limbProfile } from './shape.js';

export const BODY = {
  L_THIGH: 1.4,
  L_SHIN: 1.36,
  ANKLE_H: 0.3,
  TOE: 0.66, // sole, ahead of the ankle
  HEEL: 0.3, // sole, behind it
  HIP_Z: 0.34,
  HIP_Y: -0.06, // hip joints below the pelvis anchor
  L_UPPER: 0.98,
  L_FORE: 0.9,
  SHOULDER: new T.Vector3(0.02, 1.56, 0.74),
  HEAD: new T.Vector3(0.04, 1.84, 0), // the neck, on the torso
  HELMET: 0.58, // radius, its centre 0.48 above the neck
  G: 5.32, // the Moon's gravity, ft/s/s
};
// Pelvis anchor height above the soles when standing straight.
BODY.STAND = BODY.L_THIGH + BODY.L_SHIN + BODY.ANKLE_H - BODY.HIP_Y;
BODY.REACH = BODY.L_THIGH + BODY.L_SHIN;

const Y = new T.Vector3(0, 1, 0);
const _a = new T.Vector3(), _d = new T.Vector3(), _e = new T.Vector3(), _u = new T.Vector3(), _x = new T.Vector3(), _y = new T.Vector3(), _z = new T.Vector3();
const _m = new T.Matrix4(), _q = new T.Quaternion(), _q2 = new T.Quaternion();

function lathe(length, radii, mat, steps = 14) {
  // LatheGeometry wants the profile bottom to top for outward faces.
  const pts = limbProfile(length, radii, steps).map(([r, y]) => new T.Vector2(Math.max(1e-4, r), y)).reverse();
  const m = new T.Mesh(new T.LatheGeometry(pts, 20), mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/**
 * Two-bone IK. `root` and `mid` are joints whose bones hang down their
 * local -y, the mid joint bending about its local z. `target` is the end
 * point and `pole` the direction the middle joint should point, both in
 * the root's parent frame, the target relative to the root's position.
 * The middle joint goes toward the pole; the end reaches the target, or
 * as near as the bones allow.
 */
function solveTwoBone(root, mid, L1, L2, target, pole) {
  let D = target.length();
  _d.copy(target).divideScalar(D || 1);
  D = clamp(D, Math.abs(L1 - L2) + 1e-3, L1 + L2 - 1e-4);
  const beta = Math.acos(clamp((L1 * L1 + D * D - L2 * L2) / (2 * L1 * D), -1, 1));
  const gamma = Math.acos(clamp((L2 * L2 + D * D - L1 * L1) / (2 * L2 * D), -1, 1));
  _e.copy(pole).addScaledVector(_d, -pole.dot(_d));
  if (_e.lengthSq() < 1e-8) _e.set(1, 0, 0).addScaledVector(_d, -_d.x);
  _e.normalize();
  const cb = Math.cos(beta), sb = Math.sin(beta);
  _u.copy(_d).multiplyScalar(cb).addScaledVector(_e, sb); // the first bone
  _x.copy(_d).multiplyScalar(-sb).addScaledVector(_e, cb);
  _y.copy(_u).negate();
  _z.crossVectors(_x, _y);
  _m.makeBasis(_x, _y, _z);
  root.quaternion.setFromRotationMatrix(_m);
  mid.rotation.set(0, 0, -(beta + gamma));
  return D;
}

export class Astronaut {
  constructor(env = null) {
    const suit = new T.MeshStandardMaterial({ color: 0xe9e8e3, roughness: 0.86, metalness: 0.0, envMap: env, envMapIntensity: 1.0 });
    const soft = new T.MeshStandardMaterial({ color: 0xdcdad3, roughness: 0.95, metalness: 0.0, envMap: env, envMapIntensity: 0.9 });
    const trim = new T.MeshStandardMaterial({ color: 0x2b2d31, roughness: 0.6, metalness: 0.2, envMap: env, envMapIntensity: 0.5 });
    const metal = new T.MeshStandardMaterial({ color: 0xb9bdc3, roughness: 0.28, metalness: 1.0, envMap: env });
    const visor = new T.MeshPhysicalMaterial({ color: 0xc8922f, metalness: 1.0, roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.03, envMap: env, envMapIntensity: 1.8 });
    this.mats = { suit, soft, trim, metal, visor };
    const shadowed = (m) => {
      m.castShadow = true;
      m.receiveShadow = true;
      return m;
    };

    this.root = new T.Group(); // the pelvis anchor, oriented with the body
    this.pelvis = new T.Group();
    this.root.add(this.pelvis);
    this.torso = new T.Group();
    this.pelvis.add(this.torso);

    // Hips and the seat of the suit.
    const hips = shadowed(new T.Mesh(new T.SphereGeometry(0.5, 24, 16), suit));
    hips.scale.set(0.94, 0.74, 1.24);
    hips.position.y = -0.04;
    this.pelvis.add(hips);
    // The trunk: one rounded body from the waist to the shoulders, wider
    // than it is deep.
    const trunkProfile = [[0.08, 0.0], [0.1, 0.43], [0.35, 0.46], [0.75, 0.48], [1.15, 0.52], [1.45, 0.51], [1.68, 0.42], [1.82, 0.27], [1.86, 0.0]];
    const tp = [];
    for (let i = 0; i <= 28; i++) {
      const t = i / 28;
      const y = 0.08 + t * (1.86 - 0.08);
      let r = 0;
      for (let k = 0; k < trunkProfile.length - 1; k++) {
        const [y0, r0] = trunkProfile[k], [y1, r1] = trunkProfile[k + 1];
        if (y >= y0 && y <= y1) r = r0 + (r1 - r0) * smoothstep(y0, y1, y);
      }
      tp.push(new T.Vector2(Math.max(1e-3, r), y));
    }
    const trunk = shadowed(new T.Mesh(new T.LatheGeometry(tp, 32), suit));
    trunk.scale.set(0.92, 1, 1.27);
    this.torso.add(trunk);
    const belt = new T.Mesh(new T.TorusGeometry(0.46, 0.05, 8, 36), trim);
    belt.rotation.x = Math.PI / 2;
    belt.scale.set(0.93, 1.27, 1);
    belt.position.y = 0.26;
    this.torso.add(belt);
    // The life-support pack, its control unit on top, and the chest unit
    // with three switches.
    const pack = shadowed(new T.Mesh(new T.RoundedBoxGeometry(0.68, 1.85, 1.46, 3, 0.12), soft));
    pack.position.set(-0.86, 1.08, 0);
    this.torso.add(pack);
    const ops = shadowed(new T.Mesh(new T.RoundedBoxGeometry(0.5, 0.28, 1.3, 2, 0.08), soft));
    ops.position.set(-0.86, 2.13, 0);
    this.torso.add(ops);
    const strap = new T.Mesh(new T.BoxGeometry(0.05, 0.08, 1.2), trim);
    strap.position.set(-0.5, 0.55, 0);
    this.torso.add(strap);
    const unit = shadowed(new T.Mesh(new T.RoundedBoxGeometry(0.2, 0.34, 0.62, 2, 0.04), trim));
    unit.position.set(0.5, 1.05, 0);
    this.torso.add(unit);
    for (const [z, c] of [[-0.17, 0x4c8bd6], [0.0, 0xd8d8d8], [0.17, 0xc94a3a]]) {
      const b = new T.Mesh(new T.BoxGeometry(0.03, 0.06, 0.08), new T.MeshBasicMaterial({ color: c }));
      b.position.set(0.61, 1.12, z);
      this.torso.add(b);
    }
    // Neck ring, helmet, visor.
    const ring = new T.Mesh(new T.TorusGeometry(0.36, 0.07, 10, 32), metal);
    ring.rotation.x = Math.PI / 2;
    ring.position.copy(BODY.HEAD).add(new T.Vector3(0, -0.02, 0));
    this.torso.add(ring);
    this.head = new T.Group();
    this.head.position.copy(BODY.HEAD);
    this.torso.add(this.head);
    const helmet = shadowed(new T.Mesh(new T.SphereGeometry(BODY.HELMET, 40, 28), suit));
    helmet.position.y = 0.48;
    this.head.add(helmet);
    // The visor: the front of the bubble, a shade larger, gold. Its cap is
    // centred on -x as built; turned half round, it faces forward.
    const shield = new T.Mesh(new T.SphereGeometry(BODY.HELMET * 1.03, 40, 24, -Math.PI * 0.36, Math.PI * 0.72, Math.PI * 0.24, Math.PI * 0.42), visor);
    shield.position.y = 0.48;
    shield.rotation.y = Math.PI;
    this.head.add(shield);
    // The shell's edge around the visor, a thin dark line.
    const rim = new T.Mesh(new T.TorusGeometry(BODY.HELMET * 0.86, 0.025, 6, 40), trim);
    rim.position.set(BODY.HELMET * 0.52, 0.48 + 0.04, 0);
    rim.rotation.y = Math.PI / 2;
    rim.scale.set(1.05, 0.82, 1);
    this.head.add(rim);

    // Legs: hip, knee, ankle; bones hang down -y.
    this.legs = [];
    for (const side of [-1, 1]) {
      const hip = new T.Group();
      hip.position.set(0, BODY.HIP_Y, side * BODY.HIP_Z);
      hip.add(lathe(BODY.L_THIGH, [[0, 0.31], [0.3, 0.3], [0.7, 0.265], [1, 0.24]], suit));
      const knee = new T.Group();
      knee.position.y = -BODY.L_THIGH;
      hip.add(knee);
      const pad = shadowed(new T.Mesh(new T.SphereGeometry(0.255, 16, 12), soft));
      knee.add(pad);
      const kneeRing = new T.Mesh(new T.TorusGeometry(0.235, 0.03, 6, 24), trim);
      kneeRing.rotation.x = Math.PI / 2;
      kneeRing.position.y = -0.2;
      knee.add(kneeRing);
      knee.add(lathe(BODY.L_SHIN, [[0, 0.245], [0.35, 0.255], [0.8, 0.228], [1, 0.22]], suit));
      const ankle = new T.Group();
      ankle.position.y = -BODY.L_SHIN;
      knee.add(ankle);
      // The overshoe: a bulky rounded boot over a dark ribbed sole.
      const len = BODY.TOE + BODY.HEEL;
      const mid = (BODY.TOE - BODY.HEEL) / 2;
      const boot = shadowed(new T.Mesh(new T.RoundedBoxGeometry(len, 0.34, 0.47, 3, 0.13), soft));
      boot.position.set(mid, -BODY.ANKLE_H + 0.22, 0);
      ankle.add(boot);
      const cuff = shadowed(new T.Mesh(new T.CylinderGeometry(0.24, 0.27, 0.34, 18), soft));
      cuff.position.set(-0.02, -0.04, 0);
      ankle.add(cuff);
      const sole = shadowed(new T.Mesh(new T.RoundedBoxGeometry(len + 0.02, 0.1, 0.49, 2, 0.04), trim));
      sole.position.set(mid, -BODY.ANKLE_H + 0.05, 0);
      ankle.add(sole);
      this.legs.push({ hip, knee, ankle, side });
      this.pelvis.add(hip);
    }
    // Arms: shoulder, elbow, wrist.
    const glove = new T.MeshStandardMaterial({ color: 0x737b88, roughness: 0.7, metalness: 0.1, envMap: env, envMapIntensity: 0.5 });
    this.arms = [];
    for (const side of [-1, 1]) {
      const shoulder = new T.Group();
      shoulder.position.set(BODY.SHOULDER.x, BODY.SHOULDER.y, side * BODY.SHOULDER.z);
      shoulder.add(shadowed(new T.Mesh(new T.SphereGeometry(0.28, 18, 12), suit)));
      shoulder.add(lathe(BODY.L_UPPER, [[0, 0.24], [0.4, 0.225], [1, 0.19]], suit));
      const elbow = new T.Group();
      elbow.position.y = -BODY.L_UPPER;
      shoulder.add(elbow);
      const ering = new T.Mesh(new T.TorusGeometry(0.185, 0.026, 6, 20), trim);
      ering.rotation.x = Math.PI / 2;
      elbow.add(ering);
      elbow.add(lathe(BODY.L_FORE, [[0, 0.19], [0.55, 0.18], [1, 0.155]], suit));
      const wrist = new T.Group();
      wrist.position.y = -BODY.L_FORE;
      elbow.add(wrist);
      const gauntlet = shadowed(new T.Mesh(new T.CylinderGeometry(0.17, 0.2, 0.26, 16), glove));
      gauntlet.position.y = 0.06;
      wrist.add(gauntlet);
      const hand = shadowed(new T.Mesh(new T.SphereGeometry(0.17, 16, 12), glove));
      hand.scale.set(0.82, 1.2, 0.66);
      hand.position.y = -0.15;
      wrist.add(hand);
      const grip = new T.Group(); // where a held thing goes
      grip.position.set(0, -0.2, 0);
      wrist.add(grip);
      this.arms.push({ shoulder, elbow, wrist, grip, side });
      this.torso.add(shoulder);
    }
  }

  /** Leg IK: the ankle joint to a world point, the sole along `dir` with
   * its top toward `up`; the knee toward `pole` (world), or forward. */
  setLeg(i, ankle, dir, up = Y, pole = null) {
    const leg = this.legs[i];
    this.pelvis.updateWorldMatrix(true, false);
    _m.copy(this.pelvis.matrixWorld).invert();
    _a.copy(ankle).applyMatrix4(_m).sub(leg.hip.position);
    const p = pole ? new T.Vector3().copy(pole).transformDirection(_m) : new T.Vector3(1, 0.05, leg.side * 0.12);
    solveTwoBone(leg.hip, leg.knee, BODY.L_THIGH, BODY.L_SHIN, _a, p);
    this.orientEnd(leg.ankle, dir, up);
  }

  /** Arm IK: the wrist to a world point, the elbow toward `pole` (world),
   * or back, down and out. */
  setArm(i, wrist, pole = null) {
    const arm = this.arms[i];
    this.torso.updateWorldMatrix(true, false);
    _m.copy(this.torso.matrixWorld).invert();
    _a.copy(wrist).applyMatrix4(_m).sub(arm.shoulder.position);
    const p = pole ? new T.Vector3().copy(pole).transformDirection(_m) : new T.Vector3(-0.6, -0.5, arm.side * 0.9);
    solveTwoBone(arm.shoulder, arm.elbow, BODY.L_UPPER, BODY.L_FORE, _a, p);
    arm.wrist.rotation.set(0, 0, 0);
  }

  /** An arm by angles: swing forward, out to the side, elbow bend. */
  armFK(i, swing, out, bend) {
    const arm = this.arms[i];
    arm.shoulder.rotation.set(-arm.side * out, 0, swing, 'XYZ');
    arm.elbow.rotation.set(0, 0, bend);
    arm.wrist.rotation.set(0, 0, 0);
  }

  /** Turn a chain's end so its +x is along world `dir` and +y toward `up`. */
  orientEnd(end, dir, up) {
    end.parent.updateWorldMatrix(true, false);
    end.parent.getWorldQuaternion(_q2);
    _x.copy(dir).normalize();
    _z.crossVectors(_x, up);
    if (_z.lengthSq() < 1e-8) return;
    _z.normalize();
    _y.crossVectors(_z, _x);
    _m.makeBasis(_x, _y, _z);
    _q.setFromRotationMatrix(_m);
    end.quaternion.copy(_q2.invert().multiply(_q));
  }

  /**
   * Pose the whole figure, all in world space.
   *   pelvis    position of the pelvis anchor
   *   orient    quaternion of the body (x forward, y up)
   *   hipPitch  pelvis pitch, forward positive; roll
   *   lean      torso pitch over the pelvis, forward positive; twist
   *   look      head pitch, down positive; headYaw
   *   feet      [{ankle, dir, up, pole?}] left, right
   *   arms      [{wrist, pole?} | {local} | {fk: [swing, out, bend]}] left, right;
   *             `local` is a wrist point in the torso's frame
   */
  apply(pose) {
    this.root.position.copy(pose.pelvis);
    this.root.quaternion.copy(pose.orient);
    this.pelvis.rotation.set(pose.roll || 0, 0, -(pose.hipPitch || 0));
    this.torso.rotation.set(0, pose.twist || 0, -(pose.lean || 0));
    this.head.rotation.set(0, pose.headYaw || 0, -(pose.look || 0));
    this.root.updateMatrixWorld(true);
    for (let i = 0; i < 2; i++) {
      const f = pose.feet[i];
      this.setLeg(i, f.ankle, f.dir, f.up || Y, f.pole || null);
    }
    for (let i = 0; i < 2; i++) {
      const a = pose.arms[i];
      if (a.local) {
        // A hold relative to the torso (carrying something).
        this.torso.updateWorldMatrix(true, false);
        this.setArm(i, a.local.clone().applyMatrix4(this.torso.matrixWorld), a.pole || null);
      } else if (a.wrist) this.setArm(i, a.wrist, a.pole || null);
      else this.armFK(i, a.fk[0], a.fk[1], a.fk[2]);
    }
    this.root.updateMatrixWorld(true);
  }

  /** The hip joint's world position, for keeping planted feet reachable. */
  hipWorld(i, pelvis, orient, out = new T.Vector3()) {
    return out.set(0, BODY.HIP_Y, this.legs[i].side * BODY.HIP_Z).applyQuaternion(orient).add(pelvis);
  }

  /** Points that must stay out of solids, in world space, each with the
   * radius of the part around it. */
  probes() {
    this.root.updateMatrixWorld(true);
    const out = [];
    const at = (obj, x, y, z, name, r = 0) => out.push({ name, r, p: new T.Vector3(x, y, z).applyMatrix4(obj.matrixWorld) });
    for (const [i, leg] of this.legs.entries()) {
      const s = i ? 'R' : 'L';
      at(leg.ankle, BODY.TOE, -BODY.ANKLE_H, 0, s + 'toe');
      at(leg.ankle, -BODY.HEEL, -BODY.ANKLE_H, 0, s + 'heel');
      at(leg.ankle, 0.19, -BODY.ANKLE_H, 0.19, s + 'sole+');
      at(leg.ankle, 0.19, -BODY.ANKLE_H, -0.19, s + 'sole-');
      at(leg.knee, 0, 0, 0, s + 'knee', 0.2);
      at(leg.knee, 0, -BODY.L_SHIN / 2, 0, s + 'shin', 0.2);
      at(leg.hip, 0, -BODY.L_THIGH / 2, 0, s + 'thigh', 0.24);
    }
    for (const [i, arm] of this.arms.entries()) {
      const s = i ? 'R' : 'L';
      at(arm.elbow, 0, 0, 0, s + 'elbow', 0.15);
      at(arm.wrist, 0, -0.16, 0, s + 'hand', 0.1);
    }
    at(this.pelvis, 0, -0.32, 0, 'seat', 0.05);
    for (const [y, z] of [[0.3, 0.6], [0.3, -0.6], [1.9, 0.6], [1.9, -0.6], [1.08, 0]]) at(this.torso, -1.12, y, z, 'pack', 0.08);
    at(this.torso, 0.02, 1.2, 0, 'chest', 0.5);
    at(this.head, 0, 0.48, 0, 'helmet', BODY.HELMET);
    return out;
  }
}

/**
 * A foot resting on a surface: `p` is the point of the sole under the
 * ankle, `fwd` the horizontal way it points. `pitch` > 0 lifts the heel,
 * rolling about the toe; < 0 lifts the toes, rocking on the heel.
 * `ground(x, z)` is the surface height; `floor`, if given, is what the
 * sole's corners must clear (for a foot in the air). Returns {ankle, dir, up}.
 */
export function footOn(p, fwd, pitch, ground, floor = ground) {
  const L = BODY.TOE + BODY.HEEL;
  const hx = p.x - fwd.x * BODY.HEEL, hz = p.z - fwd.z * BODY.HEEL;
  const tx = p.x + fwd.x * BODY.TOE, tz = p.z + fwd.z * BODY.TOE;
  const gh = ground(hx, hz), gt = ground(tx, tz);
  const slope = Math.atan2(gt - gh, L);
  // The sole's angle above horizontal, heel to toe.
  const a = slope - pitch;
  const c = Math.cos(a), s = Math.sin(a);
  const dir = new T.Vector3(fwd.x * c, s, fwd.z * c);
  // Across the foot the sole lies on the ground's cross slope.
  const rx = -fwd.z, rz = fwd.x, w = 0.21;
  const cx = p.x + fwd.x * 0.19, cz = p.z + fwd.z * 0.19;
  const side = new T.Vector3(rx, (ground(cx + rx * w, cz + rz * w) - ground(cx - rx * w, cz - rz * w)) / (2 * w), rz).normalize();
  const up = new T.Vector3().crossVectors(side, dir).normalize();
  let pivot, back;
  if (pitch > 0) {
    pivot = new T.Vector3(tx, gt, tz);
    back = -BODY.TOE;
  } else {
    pivot = new T.Vector3(hx, gh, hz);
    back = BODY.HEEL;
  }
  const ankle = pivot.clone().addScaledVector(dir, back).addScaledVector(up, BODY.ANKLE_H);
  // The sole's corners stay on or above the ground.
  let low = 0;
  for (const [ax, az] of [[BODY.TOE, 0], [-BODY.HEEL, 0], [0.19, w], [0.19, -w], [-BODY.HEEL, w], [-BODY.HEEL, -w], [BODY.TOE - 0.1, w], [BODY.TOE - 0.1, -w]]) {
    const q = ankle.clone().addScaledVector(dir, ax).addScaledVector(side, az).addScaledVector(up, -BODY.ANKLE_H);
    low = Math.min(low, q.y - floor(q.x, q.z));
  }
  ankle.y -= low;
  return { ankle, dir, up };
}

const yawQ = (yaw) => new T.Quaternion().setFromAxisAngle(Y, yaw);
export const fwdOf = (yaw) => new T.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
export const rightOf = (yaw) => new T.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
export const wrapAngle = (a) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

// The lope, in fractions of a stride: the trailing foot (right) is down
// from 0 to 0.22, the leading foot (left) from 0.12 to 0.34; then both
// are off the ground, and the body flies, until the next stride.
const LOPE = [
  { i: 1, down: 0.0, up: 0.22, ahead: 0.5 },
  { i: 0, down: 0.12, up: 0.34, ahead: 1.1 },
];
const cyc = (p) => p - Math.floor(p);

/**
 * Walking on the Moon. The body goes where it is told; its feet are put
 * down on the ground and stay where they land until they are lifted.
 * Fast: a lope, both feet off the ground most of the time, one leading,
 * the pelvis on a ballistic arc in a sixth of a g. Slow or standing:
 * steps to keep the feet under the body and to turn on the spot.
 */
export class Gait {
  constructor(ground, astronaut) {
    this.ground = ground; // (x, z) -> y
    this.man = astronaut;
    this.x = 0;
    this.z = 0;
    this.vx = 0;
    this.vz = 0;
    this.yaw = 0;
    this.yawTarget = 0;
    this.phase = 0;
    this.mode = 'stand';
    this.time = 0;
    this.lift = 0;
    this.feet = [0, 1].map(() => ({ pos: new T.Vector3(), yaw: 0, planted: true, swing: null, pitch: 0, since: 0 }));
    this.prints = []; // footfalls since last read: [x, y, z, yaw, side]
    this.lastPose = null;
  }

  /** Stand at (x, z) facing yaw, feet set. */
  reset(x, z, yaw, feet = null) {
    this.x = x;
    this.z = z;
    this.vx = this.vz = 0;
    this.yaw = this.yawTarget = yaw;
    this.mode = 'stand';
    this.lift = 0;
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      f.pos.copy(feet ? feet[i] : this.rest(i));
      f.pos.y = this.ground(f.pos.x, f.pos.z);
      f.yaw = yaw;
      f.planted = true;
      f.swing = null;
      f.pitch = 0;
    }
  }

  /** Where a standing foot belongs. */
  rest(i, yaw = this.yaw) {
    const side = i ? 1 : -1;
    const p = new T.Vector3(this.x, 0, this.z).addScaledVector(rightOf(yaw), side * 0.3).addScaledVector(fwdOf(yaw), i ? 0.05 : -0.05);
    p.y = this.ground(p.x, p.z);
    return p;
  }

  land(foot, i) {
    foot.planted = true;
    foot.swing = null;
    foot.since = this.time;
    foot.pos.y = this.ground(foot.pos.x, foot.pos.z);
    this.prints.push([foot.pos.x, foot.pos.y, foot.pos.z, foot.yaw, i]);
  }

  /** A timed step of foot i to `to`. */
  step(i, to, dur, height, yaw, strike = 0.08) {
    const f = this.feet[i];
    f.planted = false;
    f.swing = { from: f.pos.clone(), to: to.clone(), t: 0, dur, height, fromYaw: f.yaw, toYaw: yaw, fromPitch: f.pitch, strike, lope: null };
  }

  /**
   * Advance by dt. `goal` = {x, z, v?, face?, vmax?}: where to be, an
   * optional feed-forward speed along x, and the way to face when there.
   * Returns a pose for Astronaut.apply.
   */
  update(dt, goal) {
    this.time += dt;
    const vmax = goal.vmax ?? 7;
    // Low traction: speed changes gently, at most a third of a g.
    const ex = goal.x - this.x, ez = (goal.z ?? this.z) - this.z;
    const dist = Math.hypot(ex, ez);
    // Toward the goal no faster than can be stopped in the distance left,
    // plus the goal's own speed along x.
    const A = 4.5;
    let toward = Math.min(vmax, Math.sqrt(2 * A * 0.8 * dist), dist * 2.2);
    // A short way from standing is a few steps, not a run; and a run
    // starts from both feet down, so no faster than a step until then.
    if (this.mode !== 'lope' && dist < 3.5 && !goal.v) toward = Math.min(toward, 1.3);
    const stepping = this.mode !== 'lope';
    let wx = (goal.v || 0) + (dist > 1e-6 ? (ex / dist) * toward : 0);
    let wz = dist > 1e-6 ? (ez / dist) * toward : 0;
    const wl = Math.hypot(wx, wz);
    const cap = stepping ? Math.min(vmax, 1.5) : vmax;
    if (wl > cap) {
      wx *= cap / wl;
      wz *= cap / wl;
    }
    if (dist < 0.04 && !goal.v) wx = wz = 0;
    const acc = A * dt;
    const dvx = wx - this.vx, dvz = wz - this.vz, dl = Math.hypot(dvx, dvz);
    const k = dl > acc ? acc / dl : 1;
    this.vx += dvx * k;
    this.vz += dvz * k;
    if (dist < 0.04 && !goal.v && Math.hypot(this.vx, this.vz) < 0.25) this.vx = this.vz = 0;
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    const speed = Math.hypot(this.vx, this.vz);
    // Face the way he is going when he is really going somewhere; a step
    // or two back or aside is just stepping.
    if (speed > 1.6 || (this.mode === 'lope' && speed > 0.8)) this.yawTarget = Math.atan2(-this.vz, this.vx);
    else if (goal.face !== undefined) this.yawTarget = goal.face;
    this.yaw += clamp(wrapAngle(this.yawTarget - this.yaw), -2.6 * dt, 2.6 * dt);

    const fwd = fwdOf(this.yaw), right = rightOf(this.yaw);
    // Into a lope when he wants to go faster than a step, from both feet.
    if (this.mode !== 'lope' && Math.hypot(wx, wz) > 1.45 && speed > 1.2 && !this.feet.some((f) => f.swing)) {
      this.mode = 'lope';
      this.phase = 0;
    }
    if (this.mode === 'lope' && speed < 0.8) this.mode = 'settle';
    const f = clamp(0.62 + 0.045 * speed, 0.7, 1.0); // strides a second
    let lift = 0;
    if (this.mode === 'lope') {
      const prev = this.phase;
      this.phase += f * dt;
      const crossed = (mark) => {
        const a = cyc(prev), b = cyc(this.phase);
        return a <= b ? mark > a && mark <= b : mark > a || mark <= b;
      };
      for (const e of LOPE) {
        const foot = this.feet[e.i];
        if (foot.planted && crossed(e.up)) {
          this.step(e.i, foot.pos, 1, 0.4 + 0.05 * speed, this.yaw, 0.17);
          foot.swing.lope = { p0: this.phase, span: 1 + e.down - e.up, ahead: e.ahead, side: e.i ? 1 : -1 };
        }
      }
      // A planted foot left too far behind (a sudden stop, a turn) goes now.
      for (const e of LOPE) {
        const foot = this.feet[e.i];
        if (!foot.planted) continue;
        const back = -((foot.pos.x - this.x) * fwd.x + (foot.pos.z - this.z) * fwd.z);
        if (back > 1.7) {
          this.step(e.i, foot.pos, 1, 0.4 + 0.05 * speed, this.yaw, 0.17);
          foot.swing.lope = { p0: this.phase, span: 0.66, ahead: e.ahead, side: e.i ? 1 : -1 };
        }
      }
      // The pelvis: down a little in stance, up on a ballistic arc between.
      const p = cyc(this.phase);
      const tf = 0.66 / f;
      const apex = (BODY.G * tf * tf) / 8;
      if (p < 0.34) lift = -0.16 * Math.sin((Math.PI * p) / 0.34);
      else {
        const u = (p - 0.34) / 0.66;
        lift = 4 * apex * u * (1 - u);
      }
    }
    // Swinging feet move; planted ones stay put.
    for (let i = 0; i < 2; i++) {
      const foot = this.feet[i];
      const sw = foot.swing;
      if (!sw) continue;
      let s;
      if (sw.lope && this.mode === 'lope') {
        // Locked to the stride: it lands when the stride says.
        s = clamp((this.phase - sw.lope.p0) / sw.lope.span, 0, 1);
        const remain = ((1 - s) * sw.lope.span) / f;
        sw.to.set(this.x + this.vx * remain, 0, this.z + this.vz * remain).addScaledVector(fwd, sw.lope.ahead).addScaledVector(right, sw.lope.side * 0.27);
        sw.to.y = this.ground(sw.to.x, sw.to.z);
        sw.toYaw = this.yaw;
      } else {
        if (sw.lope) {
          // The lope ended mid-stride: come down by the body instead.
          sw.lope = null;
          sw.from.copy(foot.pos);
          sw.to.copy(this.rest(i));
          sw.t = 0;
          sw.dur = 0.35;
          sw.fromPitch = foot.pitch;
          sw.fromYaw = foot.yaw;
          sw.height = 0.15;
        }
        sw.t += dt;
        s = clamp(sw.t / sw.dur, 0, 1);
      }
      const e = s * s * (3 - 2 * s);
      foot.pos.x = lerp(sw.from.x, sw.to.x, e);
      foot.pos.z = lerp(sw.from.z, sw.to.z, e);
      // Clearance over whatever is between, and an arc over that.
      const g = this.ground(foot.pos.x, foot.pos.z);
      foot.pos.y = Math.max(lerp(sw.from.y, sw.to.y, e), g) + sw.height * Math.pow(Math.sin(Math.PI * s), 0.85);
      foot.yaw = lerp(sw.fromYaw, sw.fromYaw + wrapAngle(sw.toYaw - sw.fromYaw), e);
      foot.pitch = lerp(sw.fromPitch, 0, smoothstep(0, 0.45, s)) - sw.strike * smoothstep(0.55, 1, s);
      if (s >= 1) {
        foot.pos.copy(sw.to);
        this.land(foot, i);
      }
    }
    if (this.mode === 'lope') {
      // Planted feet: off the heel after landing, onto the toes before lifting.
      const p = cyc(this.phase);
      for (const e of LOPE) {
        const foot = this.feet[e.i];
        if (!foot.planted) continue;
        const u = clamp((p - e.down) / (e.up - e.down), 0, 1);
        foot.pitch = 0.5 * smoothstep(0.5, 1, u) - 0.17 * (1 - smoothstep(0, 0.2, u));
      }
    } else {
      // Standing or settling: keep the feet under the body, one at a time.
      const busy = this.feet.some((ft) => ft.swing);
      if (this.mode === 'settle' && !busy && speed < 0.3) this.mode = 'stand';
      // About to run: no new steps; the run starts from where the feet are.
      const wantsRun = Math.hypot(wx, wz) > 1.45;
      if (!busy && !wantsRun) {
        let worst = -1, worstD = 0;
        for (let i = 0; i < 2; i++) {
          const r = this.rest(i);
          const foot = this.feet[i];
          const d = Math.hypot(r.x - foot.pos.x, r.z - foot.pos.z) + Math.abs(wrapAngle(foot.yaw - this.yaw)) * 0.55;
          if (d > worstD) {
            worstD = d;
            worst = i;
          }
        }
        // Step sooner when moving, so slow walking is stepping too.
        if (worstD > (speed > 0.15 ? 0.22 : 0.3)) {
          const to = this.rest(worst).addScaledVector(new T.Vector3(this.vx, 0, this.vz), 0.4);
          to.y = this.ground(to.x, to.z);
          this.step(worst, to, 0.42, 0.22, this.yaw, 0.06);
        }
      }
      for (const foot of this.feet) if (foot.planted) foot.pitch = 0;
      lift = -0.05 + 0.012 * Math.sin(this.time * 1.7);
    }
    this.lift += (lift - this.lift) * (this.mode === 'lope' ? 1 : 1 - Math.exp(-dt / 0.15));

    // Feet, then the pelvis: no higher than the planted feet allow.
    const feet = this.feet.map((foot) => {
      const fd = fwdOf(foot.yaw);
      return foot.planted ? footOn(foot.pos, fd, foot.pitch, this.ground) : footOn(foot.pos, fd, foot.pitch, () => foot.pos.y, this.ground);
    });
    const gy = this.ground(this.x, this.z);
    const orient = yawQ(this.yaw);
    const pel = new T.Vector3(this.x, gy + BODY.STAND - 0.12 + this.lift, this.z);
    const hip = new T.Vector3();
    for (let i = 0; i < 2; i++) {
      if (!this.feet[i].planted) continue;
      this.man.hipWorld(i, pel, orient, hip);
      const h = Math.hypot(hip.x - feet[i].ankle.x, hip.z - feet[i].ankle.z);
      const R = BODY.REACH * 0.985;
      const over = hip.y - feet[i].ankle.y - Math.sqrt(Math.max(0, R * R - h * h));
      if (over > 0) pel.y -= over;
    }
    const lean = this.mode === 'lope' ? 0.1 + 0.025 * speed : 0.04 + 0.04 * speed;
    const pose = {
      pelvis: pel,
      orient,
      lean,
      hipPitch: 0.05,
      look: -lean * 0.7,
      feet,
      arms: [0, 1].map((i) => {
        if (this.mode === 'lope') {
          const ph = (this.phase + (i ? 0.5 : 0)) * Math.PI * 2;
          return { fk: [0.35 + 0.12 * Math.sin(ph), 0.22, 1.0 + 0.1 * Math.sin(ph)] };
        }
        return { fk: [0.14, 0.17, 0.5] };
      }),
    };
    this.lastPose = pose;
    return pose;
  }

  /** Footfalls since last asked. */
  takePrints() {
    const p = this.prints;
    this.prints = [];
    return p;
  }
}
