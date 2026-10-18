// The driver: an astronaut built from capsules and spheres with real
// joints, so he can sit, climb out, lope across the Moon the way people
// moved in a sixth of a g, plant a flag, salute, and climb back in.
// Everything is posed in code from a few parameters; no animation files.

import * as T from './vendor/three.js';

const HEIGHT = 6.2; // feet, suited

function capsule(r, len, mat) {
  // A capsule standing on the origin, length along +y.
  const m = new T.Mesh(new T.CapsuleGeometry(r, len, 4, 10), mat);
  m.geometry.translate(0, len / 2 + r, 0);
  m.castShadow = true;
  return m;
}

/** A limb segment hanging from a pivot: the pivot is the joint, the
 * geometry points down -y from it. */
function segment(r, len, mat) {
  const pivot = new T.Group();
  const m = new T.Mesh(new T.CapsuleGeometry(r, len, 4, 10), mat);
  m.geometry.translate(0, -len / 2 - r * 0.2, 0);
  m.castShadow = true;
  pivot.add(m);
  return pivot;
}

export class Astronaut {
  constructor() {
    const suit = new T.MeshStandardMaterial({ color: 0xf1f1ec, roughness: 0.82, metalness: 0.02 });
    const grey = new T.MeshStandardMaterial({ color: 0x8c8c90, roughness: 0.7, metalness: 0.2 });
    const dark = new T.MeshStandardMaterial({ color: 0x24262a, roughness: 0.6 });
    const visor = new T.MeshPhysicalMaterial({ color: 0xc89a3c, metalness: 1.0, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05, emissive: 0x3a2a08, emissiveIntensity: 0.35 });
    this.materials = { suit, grey, dark, visor };

    this.group = new T.Group();
    // Hips: the root of the body, at hip height; the legs hang from it.
    this.hips = new T.Group();
    this.hips.position.y = 3.05;
    this.group.add(this.hips);
    // Torso rises from the hips.
    this.torso = new T.Group();
    this.hips.add(this.torso);
    const belly = capsule(0.62, 0.9, suit);
    belly.position.y = -0.4;
    this.torso.add(belly);
    const chest = new T.Mesh(new T.BoxGeometry(0.9, 0.7, 1.1), suit);
    chest.position.set(0.25, 1.35, 0);
    chest.castShadow = true;
    this.torso.add(chest);
    // The chest control unit, and the life-support pack behind.
    const rcu = new T.Mesh(new T.BoxGeometry(0.3, 0.45, 0.75), grey);
    rcu.position.set(0.72, 1.1, 0);
    this.torso.add(rcu);
    const plss = new T.Mesh(new T.BoxGeometry(0.75, 1.6, 1.15), suit);
    plss.position.set(-0.75, 0.95, 0);
    plss.castShadow = true;
    this.torso.add(plss);
    const plssTop = new T.Mesh(new T.BoxGeometry(0.5, 0.25, 0.9), grey);
    plssTop.position.set(-0.75, 1.9, 0);
    this.torso.add(plssTop);
    // Neck ring and helmet.
    const ring = new T.Mesh(new T.CylinderGeometry(0.42, 0.42, 0.18, 16), grey);
    ring.position.set(0.15, 1.78, 0);
    this.torso.add(ring);
    this.head = new T.Group();
    this.head.position.set(0.15, 1.9, 0);
    this.torso.add(this.head);
    const helmet = new T.Mesh(new T.SphereGeometry(0.66, 20, 14), suit);
    helmet.position.y = 0.55;
    helmet.castShadow = true;
    this.head.add(helmet);
    const glass = new T.Mesh(new T.SphereGeometry(0.6, 20, 14, -Math.PI * 0.45, Math.PI * 0.9, Math.PI * 0.22, Math.PI * 0.5), visor);
    glass.position.set(0.12, 0.55, 0);
    glass.rotation.y = -Math.PI / 2;
    this.head.add(glass);
    // Arms: shoulder, elbow, glove.
    this.arms = [];
    for (const side of [-1, 1]) {
      const shoulder = segment(0.22, 1.15, suit);
      shoulder.position.set(0.2, 1.55, side * 0.75);
      const elbow = segment(0.2, 1.05, suit);
      elbow.position.y = -1.25;
      shoulder.add(elbow);
      const glove = new T.Mesh(new T.SphereGeometry(0.24, 12, 10), grey);
      glove.position.y = -1.3;
      elbow.add(glove);
      this.torso.add(shoulder);
      this.arms.push({ shoulder, elbow, side });
    }
    // Legs: hip, knee, boot.
    this.legs = [];
    for (const side of [-1, 1]) {
      const hip = segment(0.27, 1.35, suit);
      hip.position.set(0, -0.1, side * 0.38);
      const knee = segment(0.24, 1.3, suit);
      knee.position.y = -1.5;
      hip.add(knee);
      const boot = new T.Mesh(new T.BoxGeometry(0.85, 0.35, 0.5), dark);
      boot.position.set(0.18, -1.62, 0);
      boot.castShadow = true;
      knee.add(boot);
      this.hips.add(hip);
      this.legs.push({ hip, knee, side });
    }
    this.phase = 0;
    this.time = 0;
    this.mode = 'idle';
    this.t = 0; // progress of a timed action
    this.facing = 1; // +x
  }

  /** Pose the figure: `mode` is one of seated, idle, walk, wave, salute,
   * plant, climb; `p` is the action's progress or the walking speed. */
  update(dt, mode, p = 0) {
    this.time += dt;
    this.mode = mode;
    const lerp = (a, b, k) => a + (b - a) * k;
    const A = this.arms, L = this.legs;
    const setArm = (i, sh, el, out = 0) => {
      A[i].shoulder.rotation.z = sh;
      A[i].shoulder.rotation.x = out * A[i].side;
      A[i].elbow.rotation.z = el;
    };
    const setLeg = (i, hp, kn) => {
      L[i].hip.rotation.z = hp;
      L[i].knee.rotation.z = kn;
    };
    this.hips.position.y = 3.05;
    this.hips.rotation.set(0, 0, 0);
    this.torso.rotation.set(0, 0, 0);
    this.head.rotation.set(0, 0, 0);
    switch (mode) {
      case 'seated': {
        // In the car: thighs forward, shins down, hands on the wheel, the
        // left arm (toward the camera) out on the sill.
        this.hips.position.y = 1.35;
        this.torso.rotation.z = -0.12;
        setLeg(0, -1.35, 1.25);
        setLeg(1, -1.35, 1.25);
        setArm(0, -0.9, -1.1, 0);
        setArm(1, 0.35, -1.5, 0.9);
        this.head.rotation.z = 0.05;
        break;
      }
      case 'walk': {
        // The lope: long slow strides with a hop in each. `p` is speed in
        // feet per second; the stride keeps pace with the ground.
        const speed = Math.max(0.1, Math.abs(p));
        this.phase += dt * (speed / 7.5) * Math.PI * 2;
        const s = Math.sin(this.phase), c = Math.cos(this.phase);
        const hop = Math.max(0, Math.sin(this.phase * 2 + 0.6));
        this.hips.position.y = 3.05 + hop * 0.45;
        this.torso.rotation.z = -0.16 - 0.04 * c;
        setLeg(0, 0.7 * s, Math.max(0, -0.9 * c) + 0.15);
        setLeg(1, -0.7 * s, Math.max(0, 0.9 * c) + 0.15);
        setArm(0, -0.5 * s + 0.1, -0.5 - 0.2 * Math.max(0, -s), 0.08);
        setArm(1, 0.5 * s + 0.1, -0.5 - 0.2 * Math.max(0, s), 0.08);
        this.head.rotation.z = 0.12;
        break;
      }
      case 'wave': {
        // At the counter: right arm up, hand waving.
        const w = Math.sin(this.time * 7);
        setLeg(0, 0.05, 0.1);
        setLeg(1, -0.05, 0.1);
        setArm(0, 0.15, -0.35, 0.05);
        setArm(1, 2.6 + 0.15 * w, -0.5 + 0.3 * w, 0.4);
        this.head.rotation.z = -0.1;
        break;
      }
      case 'salute': {
        setLeg(0, 0.0, 0.05);
        setLeg(1, 0.0, 0.05);
        setArm(0, 0.1, -0.1, 0.05);
        setArm(1, 1.9, -2.5, 0.35);
        this.torso.rotation.z = 0.04;
        this.head.rotation.z = -0.06;
        break;
      }
      case 'plant': {
        // Both hands forward and down on the pole, pushing.
        const k = Math.min(1, p);
        setLeg(0, 0.35 * k, 0.4 * k);
        setLeg(1, -0.25 * k, 0.5 * k);
        setArm(0, -1.1 - 0.2 * k, -0.6 + 0.4 * k, -0.25);
        setArm(1, -1.1 - 0.2 * k, -0.6 + 0.4 * k, -0.25);
        this.torso.rotation.z = -0.25 * k;
        this.hips.position.y = 3.05 - 0.35 * k;
        break;
      }
      case 'climb': {
        // Out of the car (p from 0 to 1): seated, stands in the seat, steps
        // onto the sill, drops to the ground with the knees giving.
        const k = p;
        const stand = T.MathUtils.smoothstep(k, 0.0, 0.45);
        const drop = T.MathUtils.smoothstep(k, 0.55, 0.95);
        this.hips.position.y = lerp(1.35, 3.05, stand) - 0.5 * Math.sin(drop * Math.PI);
        this.torso.rotation.z = lerp(-0.12, -0.05, stand) + 0.25 * Math.sin(drop * Math.PI);
        const legBend = lerp(1.35, 0.1, stand) + 0.6 * Math.sin(drop * Math.PI);
        setLeg(0, -legBend, legBend * 0.95);
        setLeg(1, -legBend * 0.9, legBend * 0.9);
        setArm(0, lerp(-0.9, -0.3, stand), lerp(-1.1, -0.4, stand), 0.1);
        setArm(1, lerp(0.35, -0.3, stand), lerp(-1.5, -0.4, stand), lerp(0.9, 0.1, stand));
        break;
      }
      default: {
        // Standing, breathing.
        const b = Math.sin(this.time * 1.4) * 0.02;
        this.hips.position.y = 3.05 + b;
        setLeg(0, 0.03, 0.08);
        setLeg(1, -0.03, 0.08);
        setArm(0, 0.12, -0.3, 0.06);
        setArm(1, 0.12, -0.3, 0.06);
        this.torso.rotation.z = -0.03;
      }
    }
  }

  /** Face +x (1) or -x (-1). */
  face(dir) {
    this.facing = dir;
    this.group.rotation.y = dir > 0 ? 0 : Math.PI;
  }
}

export const ASTRONAUT_HEIGHT = HEIGHT;
