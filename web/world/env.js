// The light the Moon gives back: an environment for reflections. Black sky,
// the regolith below the horizon lit by the sun, and the sun itself. White
// paint and a gold visor read as real only when they have this to mirror.

import * as T from '../vendor/three.js';

export function makeEnvironment(renderer, sunDir) {
  const scene = new T.Scene();
  const mat = new T.ShaderMaterial({
    side: T.BackSide,
    depthWrite: false,
    uniforms: { sun: { value: sunDir.clone().normalize() } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 sun; varying vec3 vDir;
      void main(){
        vec3 d = normalize(vDir);
        // Below the horizon: sunlit regolith, brighter looking down-sun.
        float below = smoothstep(0.02, -0.06, d.y);
        float opp = max(0.0, dot(normalize(vec3(d.x, 0.0, d.z)), -normalize(vec3(sun.x, 0.0, sun.z))));
        vec3 ground = vec3(0.30, 0.29, 0.275) * (0.75 + 0.5 * opp) * (0.6 + 0.4 * smoothstep(0.0, -0.5, d.y));
        // The horizon line, a little brighter (grazing light on far hills).
        float rim = exp(-pow(d.y / 0.025, 2.0)) * 0.12;
        // The sun: a disc and a tight glow; no sky to scatter it.
        float c = dot(d, normalize(sun));
        float disc = smoothstep(0.9996, 0.99985, c) * 60.0;
        float glow = pow(max(0.0, c), 600.0) * 3.0;
        vec3 col = mix(vec3(0.0), ground, below) + rim * vec3(0.8, 0.78, 0.75) + (disc + glow) * vec3(1.0, 0.97, 0.92);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  scene.add(new T.Mesh(new T.SphereGeometry(100, 64, 32), mat));
  const pmrem = new T.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0, 0.1, 1000);
  pmrem.dispose();
  return rt.texture;
}
