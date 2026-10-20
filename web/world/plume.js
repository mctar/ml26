// Cold gas in a vacuum. Nitrogen leaves a nozzle at well over a thousand
// feet a second and spreads as it goes, with nothing to slow it or hold it
// together: no flame, no billowing, no drift. What can be seen is the
// little that condenses, lit by the sun: a cone fixed to the nozzle,
// brightest at the throat and fading as the gas spreads (as the square of
// the distance), brighter looking toward the sun than away from it. It
// stops the instant the valve closes.
//
// Each jet is a cone drawn by marching rays through it. Where a jet meets
// the ground the gas runs out sideways along it: a flat, fast sheet, drawn
// as a disc; the dust it throws is ballistic.js.

import * as T from '../vendor/three.js';

/** How far down the gas still lifts dust, feet. */
const REACH = 60;

const vert = /* glsl */ `
varying vec3 vLocal;
varying vec3 vWorld;
void main() {
  vLocal = position;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const frag = /* glsl */ `
uniform float uTime;
uniform float uPower;     // 0..1, how much gas
uniform float uLength;    // cone length, ft
uniform float uTan;       // tan of the half angle
uniform float uR0;        // radius at the nozzle
uniform vec3 uSun;        // to the sun, in the jet's frame
uniform vec3 uCam;        // camera, in the jet's frame
uniform float uGround;    // world y of the ground under the jet
uniform mat4 uModel;
uniform float uSeed;
varying vec3 vLocal;
varying vec3 vWorld;

float h31(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float n3(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z);
}

// The gas: thick at the throat, thinning with the square of the distance,
// a soft core across, and fine streaks running out with the flow.
float density(vec3 p) {
  float h = p.y;
  if (h < 0.0 || h > uLength) return 0.0;
  float R = uR0 + h * uTan;
  float q = length(p.xz) / R;
  if (q > 1.0) return 0.0;
  float across = exp(-q * q * 2.6) * (1.0 - q * q);
  float along = 1.0 / pow(1.0 + h / (uR0 * 9.0), 2.0) * (1.0 - smoothstep(uLength * 0.55, uLength, h));
  float flow = h - uTime * 140.0;
  float streak = n3(vec3(p.x * 2.6 / R * 2.0, flow * 0.35, p.z * 2.6 / R * 2.0) + uSeed);
  float fine = n3(vec3(p.xz * 6.0, flow * 1.2) + uSeed * 3.0);
  return across * along * (0.55 + 0.7 * streak) * (0.8 + 0.4 * fine);
}

float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * c, 1.5) / 12.566; }

void main() {
  vec3 ro = uCam;
  vec3 rd = normalize(vLocal - ro);
  float tExit = length(vLocal - ro);
  // Where the ray enters: the cone's side or its ends, or here if inside.
  float h0 = uR0 / uTan; // apex behind the nozzle
  float k2 = uTan * uTan;
  float oy = ro.y + h0;
  float a = rd.x * rd.x + rd.z * rd.z - k2 * rd.y * rd.y;
  float b = 2.0 * (ro.x * rd.x + ro.z * rd.z - k2 * oy * rd.y);
  float c = ro.x * ro.x + ro.z * ro.z - k2 * oy * oy;
  float tEnter = tExit;
  float disc = b * b - 4.0 * a * c;
  if (disc > 0.0 && abs(a) > 1e-6) {
    float s = sqrt(disc);
    for (int i = 0; i < 2; i++) {
      float t = (-b + (i == 0 ? -s : s)) / (2.0 * a);
      float y = ro.y + rd.y * t;
      if (t > 0.0 && t < tEnter && y >= 0.0 && y <= uLength) tEnter = t;
    }
  }
  for (int i = 0; i < 2; i++) {
    float yc = i == 0 ? 0.0 : uLength;
    if (abs(rd.y) > 1e-5) {
      float t = (yc - ro.y) / rd.y;
      vec3 q = ro + rd * t;
      if (t > 0.0 && t < tEnter && length(q.xz) <= uR0 + yc * uTan) tEnter = t;
    }
  }
  bool inside = ro.y >= 0.0 && ro.y <= uLength && length(ro.xz) < uR0 + ro.y * uTan;
  if (inside) tEnter = 0.0;
  float span = tExit - tEnter;
  if (span <= 0.0) discard;

  const int N = 20;
  float dt = span / float(N);
  float jitter = h31(vec3(gl_FragCoord.xy, uTime * 60.0));
  float sum = 0.0;
  for (int i = 0; i < N; i++) {
    vec3 p = ro + rd * (tEnter + (float(i) + jitter) * dt);
    // Nothing below the ground.
    float wy = (uModel * vec4(p, 1.0)).y;
    if (wy < uGround) continue;
    sum += density(p) * dt;
  }
  float cosT = dot(rd, uSun);
  float phase = 0.55 * hg(cosT, 0.62) + 0.45 / 12.566;
  vec3 sun = vec3(1.0, 0.97, 0.92);
  vec3 col = sun * sum * uPower * phase * 85.0 + vec3(0.6, 0.7, 0.9) * sum * uPower * 0.25;
  gl_FragColor = vec4(col, 1.0);
}`;

/** One jet. */
class Jet {
  constructor(length, angle, r0) {
    const tan = Math.tan(angle);
    const g = new T.CylinderGeometry(r0, r0 + length * tan, length, 24, 1, false);
    g.translate(0, length / 2, 0); // the nozzle at the origin, the gas along +y
    this.uniforms = {
      uTime: { value: 0 }, uPower: { value: 0 }, uLength: { value: length }, uTan: { value: tan }, uR0: { value: r0 },
      uSun: { value: new T.Vector3() }, uCam: { value: new T.Vector3() }, uGround: { value: -1e9 }, uModel: { value: new T.Matrix4() },
      uSeed: { value: Math.random() * 100 },
    };
    this.mesh = new T.Mesh(g, new T.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: vert, fragmentShader: frag,
      side: T.BackSide, transparent: true, depthWrite: false, blending: T.AdditiveBlending,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.length = length;
  }
}

const _inv = new T.Matrix4(), _q = new T.Quaternion(), _up = new T.Vector3(0, 1, 0);

/**
 * The car's exhaust: four mains under the floor, and the attitude jets at
 * the corners, which fire in short puffs.
 */
export class Exhaust {
  constructor(scene, car, sunDir) {
    this.scene = scene;
    this.car = car;
    this.sunDir = sunDir;
    this.mains = car.mains.map((port) => ({ port, jet: new Jet(16, 0.4, 0.2) }));
    this.rcs = [];
    for (const [name, ports] of Object.entries(car.rcs)) for (const port of ports) this.rcs.push({ name, port, jet: new Jet(3.5, 0.45, 0.07) });
    for (const j of [...this.mains, ...this.rcs]) scene.add(j.jet.mesh);
    // Where the gas reaches the ground it runs out along it.
    this.splash = new T.Mesh(new T.CircleGeometry(1, 48), new T.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPower: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform float uTime; uniform float uPower; varying vec2 vUv;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        void main(){
          float r = length(vUv); if (r > 1.0) discard;
          float a = atan(vUv.y, vUv.x);
          // Radial streaks running outward, fast.
          float s = h(vec2(floor(a * 40.0), 0.0));
          float run = fract(r * 3.0 - uTime * 6.0 + s);
          float streak = smoothstep(0.0, 0.3, run) * (1.0 - smoothstep(0.3, 1.0, run));
          float fall = (1.0 - r) * (1.0 - r) * smoothstep(0.0, 0.12, r);
          float v = uPower * fall * (0.35 + 0.65 * streak * (0.5 + 0.5 * s));
          gl_FragColor = vec4(vec3(0.9, 0.92, 0.95) * v, 1.0);
        }`,
      transparent: true, depthWrite: false, blending: T.AdditiveBlending,
    }));
    this.splash.rotation.x = -Math.PI / 2;
    this.splash.renderOrder = 4;
    this.splash.visible = false;
    scene.add(this.splash);
    this.puffs = {}; // name -> seconds left
  }

  /** A short burst from one pair of attitude jets. */
  puff(name, dur = 0.12) {
    this.puffs[name] = Math.max(this.puffs[name] || 0, dur);
  }

  /**
   * Each frame: `power` 0..1 for the mains, the time, the camera, and the
   * ground under the car. Returns where the mains' gas meets the ground
   * and how strongly, for the dust.
   */
  update(time, dt, power, camera, groundAt, scale = 1) {
    const out = { hit: null, strength: 0, alt: Infinity };
    let n = 0;
    const centre = new T.Vector3();
    const all = [];
    for (const m of this.mains) all.push([m, power]);
    for (const r of this.rcs) {
      const left = this.puffs[r.name] || 0;
      // A puff comes on hard and goes off at once.
      all.push([r, left > 0 ? 0.55 * Math.min(1, left / 0.05) : 0]);
    }
    for (const name of Object.keys(this.puffs)) this.puffs[name] = Math.max(0, this.puffs[name] - dt);
    for (const [j, p] of all) {
      const mesh = j.jet.mesh, u = j.jet.uniforms;
      mesh.visible = p > 0.002;
      if (!mesh.visible) continue;
      const [pos, dir] = this.car.port(j.port);
      mesh.position.copy(pos);
      mesh.quaternion.copy(_q.setFromUnitVectors(_up, dir));
      mesh.scale.setScalar(scale);
      mesh.updateMatrixWorld(true);
      _inv.copy(mesh.matrixWorld).invert();
      u.uTime.value = time;
      u.uPower.value = p;
      u.uCam.value.copy(camera.position).applyMatrix4(_inv);
      u.uSun.value.copy(this.sunDir).transformDirection(_inv);
      u.uModel.value.copy(mesh.matrixWorld);
      u.uGround.value = groundAt(pos.x, pos.z);
      if (this.mains.includes(j) && dir.y < -0.2) {
        // Down the axis to the ground.
        const t = (pos.y - u.uGround.value) / -dir.y;
        if (t < REACH * scale) {
          centre.add(pos.clone().addScaledVector(dir, t));
          n++;
          out.alt = Math.min(out.alt, pos.y - u.uGround.value);
        }
      }
    }
    if (n > 0 && power > 0) {
      centre.divideScalar(n);
      centre.y = groundAt(centre.x, centre.z) + 0.15;
      out.hit = centre;
      // Felt from sixty feet, and much more the lower.
      const f = Math.max(0, 1 - out.alt / (REACH * scale));
      out.strength = power * f * Math.sqrt(f);
      this.splash.visible = true;
      this.splash.position.copy(centre);
      const R = (4 + out.alt * 0.9) * scale;
      this.splash.scale.setScalar(R);
      this.splash.material.uniforms.uTime.value = time;
      this.splash.material.uniforms.uPower.value = out.strength * 0.08;
    } else this.splash.visible = false;
    return out;
  }

  hide() {
    for (const j of [...this.mains, ...this.rcs]) j.jet.mesh.visible = false;
    this.splash.visible = false;
    this.puffs = {};
  }
}
