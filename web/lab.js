// The lab: pieces of the 2026 view on their own, and recorded flights
// replayed frame by frame, deterministically, for checking by eye and by
// number. Not linked from the site.
//
//   lab.html?scene=car            the car on flat ground
//   lab.html?scene=walk           the driver walking on uneven ground
//   lab.html?scene=climb          the driver and the car
//   lab.html?scene=replay&file=…  a recording from tools/lab/record.mjs,
//                                 e.g. node tools/lab/record.mjs 1 web/.lab/diner.json 105
//                                 then ?scene=replay&file=.lab/diner.json
//
// Everything is driven from outside through window.lab (see the test
// scripts), so frames can be stepped and captured exactly.

import * as T from './vendor/three.js';
import { Car, CAR, insideBody } from './world/car.js';
import { makeEnvironment } from './world/env.js';
import { Astronaut, Gait, BODY } from './world/astronaut.js';

const canvas = document.getElementById('c');
const info = document.getElementById('info');
const q = new URLSearchParams(location.search);
const sceneName = q.get('scene') || 'car';

// The replay brings its own renderer (the 2026 view's); the others share this.
const renderer = sceneName === 'replay' ? null : new T.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
if (renderer) {
  renderer.setPixelRatio(1);
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFShadowMap;
}

const lab = (window.lab = { T, renderer, CAR, BODY, insideBody, ready: sceneName !== 'replay' && sceneName !== 'climb' });

function fit(camera) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

/** A sunlit stage with ground from a height function. */
function stage(groundFn, size = 120) {
  const scene = new T.Scene();
  scene.background = new T.Color(0);
  const sunDir = new T.Vector3(-0.45, 0.5, 0.75).normalize();
  const env = makeEnvironment(renderer, sunDir);
  const sun = new T.DirectionalLight(0xfff4e0, 3.2);
  sun.position.copy(sunDir).multiplyScalar(60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 200 });
  sun.shadow.bias = -0.0004;
  scene.add(sun, sun.target);
  scene.add(new T.HemisphereLight(0x323a48, 0x4a4640, 0.35));
  const g = new T.PlaneGeometry(size, size, 240, 240);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, groundFn(p.getX(i), p.getZ(i)));
  g.computeVertexNormals();
  const ground = new T.Mesh(g, new T.MeshStandardMaterial({ color: 0x7d7a75, roughness: 1 }));
  ground.receiveShadow = true;
  scene.add(ground);
  const camera = new T.PerspectiveCamera(32, 1, 0.1, 2000);
  Object.assign(lab, { scene, sun, env, camera, groundFn });
  lab.shoot = (pos, look, opts = {}) => {
    fit(camera);
    if (opts.fov) camera.fov = opts.fov;
    camera.position.set(...pos);
    camera.lookAt(new T.Vector3(...look));
    camera.updateProjectionMatrix();
    sun.target.position.set(...look);
    sun.position.copy(sun.target.position).addScaledVector(sunDir, 60);
    renderer.render(scene, camera);
    return canvas.toDataURL('image/png');
  };
  return { scene, env };
}

if (sceneName === 'car') {
  const { scene, env } = stage(() => 0);
  const car = new Car({ env });
  scene.add(car.group);
  car.place(0, 0, 0, () => 0, 0);
  lab.car = car;
  lab.view = (pos, look, opts = {}) => {
    if (opts.canopy !== undefined) car.setCanopy(opts.canopy);
    if (opts.angle !== undefined || opts.y !== undefined) car.place(0, opts.y || 0, opts.angle || 0, opts.ground || (() => 0), 1 / 30);
    return lab.shoot(pos, look, opts);
  };
  info.textContent = 'car';
}

if (sceneName === 'walk') {
  const ground = (x, z) => 0.45 * Math.sin(x * 0.31) + 0.25 * Math.sin(z * 0.8 + x * 0.17) + 0.12 * Math.sin(x * 1.3 + 2);
  const { scene, env } = stage(ground);
  const man = new Astronaut(env);
  scene.add(man.root);
  const gait = new Gait(ground, man);
  gait.reset(0, 0, 0);
  lab.man = man;
  lab.gait = gait;
  /** Step the gait toward a goal for n frames at dt, checking feet. */
  lab.run = (goal, n, dt = 1 / 60) => {
    const worst = { pen: 0, slip: 0, float: 0 };
    const was = gait.feet.map((f) => (f.planted ? f.pos.clone() : null));
    for (let k = 0; k < n; k++) {
      const pose = gait.update(dt, typeof goal === 'function' ? goal(k) : goal);
      man.apply(pose);
      for (const pr of man.probes()) {
        if (!/toe|heel|sole/.test(pr.name)) continue;
        const d = pr.p.y - ground(pr.p.x, pr.p.z);
        worst.pen = Math.min(worst.pen, d);
      }
      for (let i = 0; i < 2; i++) {
        const f = gait.feet[i];
        if (f.planted && was[i]) worst.slip = Math.max(worst.slip, Math.hypot(f.pos.x - was[i].x, f.pos.z - was[i].z));
        was[i] = f.planted ? f.pos.clone() : null;
        // A planted foot's ankle must be where the leg put it.
        if (f.planted) {
          const leg = man.legs[i];
          const a = new T.Vector3();
          leg.ankle.getWorldPosition(a);
          worst.float = Math.max(worst.float, a.distanceTo(pose.feet[i].ankle));
        }
      }
    }
    return worst;
  };
  info.textContent = 'walk';
}

if (sceneName === 'climb') {
  const tilt = Number(q.get('tilt') || 0); // the car's angle, degrees
  const slope = Number(q.get('slope') || 0); // the ground's slope along x
  const ground = (x, z) => slope * x + 0.15 * Math.sin(z * 0.6) * (z > 3 ? 1 : 0);
  const { scene, env } = stage(ground);
  const { Choreo, EXIT, canopyOut } = await import('./world/choreo.js');
  const { inFitting } = await import('./world/car.js');
  const car = new Car({ env });
  scene.add(car.group);
  const man = new Astronaut(env);
  scene.add(man.root);
  const climb = new Choreo(EXIT);
  for (let k = 0; k < 90; k++) car.place(0, ground(0, 0), tilt, (x) => ground(x, 0), 1 / 30);
  Object.assign(lab, { car, man, climb, ground });
  const inv = new T.Matrix4();
  const dirs = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  /** Pose at t and list what is where it should not be. */
  lab.at = (t) => {
    car.setCanopy(canopyOut(t));
    const pose = climb.pose(t, car, ground);
    man.apply(pose);
    car.body.updateWorldMatrix(true, false);
    inv.copy(car.body.matrixWorld).invert();
    const bad = [];
    for (const pr of man.probes()) {
      let worst = null;
      for (const d of dirs) {
        const w = pr.p.clone().add(new T.Vector3(...d).multiplyScalar(pr.r * 0.85));
        const l = w.clone().applyMatrix4(inv);
        const hit = insideBody(l) ? 'body' : inFitting(l);
        if (hit) worst = hit;
        if (w.y < ground(w.x, w.z) - 0.02) worst = 'ground';
      }
      if (worst) bad.push(pr.name + ':' + worst);
    }
    return bad;
  };
  info.textContent = 'climb';
  lab.ready = true;
}

if (sceneName === 'replay') {
  // A recorded flight through the real 2026 view, frame by frame.
  const { Roadster } = await import('./roadster.js');
  const { inFitting } = await import('./world/car.js');
  const rec = await (await fetch(q.get('file'))).json();
  const F = Object.fromEntries(rec.fields.map((f, i) => [f, i]));
  const S = rec.symbols;
  let table = rec.tables[0];
  let nextTable = 1;
  const peek = (addr) => {
    if (addr >= S.TERAIN && addr < S.TERAIN + 2 * 911) return table[1][(addr - S.TERAIN) >> 1];
    if (addr >= rec.featurBase && addr < rec.featurBase + 2 * table[2].length) return table[2][(addr - rec.featurBase) >> 1];
    return 0;
  };
  const world = new Roadster(canvas, document.getElementById('tube'));
  world.rate = 1;
  world.load(S, peek);
  world.maxThrust = S.MAXTRS;
  const stateAt = (i) => {
    const s = {};
    for (const f of rec.fields) s[f] = rec.frames[i][F[f]];
    return s;
  };
  // Touchdown: the first landing message, or the first frame on the ground.
  const names = Object.fromEntries(Object.entries(S).map(([k, v]) => [v, k]));
  let i = 0;
  const down = rec.frames.findIndex((fr) => ['GREATM', 'GOODM', 'ROUGHM', 'CRIPM', 'DEADM'].includes(names[fr[F.sysmes]]) && fr[F.verdis] < 450);
  const inv = new T.Matrix4();
  const dirs = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const report = { worst: {}, bad: [] };
  const note = (k, v, frame) => {
    if (report.worst[k] === undefined || v < report.worst[k][0]) report.worst[k] = [v, frame];
  };
  /** Check the frame: the man against the ground and the car; the car's
   * wheels and hull against the ground. */
  function check() {
    const st = world.lastState;
    if (st.t < 30.6e6 || world.scaleY === 1) return; // the greeting; the far view, where the car is drawn huge
    const g = (x, z) => world.groundAt(x, z);
    const car = world.car;
    car.group.updateMatrixWorld(true);
    inv.copy(car.body.matrixWorld).invert();
    if (world.man.root.visible) {
      const bad = [];
      for (const pr of world.man.probes()) {
        const sole = /toe|heel|sole/.test(pr.name);
        const gd = pr.p.y - pr.r * 0.85 - g(pr.p.x, pr.p.z);
        note(sole ? 'sole-ground' : 'body-ground', gd, i);
        if (gd < -0.03) bad.push(pr.name + ':ground ' + gd.toFixed(2));
        if (world.driver.mode !== 'seated') {
          for (const d of dirs) {
            const w = pr.p.clone().add(new T.Vector3(...d).multiplyScalar(pr.r * 0.85));
            const l = w.applyMatrix4(inv);
            if (sole) l.y += 0.04;
            const hit = lab.insideBody(l) ? 'body' : inFitting(l);
            if (hit) {
              bad.push(pr.name + ':' + hit);
              break;
            }
          }
        }
      }
      if (bad.length) report.bad.push([i, world.driver.mode, bad.join(' '), +world.driver.t.toFixed(2)]);
    }
    if (world.car.group.visible) {
      for (const w of car.wheels) {
        if (!w.group.visible) continue;
        const c = new T.Vector3().setFromMatrixPosition(w.group.matrixWorld);
        note('tyre-ground', c.y - w.r * car.group.scale.x - g(c.x, c.z), i);
      }
      let low = Infinity;
      for (const p of car.hull) {
        const q2 = p.clone().applyMatrix4(car.body.matrixWorld);
        low = Math.min(low, q2.y - g(q2.x, q2.z));
      }
      note('hull-ground', low, i);
    }
  }
  /** Run to frame `to` (absolute), checking each. */
  lab.run = (to) => {
    to = Math.min(to, rec.frames.length - 1);
    for (; i <= to; i++) {
      while (nextTable < rec.tables.length && rec.tables[nextTable][0] <= i) table = rec.tables[nextTable++];
      const st = stateAt(i);
      world.update(st, st.t / 1000, 1 / 30);
      check();
    }
    return i;
  };
  lab.shot = (cam) => {
    const c = world.camera;
    const was = [c.position.clone(), c.quaternion.clone()];
    if (cam) {
      c.position.set(...cam.pos);
      c.lookAt(new T.Vector3(...cam.look));
      if (cam.fov) c.fov = cam.fov;
      c.updateProjectionMatrix();
    }
    world.render();
    world.render(); // the headless GPU now and then hands back an empty frame
    const url = canvas.toDataURL('image/png');
    c.position.copy(was[0]);
    c.quaternion.copy(was[1]);
    return url;
  };
  Object.assign(lab, { world, rec, down, report, frameAt: () => i, stateAt, names });
  info.textContent = 'replay ' + q.get('file');
  lab.ready = true;
}
