// The land around Burness's profile. The program has one line of ground,
// 911 heights 32 feet apart; the car flies and lands on it, and the
// camera sees it edge on, so along the flight line it stays exactly as
// the program has it. Away from the line it becomes country: each peak
// a mountain with a body that broadens and settles toward its foot, its
// faces cut by gullies and spurs, the plains in front and the hills
// behind pitted with craters of every size, all of it running on past
// the ends of the table and down over the curve of the Moon.
//
// The bodies come from the profile itself, blurred more the farther from
// the line: a needle 2,000 feet across and 15,000 high is a spire, a broad
// massif a broad mountain. The blur is kept as a stack of levels, worked
// out once for each of the program's two heights, so any point can be
// had quickly.

// Noise of its own, on an integer hash: the land is asked for heights
// often (everything that falls on it asks), and a sine per lookup is
// slow.
function ih(x, y, s) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function noise2(x, y, s = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = ih(xi, yi, s), b = ih(xi + 1, yi, s), c = ih(xi, yi + 1, s), d = ih(xi + 1, yi + 1, s);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
function fbm(x, y, s = 0) {
  let v = 0, amp = 1, f = 1, norm = 0;
  for (let i = 0; i < 4; i++) {
    v += amp * noise2(x * f, y * f, s + i);
    norm += amp;
    amp *= 0.5;
    f *= 2.1;
  }
  return v / norm;
}

export const MOON_R = 5.702e6; // feet
const BAND = 60; // the flight line is exact this far either side

// Distances from the band where the blurred profile is kept.
const LEVELS = [0, 40, 90, 160, 260, 400, 600, 900, 1350, 2000, 3000, 4500, 6800, 10000, 15000, 22000, 33000, 50000];
const EXT = 70000; // feet of made-up range past each end of the table

/** Ridged noise: sharp crests, soft hollows, in 0..1. */
function ridged(x, y, oct = 4) {
  let s = 0, amp = 0.5, f = 1, w = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    let n = 1 - Math.abs(noise2(x * f, y * f, 50 + i) * 2 - 1);
    n *= n * w;
    w = Math.min(1, n * 2);
    s += n * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return s / norm;
}

/** Craters on a grid of cells: a bowl, a raised rim, ejecta beyond. A
 * height in units of the crater's depth, summed over the cells near. */
function craters(x, z, cell, rmin, rmax, keep, seed) {
  const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
  let h = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const gx = cx + i, gz = cz + j;
      if (ih(gx, gz, seed * 8) > keep) continue;
      const px = (gx + 0.15 + 0.7 * ih(gx, gz, seed * 8 + 1)) * cell;
      const pz = (gz + 0.15 + 0.7 * ih(gx, gz, seed * 8 + 2)) * cell;
      const r = rmin + (rmax - rmin) * Math.pow(ih(gx, gz, seed * 8 + 3), 2.2);
      const dx = x - px, dz = z - pz;
      const d2 = (dx * dx + dz * dz) / (r * r);
      if (d2 > 6.25) continue;
      const d = Math.sqrt(d2);
      const depth = r * 0.42;
      // A rounded bowl, a rim with no crease in it, and ejecta thinning
      // out to two and a half radii; smooth all the way, so the light and
      // the shadows have shapes to follow, not lines.
      let v = 0.24 * Math.exp(-((d - 1) * (d - 1)) / 0.1);
      if (d < 1) v -= 0.95 * (1 - d2) * (1 - d2);
      const out = d < 1 ? Math.max(0, (d - 0.6) / 0.4) : 1 - Math.min(1, (d - 1) / 1.5);
      v += 0.08 * out * out * (3 - 2 * out);
      h += v * depth;
    }
  }
  return h;
}

export class Land {
  /**
   * @param terrain the program's heights (live: a crash digs into it)
   * @param x0, dx  feet at index 0, feet between heights
   */
  constructor(terrain, x0, dx) {
    this.terrain = terrain;
    this.x0 = x0;
    this.dx = dx;
    this.n = terrain.length;
    this.x1 = x0 + (this.n - 1) * dx;
    this.xc = (x0 + this.x1) / 2;
    this.stacks = new Map(); // scale -> blur levels
    this.s = 1;
  }

  /** The program changed its heights (a crater): build the levels again. */
  refresh() {
    this.stacks.clear();
    this.setScale(this.s);
  }

  setScale(s) {
    this.s = s;
    if (!this.stacks.has(s)) this.stacks.set(s, this.build(s));
    this.st = this.stacks.get(s);
  }

  /** The profile at this scale, on 32-foot steps from EXT before the
   * table to EXT after it; past the ends, a made-up range in its manner,
   * settling from the table's last height. */
  extended(s) {
    const pre = Math.ceil(EXT / this.dx);
    const len = this.n + 2 * pre;
    const p = new Float32Array(len);
    let mean = 0;
    for (let i = 0; i < this.n; i++) mean += this.terrain[i];
    mean /= this.n;
    for (let i = 0; i < len; i++) {
      const k = i - pre;
      if (k >= 0 && k < this.n) {
        p[i] = this.terrain[k] * s;
        continue;
      }
      const x = this.x0 + k * this.dx;
      const end = k < 0 ? this.terrain[0] : this.terrain[this.n - 1];
      const past = k < 0 ? -k * this.dx : (k - this.n + 1) * this.dx;
      const range = mean * 0.7 + 5200 * Math.pow(ridged(x / 5200 + 11.3, 3.7, 5), 1.6) + 900 * (noise2(x / 900, 9.1, 7) - 0.5);
      const w = Math.min(1, past / 6000);
      p[i] = (end + (range - end) * w * w * (3 - 2 * w)) * s;
    }
    return { p, pre };
  }

  build(s) {
    const { p, pre } = this.extended(s);
    const len = p.length;
    const levels = [];
    const tmp = new Float32Array(len), out = new Float32Array(len);
    for (const d of LEVELS) {
      // Wider with distance from the line; three box passes make a fair
      // Gaussian, and keep the area, so a needle spreads and lowers.
      const sigma = (1.0 * d) / this.dx;
      if (sigma < 0.5) {
        levels.push(p.slice());
        continue;
      }
      const r = Math.max(1, Math.round(Math.sqrt(sigma * sigma + 1)));
      let src = p, dst = out;
      for (let pass = 0; pass < 3; pass++) {
        // Running sum over [i-r, i+r], clamped at the ends.
        let acc = 0;
        for (let k = -r; k <= r; k++) acc += src[Math.min(len - 1, Math.max(0, k))];
        for (let i = 0; i < len; i++) {
          dst[i] = acc / (2 * r + 1);
          acc += src[Math.min(len - 1, i + r + 1)] - src[Math.max(0, i - r)];
        }
        src = dst;
        dst = dst === out ? tmp : out;
      }
      levels.push(src.slice());
    }
    // The country's general level, from the profile blurred very wide.
    const wide = levels[levels.length - 1];
    return { s, levels, pre, wide };
  }

  /** Index into the extended arrays for x, and the fraction. */
  at(x) {
    const u = (x - this.x0) / this.dx + this.st.pre;
    const len = this.st.levels[0].length;
    const i = Math.max(0, Math.min(len - 2, Math.floor(u)));
    return [i, Math.max(0, Math.min(1, u - i))];
  }

  /** The profile (exact along the table, made up past it). */
  profile(x) {
    const [i, f] = this.at(x);
    const a = this.st.levels[0];
    return a[i] + (a[i + 1] - a[i]) * f;
  }

  /** The blurred profile at d feet from the band. */
  body(x, d) {
    const [i, f] = this.at(x);
    let k = 0;
    while (k < LEVELS.length - 2 && LEVELS[k + 1] < d) k++;
    const t = Math.max(0, Math.min(1, (d - LEVELS[k]) / (LEVELS[k + 1] - LEVELS[k])));
    const A = this.st.levels[k], B = this.st.levels[k + 1];
    const a = A[i] + (A[i + 1] - A[i]) * f, b = B[i] + (B[i + 1] - B[i]) * f;
    return a + (b - a) * t;
  }

  wide(x) {
    const [i, f] = this.at(x);
    const a = this.st.wide;
    return a[i] + (a[i + 1] - a[i]) * f;
  }

  /** Height at (x, z). `lod`, the size of the mesh cell it is for: what
   * is smaller than that is left out (0 for everything). */
  height(x, z, lod = 0) {
    const s = this.s;
    const az = Math.abs(z);
    const inTable = x >= this.x0 && x <= this.x1;
    if (az <= BAND && inTable) return this.profile(x);
    const d = Math.max(0, az - BAND);
    // How far relief carries out from the line, at this scale: the
    // close-up's quarter heights fall away over a short way, the full
    // heights over a long one.
    const k = (s - 0.25) / 0.75;
    const front = z > 0;
    const L = front ? 1400 + 3600 * k : 2600 + 5400 * k;
    const B = this.body(x, d);
    const W = this.wide(x);
    // The country under the mountains: plains in front, lower than the
    // line, rising to hills and a far range behind.
    const amp = Math.sqrt(s);
    let floor;
    const far = Math.min(1, d / 20000);
    if (front) {
      const near = Math.min(1, d / 1400);
      floor = Math.min(B, W * 0.12) - 40 * amp
        + (lod < 300 ? (fbm(x / 420, z / 420 + 7.7, 21) - 0.5) * 120 * amp * near : 0)
        + (fbm(x / 3000 + 1.3, z / 3000, 11) - 0.5) * 1400 * amp * far
        + (d > 15000 ? 2600 * amp * Math.pow(ridged(x / 14000 + 2.2, z / 14000 + 5.1, 4), 2) * Math.min(1, (d - 15000) / 30000) : 0);
    } else {
      // Behind, the hills stand up enough to make a skyline even from the
      // close-up, where the program's own heights are a quarter.
      // They rise slowly, so that the skyline is miles off: near hills
      // that stood as high would wall the close-up in.
      const w = Math.min(1, d / 4000);
      const u = Math.min(1, Math.max(0, d - 2000) / 20000);
      const ampB = 0.75 + 0.25 * k;
      floor = W * 0.75 + 300 * ampB * w
        + (fbm(x / 2200 + 3.1, z / 2200, 31) - 0.5) * 1300 * ampB * w
        + 4200 * ampB * Math.pow(ridged(x / 17000 + 7.7, z / 15000 + 1.9, lod < 1000 ? 5 : 3), 1.4) * u * u * (3 - 2 * u);
    }
    // The mountains standing out of it, settling toward their feet.
    const fall = Math.exp(-Math.pow(d / L, 1.25));
    const lift = Math.max(0, B - floor);
    let h = floor + (B - floor) * fall;
    // Their faces: gullies and spurs, as deep as the mountain is high.
    const face = Math.min(1, d / 250) * fall;
    if (lod < 1500 && lift > 1 && face > 0.01) h += lift * face * 0.32 * (ridged(x / 1300 + 4.4, z / 1700 + 0.7, 4) - 0.45);
    // Craters, more of them and bigger the farther from the line, and few
    // on the mountains.
    const open = Math.min(1, Math.max(0, d - 250) / 1200) * (1 - 0.8 * Math.min(1, lift * fall / (600 * amp + 1)));
    if (open > 0.01) {
      let c = 0;
      if (lod < 200) c += craters(x, z, 900, 70, 260, 0.55, 1) * 0.7;
      if (lod < 700) c += craters(x, z, 3200, 220, 900, 0.5, 2) * 0.55;
      if (lod < 3000) c += craters(x, z, 12000, 900, 3600, 0.42, 3) * 0.6;
      // And the big ones, miles across, out where they cannot crowd it.
      if (lod < 12000) c += craters(x, z, 42000, 4000, 13000, 0.38, 4) * 0.4 * Math.min(1, Math.max(0, d - 5000) / 15000);
      // (The craters are this world's, not the program's: the same depth
      // at both of its scales.)
      h += c * open;
    }
    // Past the ends of the table, the band is not kept: it is all country.
    if (!inTable && az <= BAND) {
      const past = x < this.x0 ? this.x0 - x : x - this.x1;
      const w = Math.min(1, past / 400);
      h = this.profile(x) * (1 - w) + h * w;
    }
    // The curve of the Moon, away from where anything happens.
    const rx = x - this.xc;
    const away = Math.min(1, Math.max(0, Math.hypot(Math.max(0, Math.abs(rx) - 16000), d) - 2000) / 12000);
    h -= ((rx * rx + z * z) / (2 * MOON_R)) * away;
    return h;
  }
}

/**
 * The land's mesh as rings round the line, each a grid of square cells
 * four times the size of the one inside it, with a hole where that one
 * is: the line itself on every 32 feet of the table, out to the horizon
 * a mile and a half to a cell. Every ring's edges fall on the next one's
 * grid, and its outer edge is bent to lie on the next one's cells, so
 * there are no cracks between them.
 */
export function landRings(x0) {
  // Feet from x0 (x) and from the line (z); all multiples of the cells
  // that meet there.
  const R0 = { cell: 32, x: [0, 29184], z: [-2048, 2048] };
  const R1 = { cell: 128, x: [-8192, 37376], z: [-8192, 8192] };
  const R2 = { cell: 512, x: [-40960, 81920], z: [-40960, 40960] };
  const R3 = { cell: 2048, x: [-163840, 204800], z: [-163840, 163840] };
  const R4 = { cell: 8192, x: [-491520, 532480], z: [-491520, 491520] };
  const rings = [R0, R1, R2, R3, R4];
  return rings.map((r, i) => {
    const xs = [];
    for (let x = r.x[0]; x <= r.x[1]; x += r.cell) xs.push(x0 + x);
    let zs = [];
    if (i === 0) {
      // Rows close at the line (it is exact for 60 feet either way), then
      // opening out.
      const half = [0, 12, 24, 36, 48, 60];
      let z = 60, step = 13;
      while (z + step < r.z[1] - 24) {
        z += step;
        half.push(Math.round(z));
        step *= 1.1;
      }
      half.push(r.z[1]);
      zs = half.slice(1).map((v) => -v).reverse().concat(half);
    } else {
      for (let z = r.z[0]; z <= r.z[1]; z += r.cell) zs.push(z);
    }
    const inner = i > 0 ? rings[i - 1] : null;
    const outer = i < rings.length - 1 ? rings[i + 1] : null;
    return {
      cell: r.cell, xs, zs,
      hole: inner ? { x0: x0 + inner.x[0], x1: x0 + inner.x[1], z0: inner.z[0], z1: inner.z[1] } : null,
      edge: outer ? { cell: outer.cell, x0: x0 + r.x[0], x1: x0 + r.x[1], z0: r.z[0], z1: r.z[1] } : null,
      lod: i === 0 ? 0 : r.cell,
      nextLod: outer ? outer.cell : 0,
    };
  });
}

/** A ring cut into pieces along x, so that what is out of view (or out
 * of the shadow camera's) is not drawn: column ranges, overlapping by
 * one. */
export function ringChunks(ring, i) {
  const n = [8, 4, 2, 1, 1][i] || 1;
  const cols = ring.xs.length;
  const out = [];
  for (let k = 0; k < n; k++) {
    const c0 = Math.floor((k * (cols - 1)) / n), c1 = Math.floor(((k + 1) * (cols - 1)) / n);
    out.push({ c0, c1 });
  }
  return out;
}

/** Triangles for columns c0..c1 of a ring, numbered within that piece:
 * every cell but those in its hole. */
export function ringIndex(ring, c0 = 0, c1 = ring.xs.length - 1) {
  const rows = ring.zs.length, w = c1 - c0 + 1;
  const idx = [];
  const h = ring.hole;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = c0; c < c1; c++) {
      if (h) {
        const cx = (ring.xs[c] + ring.xs[c + 1]) / 2, cz = (ring.zs[r] + ring.zs[r + 1]) / 2;
        if (cx > h.x0 && cx < h.x1 && cz > h.z0 && cz < h.z1) continue;
      }
      const a = r * w + (c - c0), b = a + 1, d = a + w, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  return idx;
}

/** Heights and normals for a ring's vertices, its outer edge laid on the
 * next ring's cells. */
export function ringSurface(land, ring, x0origin) {
  const cols = ring.xs.length, rows = ring.zs.length;
  const y = new Float32Array(cols * rows);
  const e = ring.edge;
  const coarse = (x, z) => land.height(x, z, ring.nextLod);
  for (let r = 0; r < rows; r++) {
    const z = ring.zs[r];
    for (let c = 0; c < cols; c++) {
      const x = ring.xs[c];
      let h;
      if (e && (r === 0 || r === rows - 1)) {
        // Along a top or bottom edge: between the next ring's columns.
        const u = (x - x0origin) / e.cell, i = Math.floor(u), t = u - i;
        const xa = x0origin + i * e.cell;
        h = t < 1e-6 ? coarse(xa, z) : coarse(xa, z) * (1 - t) + coarse(xa + e.cell, z) * t;
      } else if (e && (c === 0 || c === cols - 1)) {
        const u = z / e.cell, i = Math.floor(u), t = u - i;
        const za = i * e.cell;
        h = t < 1e-6 ? coarse(x, za) : coarse(x, za) * (1 - t) + coarse(x, za + e.cell) * t;
      } else h = land.height(x, z, ring.lod);
      y[r * cols + c] = h;
    }
  }
  // Normals from the grid: central differences inside, one-sided at the
  // edges.
  const n = new Float32Array(cols * rows * 3);
  for (let r = 0; r < rows; r++) {
    const ra = Math.max(0, r - 1), rb = Math.min(rows - 1, r + 1);
    const dz = ring.zs[rb] - ring.zs[ra];
    for (let c = 0; c < cols; c++) {
      const ca = Math.max(0, c - 1), cb = Math.min(cols - 1, c + 1);
      const dx = ring.xs[cb] - ring.xs[ca];
      const gx = (y[r * cols + cb] - y[r * cols + ca]) / dx;
      const gz = (y[rb * cols + c] - y[ra * cols + c]) / dz;
      const l = Math.hypot(gx, 1, gz);
      const k = (r * cols + c) * 3;
      n[k] = -gx / l;
      n[k + 1] = 1 / l;
      n[k + 2] = -gz / l;
    }
  }
  return { y, n };
}

/** The land's height from the rings' own vertices: the finest ring
 * that covers (x, z), between its four nearest. */
function ringSampler(rings, surfaces) {
  return (x, z) => {
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i], xs = r.xs, zs = r.zs;
      if (x < xs[0] || x > xs[xs.length - 1] || z < zs[0] || z > zs[zs.length - 1]) continue;
      const cols = xs.length;
      const u = (x - xs[0]) / r.cell;
      const c = Math.min(cols - 2, Math.floor(u)), fx = u - c;
      let row, fz;
      if (i > 0) {
        const v = (z - zs[0]) / r.cell;
        row = Math.min(zs.length - 2, Math.floor(v));
        fz = v - row;
      } else {
        let lo = 0, hi = zs.length - 1;
        while (hi - lo > 1) {
          const m = (lo + hi) >> 1;
          if (zs[m] <= z) lo = m;
          else hi = m;
        }
        row = lo;
        fz = (z - zs[lo]) / (zs[hi] - zs[lo]);
      }
      const y = surfaces[i].y, k = row * cols + c;
      const a = y[k] + (y[k + 1] - y[k]) * fx, b = y[k + cols] + (y[k + cols + 1] - y[k + cols]) * fx;
      return a + (b - a) * fz;
    }
    return -1e9;
  };
}

/**
 * Whether the sun reaches each vertex past the land between: a look
 * toward it, in steps that lengthen, for anything standing higher than
 * the sun. Soft over the sun's own width. The sun does not move, so this
 * is done once, and gives every crater its shadow out to the horizon.
 */
function sunlight(rings, surfaces, sun, top) {
  const H = ringSampler(rings, surfaces);
  const len = Math.hypot(sun[0], sun[2]);
  const dx = sun[0] / len, dz = sun[2] / len, rise = sun[1] / len;
  const soft = 0.0047; // the sun's half-width, as a slope, near enough
  for (const [i, r] of rings.entries()) {
    const y = surfaces[i].y, cols = r.xs.length;
    const vis = new Float32Array(y.length);
    for (let row = 0; row < r.zs.length; row++) {
      const z = r.zs[row];
      for (let c = 0; c < cols; c++) {
        const x = r.xs[c], k = row * cols + c, y0 = y[k] + 1;
        let worst = -1;
        let t = Math.max(12, r.cell * 0.6);
        while (t < 90000) {
          // Above anything there is: in the sun.
          if (y0 + t * (rise - soft) > top) break;
          const g = (H(x + dx * t, z + dz * t) - y0) / t;
          if (g > worst) {
            worst = g;
            if (worst > rise + soft) break;
          }
          t *= 1.1;
        }
        const u = Math.min(1, Math.max(0, (rise + soft - worst) / (2 * soft)));
        vis[k] = u * u * (3 - 2 * u);
      }
    }
    surfaces[i].sun = vis;
  }
}

/** Every ring's surface for one of the program's two heights, and the
 * sunlight on it. */
export function landSurfaces(terrain, x0, dx, scale, sun = null, shaped = null) {
  const land = new Land(terrain, x0, dx);
  land.setScale(scale);
  const rings = landRings(x0);
  const surfaces = rings.map((ring) => ringSurface(land, ring, x0));
  // The shape alone can be shown while the sunlight is worked out.
  if (shaped) shaped(surfaces);
  if (sun) {
    let top = -Infinity;
    for (const s of surfaces) for (const v of s.y) if (v > top) top = v;
    sunlight(rings, surfaces, sun, top);
  }
  return surfaces;
}
