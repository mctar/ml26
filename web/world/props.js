// What the driver carries: a flag, folded small in his pack until it is
// wanted, and, from the McDonald's, his order in a box with a familiar
// angular profile, in brushed steel. No marks on either beyond the flag's.

import * as T from '../vendor/three.js';
import { smoothstep, lerp } from './shape.js';

// The pole telescopes in three tubes; folded it is a short staff.
const TUBES = [{ r: 0.064, l: 2.7 }, { r: 0.054, l: 2.6 }, { r: 0.045, l: 2.5 }];
const CLOTH = [4.4, 2.75];

function flagTexture() {
  const c = document.createElement('canvas');
  c.width = 380;
  c.height = 200;
  const ctx = c.getContext('2d');
  for (let i = 0; i < 13; i++) {
    ctx.fillStyle = i % 2 ? '#f4f2ee' : '#b0223a';
    ctx.fillRect(0, (i * 200) / 13, 380, 200 / 13 + 1);
  }
  ctx.fillStyle = '#1f2f5c';
  ctx.fillRect(0, 0, 152, (200 * 7) / 13);
  ctx.fillStyle = '#f4f2ee';
  for (let r = 0; r < 9; r++) {
    const n = r % 2 ? 5 : 6;
    for (let k = 0; k < n; k++) {
      ctx.beginPath();
      ctx.arc((r % 2 ? 25 : 12.5) + k * 25.3, 9 + r * 11.4, 3.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const tex = new T.CanvasTexture(c);
  tex.colorSpace = T.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

let FLAG_TEX = null;

/** A lunar flag: a telescoping pole, a crossbar at the top to hold the
 * cloth out (there is no air to do it), the cloth with its packing creases. */
export class Flag {
  constructor(env = null) {
    if (!FLAG_TEX && typeof document !== 'undefined') FLAG_TEX = flagTexture();
    const metal = new T.MeshStandardMaterial({ color: 0xd6d8dc, metalness: 0.9, roughness: 0.3, envMap: env });
    this.group = new T.Group();
    this.tubes = [];
    let parent = this.group;
    for (const [i, tb] of TUBES.entries()) {
      const slide = new T.Group();
      const m = new T.Mesh(new T.CylinderGeometry(tb.r, tb.r, tb.l, 10), metal);
      m.geometry.translate(0, -tb.l / 2, 0); // hangs from its top
      m.castShadow = true;
      slide.add(m);
      parent.add(slide);
      this.tubes.push(slide);
      parent = slide;
      if (i === 0) slide.position.y = tb.l;
    }
    this.top = parent;
    // The crossbar on a hinge at the top; the cloth hangs from it.
    this.hinge = new T.Group();
    this.top.add(this.hinge);
    const bar = new T.Mesh(new T.CylinderGeometry(0.032, 0.032, CLOTH[0] + 0.1, 8), metal);
    bar.rotation.z = Math.PI / 2;
    bar.position.x = CLOTH[0] / 2;
    bar.castShadow = true;
    this.hinge.add(bar);
    const g = new T.PlaneGeometry(CLOTH[0], CLOTH[1], 28, 14);
    g.translate(CLOTH[0] / 2, -CLOTH[1] / 2, 0);
    // Packing creases and a little sag, fixed: nothing moves it but him.
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i) / CLOTH[0], v = -p.getY(i) / CLOTH[1];
      p.setZ(i, 0.09 * Math.sin(u * 9.5 + v * 1.5) * u + 0.05 * Math.sin(v * 13 + u * 4) * v + 0.12 * u * v * v);
    }
    g.computeVertexNormals();
    this.cloth = new T.Mesh(g, new T.MeshStandardMaterial({ map: FLAG_TEX, side: T.DoubleSide, roughness: 0.85, envMap: env, envMapIntensity: 0.4 }));
    this.cloth.castShadow = true;
    this.hinge.add(this.cloth);
    this.setOpen(1);
  }

  /** 0: folded short, bar down, cloth rolled; 1: tall, bar out, spread. */
  setOpen(k) {
    // Each inner tube slides up out of the one below.
    const ext = smoothstep(0, 0.55, k);
    this.tubes[1].position.y = lerp(0.12, TUBES[1].l - 0.2, ext);
    this.tubes[2].position.y = lerp(0.1, TUBES[2].l - 0.2, ext);
    this.hinge.rotation.z = lerp(-Math.PI / 2 + 0.04, 0, smoothstep(0.45, 0.8, k));
    const c = smoothstep(0.65, 1, k);
    this.cloth.scale.set(lerp(0.03, 1, c), lerp(0.05, 1, smoothstep(0.75, 1, k)), 1);
    this.cloth.visible = k > 0.6;
  }

  /** The pole's height when open. */
  static get height() {
    return TUBES[0].l + TUBES[1].l + TUBES[2].l - 0.4;
  }

  dispose() {
    this.group.traverse((o) => o.geometry && o.geometry.dispose());
  }
}

/** The order: an angular steel box. */
export function makeBox(env = null) {
  const s = new T.Shape();
  // Side profile: a flat bed, a long raked top meeting a short nose.
  s.moveTo(-0.55, 0);
  s.lineTo(0.55, 0);
  s.lineTo(0.55, 0.2);
  s.lineTo(0.02, 0.44);
  s.lineTo(-0.55, 0.3);
  s.closePath();
  const g = new T.ExtrudeGeometry(s, { depth: 0.58, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 1 });
  g.translate(0, -0.22, -0.29);
  const m = new T.Mesh(g, new T.MeshStandardMaterial({ color: 0xb9bcbf, metalness: 0.85, roughness: 0.38, envMap: env, envMapIntensity: 1.2 }));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** The props in one place, for the driver. */
export class Props {
  constructor(scene, env, groundAt) {
    this.scene = scene;
    this.groundAt = groundAt;
    this.flag = new Flag(env);
    this.box = makeBox(env);
    scene.add(this.flag.group, this.box);
    this.reset();
  }

  reset() {
    this.flagState = 'hidden';
    this.flag.group.visible = false;
    this.flag.setOpen(0);
    this.box.visible = false;
    this.boxState = 'none';
    this.plant = null;
  }

  /** The box on the counter, sliding out as k goes 0 to 1. */
  boxAt(x, y, z, k) {
    if (this.boxState === 'carried') return;
    this.boxState = 'counter';
    this.box.visible = k > 0;
    this.box.position.set(x, y, z - 0.5 + 0.5 * k);
    this.box.rotation.set(0, 0, 0);
  }

  carryBox(on) {
    this.boxState = on ? 'carried' : 'none';
    this.box.visible = on;
  }

  /** Keep what he holds with him: called after every pose. */
  follow(man, driver) {
    man.torso.updateWorldMatrix(true, false);
    if (this.boxState === 'carried') {
      if (driver.mode === 'out') {
        // Both hands, in front of him.
        this.box.position.set(0.86, 0.78, 0).applyMatrix4(man.torso.matrixWorld);
        this.box.quaternion.setFromRotationMatrix(man.torso.matrixWorld);
      } else {
        // One hand, on the way in; then on his lap.
        const grip = man.arms[0].grip;
        grip.updateWorldMatrix(true, false);
        this.box.position.setFromMatrixPosition(grip.matrixWorld);
        this.box.quaternion.setFromRotationMatrix(man.torso.matrixWorld);
        this.box.translateZ(0.24);
      }
    }
    if (this.flagState === 'held') {
      const grip = man.arms[1].grip;
      grip.updateWorldMatrix(true, false);
      const at = new T.Vector3().setFromMatrixPosition(grip.matrixWorld);
      // Upright, the hand a third of the way up the folded pole.
      this.flag.group.position.copy(at).add(new T.Vector3(0, -0.9, 0));
      this.flag.group.rotation.set(0, this.yaw, 0);
    }
  }

  /**
   * Planting the flag, s seconds in. `fx, z` is where it goes, `side` the
   * way he faces along x. Returns what his hands and head do.
   */
  plantFlag(s, man, fx, z, side) {
    const f = this.flag;
    const out = { arms: null, look: 0.25 };
    this.yaw = side > 0 ? 0 : Math.PI;
    if (s < 0.6) {
      // Over the shoulder, into the pack.
      out.arms = [null, { local: new T.Vector3(-0.62, 2.05, 0.82), pole: new T.Vector3(0, 1, 0.4).applyQuaternion(man.root.quaternion) }];
      out.look = 0.05;
      return out;
    }
    if (s < 1.9) {
      // Out it comes, in front of him; opened with both hands.
      if (this.flagState === 'hidden') {
        this.flagState = 'held';
        f.group.visible = true;
      }
      const k = smoothstep(0.6, 1.2, s);
      out.arms = [{ local: new T.Vector3(lerp(0.3, 0.72, k), lerp(0.9, 1.5, k), lerp(-0.6, 0.06, k)) }, { local: new T.Vector3(lerp(-0.62, 0.72, k), lerp(2.05, 0.95, k), lerp(0.82, 0.2, k)) }];
      f.setOpen(smoothstep(1.2, 1.9, s));
      return out;
    }
    const gy = this.groundAt(fx, z);
    if (this.flagState === 'held') {
      this.flagState = 'placing';
      this.plant = { from: f.group.position.clone() };
    }
    if (this.flagState === 'placing') {
      // To its place, and pushed in, twice.
      const k = smoothstep(1.9, 2.35, s);
      const push = smoothstep(2.4, 2.6, s) * 0.5 + smoothstep(2.7, 2.9, s) * 0.4;
      const to = new T.Vector3(fx, gy + 0.65 - push, z);
      f.group.position.copy(this.plant.from).lerp(to, k);
      f.group.rotation.set(0, this.yaw, 0);
      f.setOpen(1);
      const p = f.group.position;
      out.arms = [{ wrist: new T.Vector3(p.x - side * 0.2, p.y + 2.25, p.z + 0.14) }, { wrist: new T.Vector3(p.x - side * 0.2, p.y + 3.0, p.z - 0.1) }];
      out.look = 0.35;
      if (s >= 3.0) {
        this.flagState = 'planted';
        this.plant.at = s;
        f.group.position.y = gy - 0.25;
      }
      return out;
    }
    // In the ground: the twist it was given, dying away.
    const u = s - this.plant.at;
    f.group.rotation.y = this.yaw + 0.16 * Math.exp(-u / 1.5) * Math.sin(u * 5.2);
    out.look = 0;
    return out;
  }
}
