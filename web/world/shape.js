// Small shape helpers shared by the car, the astronaut and the props.

/** A monotone cubic through (xs, ys): smooth, and never overshoots, so a
 * profile drawn from a handful of points stays where it is put. */
export function monotone(xs, ys) {
  const n = xs.length;
  const d = [];
  const m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

/** Points as [[x, y], ...] to a monotone curve. */
export function curve(points) {
  return monotone(points.map((p) => p[0]), points.map((p) => p[1]));
}

export const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/** A signed power, for superellipses. */
export const spow = (v, p) => Math.sign(v) * Math.pow(Math.abs(v), p);

export function hash(x, y) {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}

export function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

export function fbm2(x, y) {
  let s = 0, amp = 1, f = 1, norm = 0;
  for (let i = 0; i < 4; i++) {
    s += amp * noise2(x * f, y * f);
    norm += amp;
    amp *= 0.5;
    f *= 2.1;
  }
  return s / norm;
}

/** A lathe profile for a limb: radii along its length, as [[t, r], ...]
 * with t from 0 (joint) to 1 (end). Returns points for LatheGeometry with
 * the limb hanging down -y over `length`. */
export function limbProfile(length, radii, steps = 14) {
  const r = curve(radii);
  const pts = [];
  // Close the top with a dome, the bottom with a dome.
  const r0 = radii[0][1], r1 = radii[radii.length - 1][1];
  for (let i = 0; i <= 4; i++) {
    const a = (i / 4) * (Math.PI / 2);
    pts.push([Math.sin(a) * r0 * 0.999, Math.cos(a) * r0 * 0.6]);
  }
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    pts.push([r(t), -t * length]);
  }
  for (let i = 0; i <= 4; i++) {
    const a = (i / 4) * (Math.PI / 2);
    pts.push([Math.cos(a) * r1 * 0.999 + 1e-4, -length - Math.sin(a) * r1 * 0.6]);
  }
  return pts;
}
