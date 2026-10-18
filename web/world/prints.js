// Boot prints. Every footfall leaves one, and nothing on the Moon will
// fill it in: they stay from game to game.

import * as T from '../vendor/three.js';

const MAX = 900;

function printTexture() {
  const W = 128, H = 64;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  // The overshoe's outline: a rounded sole, wider at the toe.
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(10, 32);
  ctx.bezierCurveTo(10, 14, 28, 12, 44, 13);
  ctx.lineTo(96, 9);
  ctx.bezierCurveTo(122, 8, 124, 56, 96, 55);
  ctx.lineTo(44, 51);
  ctx.bezierCurveTo(28, 52, 10, 50, 10, 32);
  ctx.closePath();
  ctx.clip();
  // Ribs across it: dark grooves, light ridges.
  for (let x = 8; x < 124; x += 7) {
    ctx.fillStyle = '#c8c8c8';
    ctx.fillRect(x, 0, 4, H);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x + 4, 0, 3, H);
  }
  ctx.restore();
  // A soft rim pushed up around it.
  const t = new T.CanvasTexture(c);
  t.colorSpace = T.NoColorSpace;
  return t;
}

export class Prints {
  constructor(scene) {
    const g = new T.PlaneGeometry(1.0, 0.5);
    g.rotateX(-Math.PI / 2);
    g.translate(0.18, 0, 0); // the sole runs from the heel to past the toe
    const mat = new T.MeshStandardMaterial({
      color: 0x6c6a66, roughness: 1, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    if (typeof document !== 'undefined') mat.alphaMap = printTexture();
    mat.opacity = 0.75;
    this.mesh = new T.InstancedMesh(g, mat, MAX);
    this.mesh.count = 0;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.list = [];
    this.k = 0;
    this._m = new T.Matrix4();
  }

  add(x, y, z, yaw) {
    const i = this.k;
    this.k = (this.k + 1) % MAX;
    const p = [x, y, z, yaw];
    this.list[i] = p;
    this.set(i, p);
    this.mesh.count = Math.min(MAX, this.list.length);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  set(i, [x, y, z, yaw]) {
    this._m.makeRotationY(yaw);
    this._m.setPosition(x, y + 0.01, z);
    this.mesh.setMatrixAt(i, this._m);
  }

  /** Put them back on the ground after it has changed height. */
  reground(groundAt) {
    for (let i = 0; i < this.list.length; i++) {
      this.list[i][1] = groundAt(this.list[i][0], this.list[i][2]);
      this.set(i, this.list[i]);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  set visible(v) {
    this.mesh.visible = v;
  }
}
