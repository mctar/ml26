// A crash: the car comes apart into pieces of itself (the body in slices,
// dented, the wheels, the canopy in shards), which fly on arcs at a sixth
// of a g, bounce, slide and stop. With them, regolith thrown up from the
// impact in a curtain of arcs, and a spray of hot fragments that cool as
// they go. No smoke: there is nothing to make it of, and nothing to hold
// it up.

import * as T from '../vendor/three.js';
import { bodyGeometry, crumple, CAR, safeNormals } from './car.js';
import { Ballistic } from './ballistic.js';

const G = 5.32;
const _v = new T.Vector3(), _w = new T.Vector3(), _q = new T.Quaternion();

class Piece {
  constructor(object, pos, quat, vel, spin) {
    this.o = object;
    this.o.position.copy(pos);
    this.o.quaternion.copy(quat);
    this.v = vel.clone();
    this.w = spin.clone();
    this.asleep = false;
    // Points on its outside, for meeting the ground.
    const box = new T.Box3().setFromObject(object, true);
    const inv = new T.Matrix4().copy(object.matrixWorld).invert();
    this.pts = [];
    for (let i = 0; i < 8; i++) {
      const p = new T.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      this.pts.push(p.applyMatrix4(inv));
    }
  }

  step(dt, ground) {
    if (this.asleep) return;
    this.v.y -= G * dt;
    this.o.position.addScaledVector(this.v, dt);
    const wl = this.w.length();
    if (wl > 1e-5) {
      _q.setFromAxisAngle(_w.copy(this.w).divideScalar(wl), wl * dt);
      this.o.quaternion.premultiply(_q);
    }
    this.o.updateMatrixWorld(true);
    // The lowest corner against the ground.
    let low = Infinity, at = null;
    for (const p of this.pts) {
      _v.copy(p).applyMatrix4(this.o.matrixWorld);
      const d = _v.y - ground(_v.x, _v.z);
      if (d < low) {
        low = d;
        at = _v.clone();
      }
    }
    if (low < 0) {
      this.o.position.y -= low;
      if (this.v.y < 0) {
        // A dull bounce: most of the speed goes into the ground.
        this.v.y = -this.v.y * 0.28;
        this.v.x *= 0.62;
        this.v.z *= 0.62;
        // The blow turns it about the corner that hit.
        _w.copy(at).sub(this.o.position).cross(new T.Vector3(0, 1, 0)).multiplyScalar(-0.4 * Math.abs(this.v.y));
        this.w.multiplyScalar(0.55).add(_w);
      }
      // Sliding on the ground.
      this.v.x *= 1 - Math.min(1, 2.5 * dt);
      this.v.z *= 1 - Math.min(1, 2.5 * dt);
      this.w.multiplyScalar(1 - Math.min(1, 3 * dt));
      if (this.v.length() < 0.35 && this.w.length() < 0.25) this.asleep = true;
    }
  }
}

export class Debris {
  /**
   * @param car    the Car that crashed (its pieces are copied from it)
   * @param v      its velocity at the crash, ft/s
   * @param random a seeded generator
   */
  constructor(scene, car, v, random, groundAt) {
    this.scene = scene;
    this.group = new T.Group();
    this.pieces = [];
    this.ground = groundAt;
    const R = random;
    car.group.updateMatrixWorld(true);
    const M = car.body.matrixWorld;
    const centre = new T.Vector3().setFromMatrixPosition(car.group.matrixWorld);
    const kick = (p, k) => {
      // Outward from the centre and up, on top of what the car had.
      const out = p.clone().sub(centre).setY(0).normalize();
      return new T.Vector3(out.x * k * (0.5 + R()), k * (0.6 + 0.9 * R()), out.z * k * (0.5 + R())).add(new T.Vector3(v.x * 0.4, Math.max(-v.y, 0) * 0.12, 0));
    };
    const spin = (k) => new T.Vector3(R() - 0.5, R() - 0.5, R() - 0.5).multiplyScalar(k);
    // The body in slices, each dented its own way.
    const cuts = [-CAR.HALF, -4.6, -2.2, 0.4, 2.9, CAR.HALF];
    for (let i = 0; i < cuts.length - 1; i++) {
      const g = bodyGeometry({ x0: cuts[i], x1: cuts[i + 1], stations: 24 });
      crumple(g, 0.18 + 0.2 * R(), 1 + i * 3.7);
      const mid = (cuts[i] + cuts[i + 1]) / 2;
      g.translate(-mid, -1.4, 0);
      const m = new T.Mesh(g, [car.mats.paint, car.mats.dark]);
      m.castShadow = true;
      m.receiveShadow = true;
      const p = new T.Vector3(mid, 1.4 + car.heave, 0).applyMatrix4(M);
      const q = new T.Quaternion().setFromRotationMatrix(M);
      this.add(m, p, q, kick(p, 9 + 10 * R()), spin(3));
    }
    // The wheels, whole.
    for (const w of car.wheels) {
      if (!w.group.visible) continue;
      const m = w.group.clone(true);
      const p = new T.Vector3().setFromMatrixPosition(w.group.matrixWorld);
      const q = new T.Quaternion().setFromRotationMatrix(w.group.matrixWorld);
      m.position.set(0, 0, 0);
      m.quaternion.identity();
      this.add(m, p, q, kick(p, 12 + 12 * R()), spin(6));
    }
    // The canopy in shards.
    const glass = car.mats.glass.clone();
    glass.opacity = 0.65;
    for (let i = 0; i < 26; i++) {
      const s = 0.25 + 0.5 * R();
      const g = new T.BufferGeometry().setFromPoints([new T.Vector3(0, 0, 0), new T.Vector3(s, 0.1 * R(), 0.3 * s * R()), new T.Vector3(s * R(), 0.05, s * (0.5 + R()))]);
      safeNormals(g);
      const m = new T.Mesh(g, glass);
      const p = new T.Vector3(-0.8 + 2.6 * (R() - 0.5), 3.2 + R() * 0.8, (R() - 0.5) * 2.4).applyMatrix4(M);
      this.add(m, p, new T.Quaternion(), kick(p, 14 + 18 * R()), spin(14));
    }
    scene.add(this.group);

    // The impact: regolith thrown up and out, and hot fragments.
    this.ejecta = new Ballistic(scene, { n: 4000, color: [0.36, 0.345, 0.32], opacity: 0.75, streak: 0.05 });
    this.sparks = new Ballistic(scene, { n: 300, color: [2.0, 1.4, 0.85], opacity: 0.9, additive: true, streak: 0.035, order: 6 });
    const gy = groundAt(centre.x, centre.z);
    this.time = 0;
    for (let i = 0; i < 3200; i++) {
      const a = R() * Math.PI * 2;
      const el = (20 + 55 * R()) * (Math.PI / 180);
      const sp = 6 + 55 * Math.pow(R(), 1.6);
      const p = new T.Vector3(centre.x + Math.cos(a) * 3 * R(), gy + 0.2, centre.z + Math.sin(a) * 2 * R());
      const vv = new T.Vector3(Math.cos(a) * Math.cos(el) * sp, Math.sin(el) * sp, Math.sin(a) * Math.cos(el) * sp * 0.8);
      const flight = (2 * vv.y) / G;
      this.ejecta.throw(p, vv, flight + 0.3, 0.06 + 0.16 * R(), gy - 0.3, 0.7 + 0.5 * R());
    }
    for (let i = 0; i < 220; i++) {
      const a = R() * Math.PI * 2;
      const el = (5 + 80 * R()) * (Math.PI / 180);
      const sp = 25 + 110 * R();
      const p = centre.clone().add(new T.Vector3(0, 1.2, 0));
      const vv = new T.Vector3(Math.cos(a) * Math.cos(el) * sp, Math.sin(el) * sp, Math.sin(a) * Math.cos(el) * sp);
      this.sparks.throw(p, vv, 0.08 + 0.4 * R() * R(), 0.025 + 0.03 * R(), gy - 1);
    }
    this.ejecta.update(0);
    this.sparks.update(0);
  }

  add(object, pos, quat, vel, spin) {
    this.group.add(object);
    object.updateMatrixWorld(true);
    this.pieces.push(new Piece(object, pos, quat, vel, spin));
  }

  step(dt) {
    this.time += dt;
    for (const p of this.pieces) p.step(dt, this.ground);
    this.ejecta.update(this.time);
    this.sparks.update(this.time);
  }

  dispose() {
    this.scene.remove(this.group, this.ejecta.mesh, this.sparks.mesh);
    this.group.traverse((o) => o.geometry && o.geometry.dispose());
    this.ejecta.mesh.geometry.dispose();
    this.sparks.mesh.geometry.dispose();
  }
}
