// The VR14 tube in WebGL2: the recovery's P39 phosphor model (crates/gt40/
// src/crt.rs) moved to the GPU. Excitation per pixel lives in a float
// texture; each frame it decays by exp(-dt / tau) and the beam's new
// segments are added as Gaussian strokes; a wide blur of the excitation is
// the glow of the faceplate; a final pass turns excitation into P39's
// yellow-green. The picture depends only on what the beam did and when,
// never on the frame rate.

// MODEL constants, from crt.rs. The decay (10% in 150 ms) is an assumption
// there too.
export const P39_TAU_US = 150_000 / Math.LN10;
const DOT_DWELL_US = 0.5;
const SATURATION = 0.5;
const GLOW = 0.25;
const SPOT_SIGMA = 0.85; // raster units
const GLOW_DOWN = 4; // raster units per glow cell
const FACE = 0.0012;

export const FACE_W = 1024;
export const FACE_H = 768;

function level(l) {
  return 0.3 + (0.7 * l) / 7;
}

const VS_QUAD = `#version 300 es
in vec2 a;
out vec2 uv;
void main() { uv = a * 0.5 + 0.5; gl_Position = vec4(a, 0.0, 1.0); }`;

// Decay: copy the old excitation scaled by k.
const FS_DECAY = `#version 300 es
precision highp float;
uniform sampler2D tex; uniform float k;
in vec2 uv; out vec4 o;
void main() { o = vec4(texture(tex, uv).r * k, 0.0, 0.0, 1.0); }`;

// Strokes: one instance per beam event, a quad around the segment, the
// fragment adds a Gaussian of the distance to the segment.
const VS_STROKE = `#version 300 es
in vec2 corner;            // -1..1 quad
in vec4 seg;               // x0 y0 x1 y1, pixels
in vec2 ek;                // energy, kind (0 line, 1 dot)
uniform vec2 size;         // canvas pixels
uniform float pad;         // 3 sigma, pixels
out vec2 p; flat out vec4 s; flat out vec2 e;
void main() {
  vec2 a = seg.xy, b = seg.zw;
  vec2 d = b - a; float len = length(d);
  vec2 u = len > 0.0 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-u.y, u.x);
  vec2 q = mix(a - u * pad, b + u * pad, corner.x * 0.5 + 0.5) + n * pad * corner.y;
  p = q; s = seg; e = ek;
  gl_Position = vec4(q / size * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS_STROKE = `#version 300 es
precision highp float;
uniform float sigma;
in vec2 p; flat in vec4 s; flat in vec2 e;
out vec4 o;
void main() {
  vec2 a = s.xy, b = s.zw, d = b - a;
  float l2 = dot(d, d);
  float t = l2 > 0.0 ? clamp(dot(p - a, d) / l2, 0.0, 1.0) : 0.0;
  float dist = length(p - (a + d * t));
  float g = exp(-dist * dist / (2.0 * sigma * sigma));
  // A line spreads its energy per pixel of length across the stroke (1D
  // Gaussian); a dot spreads all of it over the spot (2D Gaussian).
  float norm = e.y > 0.5 ? 1.0 / (6.2831853 * sigma * sigma) : 1.0 / (sigma * 2.5066283);
  o = vec4(e.x * g * norm, 0.0, 0.0, 1.0);
}`;

// Downsample by GLOW_DOWN pixels (average), then blur with a binomial
// kernel of radius 4, horizontally and vertically.
const FS_DOWN = `#version 300 es
precision highp float;
uniform sampler2D tex; uniform vec2 texel; uniform float down; uniform vec2 ratio;
in vec2 uv; out vec4 o;
void main() {
  float s = 0.0; float n = down;
  vec2 c = uv * ratio;
  for (float y = 0.0; y < 8.0; y++) { if (y >= n) break;
    for (float x = 0.0; x < 8.0; x++) { if (x >= n) break;
      s += texture(tex, c + (vec2(x, y) - (n - 1.0) * 0.5) * texel).r; } }
  o = vec4(s / (n * n), 0.0, 0.0, 1.0);
}`;

const FS_BLUR = `#version 300 es
precision highp float;
uniform sampler2D tex; uniform vec2 dir;
in vec2 uv; out vec4 o;
const float K[9] = float[9](1.0, 8.0, 28.0, 56.0, 70.0, 56.0, 28.0, 8.0, 1.0);
void main() {
  float s = 0.0;
  for (int i = 0; i < 9; i++) s += texture(tex, uv + dir * float(i - 4)).r * K[i];
  o = vec4(s / 256.0, 0.0, 0.0, 1.0);
}`;

// Tone: excitation to P39's colour on a faintly lit faceplate, dithered.
const FS_TONE = `#version 300 es
precision highp float;
uniform sampler2D energy; uniform sampler2D glow;
uniform float density; uniform float sat; uniform float glowk; uniform float face;
uniform vec2 size; uniform vec2 ratio;
in vec2 uv; out vec4 o;
float hash(vec2 p, float k) {
  uvec2 q = uvec2(p); uint h = q.x * 2654435761u ^ q.y * 2246822519u ^ uint(k);
  h ^= h >> 15; h *= 740071117u; h ^= h >> 12; h *= 695609843u; h ^= h >> 15;
  return float(h) / 4294967295.0;
}
void main() {
  float e = (texture(energy, uv).r + glowk * texture(glow, uv / ratio).r) * density;
  float b = 1.0 - exp(-e / sat);
  vec2 c = (uv - 0.5) * 2.0; float r = min(length(c), 1.0);
  float f = face * (1.0 - 0.5 * r * r);
  float hot = clamp((b - 0.85) / 0.15, 0.0, 1.0) * 0.35;
  vec3 rgb = vec3(f * 0.8 + b * 0.36 + hot * 0.6, f * 1.0 + b * 1.0, f * 0.85 + b * 0.30 + hot * 0.55);
  rgb = pow(clamp(rgb, 0.0, 1.0), vec3(1.0 / 2.2));
  float n = (hash(gl_FragCoord.xy, 1374683915.0) + hash(gl_FragCoord.xy, 2778665524.0) - 1.0) / 255.0;
  o = vec4(rgb + n, 1.0);
}`;

function compile(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

export class Phosphor {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is needed');
    this.gl = gl;
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('float render targets are needed');
    this.linear = !!gl.getExtension('OES_texture_float_linear');
    this.now = 0; // machine time the phosphor is current to
    this.w = 0;
    this.h = 0;
    this.decay = compile(gl, VS_QUAD, FS_DECAY);
    this.stroke = compile(gl, VS_STROKE, FS_STROKE);
    this.down = compile(gl, VS_QUAD, FS_DOWN);
    this.blur = compile(gl, VS_QUAD, FS_BLUR);
    this.tone = compile(gl, VS_QUAD, FS_TONE);
    // Geometry: a quad, shared.
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.inst = gl.createBuffer();
    this.instCap = 0;
    this.vaoQuad = this.makeQuadVao();
    this.vaoStroke = this.makeStrokeVao();
    this.resize();
  }

  makeQuadVao() {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return vao;
  }

  makeStrokeVao() {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const corner = gl.getAttribLocation(this.stroke.p, 'corner');
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    const seg = gl.getAttribLocation(this.stroke.p, 'seg');
    const ek = gl.getAttribLocation(this.stroke.p, 'ek');
    gl.enableVertexAttribArray(seg);
    gl.vertexAttribPointer(seg, 4, gl.FLOAT, false, 24, 0);
    gl.vertexAttribDivisor(seg, 1);
    gl.enableVertexAttribArray(ek);
    gl.vertexAttribPointer(ek, 2, gl.FLOAT, false, 24, 16);
    gl.vertexAttribDivisor(ek, 1);
    gl.bindVertexArray(null);
    return vao;
  }

  target(w, h, filter) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R16F, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, w, h };
  }

  /** Fit the tube to the canvas's current pixel size. */
  resize() {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.scale = Math.min(w / FACE_W, h / FACE_H);
    this.ox = (w - FACE_W * this.scale) / 2;
    this.oy = (h - FACE_H * this.scale) / 2;
    for (const t of [this.a, this.b, this.g0, this.g1].filter(Boolean)) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fb);
    }
    const filter = this.linear ? gl.LINEAR : gl.NEAREST;
    this.a = this.target(w, h, filter);
    this.b = this.target(w, h, filter);
    this.glowDown = Math.max(1, Math.round(GLOW_DOWN * this.scale));
    const gw = Math.floor(w / this.glowDown) + 1, gh = Math.floor(h / this.glowDown) + 1;
    this.g0 = this.target(gw, gh, filter);
    this.g1 = this.target(gw, gh, filter);
  }

  /** Raster units to framebuffer pixels (both y up). */
  toPixel(x, y) {
    return [this.ox + x * this.scale, this.oy + y * this.scale];
  }

  /** Canvas pixels (y down, as pointer events give them) to raster units. */
  toRaster(px, py) {
    return [(px - this.ox) / this.scale, (this.h - py - this.oy) / this.scale];
  }

  /** Forget everything drawn (a fresh tube). */
  clear() {
    const gl = this.gl;
    for (const t of [this.a, this.b, this.g0, this.g1]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Bring the phosphor to machine time `t` and light it with `beams`
   * (flattened: kind x0 y0 x1 y1 t0 t1 level, times relative to `tb`),
   * then draw the tube on the canvas.
   */
  frame(t, beams, tb) {
    const gl = this.gl;
    this.resize();
    const k = t > this.now ? Math.exp(-(t - this.now) / P39_TAU_US) : 1;
    if (t > this.now) this.now = t;
    const now = this.now;

    // Decay the old excitation into the other target.
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, this.w, this.h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.b.fb);
    gl.useProgram(this.decay.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.a.tex);
    gl.uniform1i(this.decay.u.tex, 0);
    gl.uniform1f(this.decay.u.k, k);
    gl.bindVertexArray(this.vaoQuad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Add the strokes.
    const n = beams.length / 8;
    if (n > 0) {
      if (this.instCap < n) {
        this.instCap = Math.max(n, this.instCap * 2, 4096);
        this.instData = new Float32Array(this.instCap * 6);
      }
      const d = this.instData;
      let m = 0;
      const fade = (tt) => Math.exp(-Math.max(0, now - (tb + tt)) / P39_TAU_US);
      for (let i = 0; i < n; i++) {
        const o = i * 8;
        const kind = beams[o];
        const [ax, ay] = this.toPixel(beams[o + 1], beams[o + 2]);
        const [bx, by] = this.toPixel(beams[o + 3], beams[o + 4]);
        const lv = level(beams[o + 7]);
        let e;
        if (kind > 0.5) {
          e = DOT_DWELL_US * lv * fade(beams[o + 5]);
        } else {
          const len = Math.hypot(bx - ax, by - ay);
          const dwell = Math.max(0, beams[o + 6] - beams[o + 5]);
          // Energy per pixel of length; a zero-length line is a dot's worth.
          e = len > 0.5 ? (dwell / len) * lv * fade(beams[o + 6]) : 0;
          if (len <= 0.5) {
            e = dwell * lv * fade(beams[o + 6]);
          }
        }
        if (e <= 0) continue;
        d[m++] = ax; d[m++] = ay; d[m++] = bx; d[m++] = by; d[m++] = e;
        d[m++] = kind > 0.5 || Math.hypot(bx - ax, by - ay) <= 0.5 ? 1 : 0;
      }
      const count = m / 6;
      if (count > 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
        gl.bufferData(gl.ARRAY_BUFFER, d.subarray(0, m), gl.DYNAMIC_DRAW);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.useProgram(this.stroke.p);
        const sigma = SPOT_SIGMA * this.scale;
        gl.uniform2f(this.stroke.u.size, this.w, this.h);
        gl.uniform1f(this.stroke.u.pad, Math.max(1, 3 * sigma));
        gl.uniform1f(this.stroke.u.sigma, Math.max(0.5, sigma));
        gl.bindVertexArray(this.vaoStroke);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
        gl.disable(gl.BLEND);
      }
    }
    // Swap: b now holds the current excitation.
    [this.a, this.b] = [this.b, this.a];

    // The glow: downsample and blur.
    const g = this.g0, gt = this.g1;
    gl.viewport(0, 0, g.w, g.h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, g.fb);
    gl.useProgram(this.down.p);
    gl.bindTexture(gl.TEXTURE_2D, this.a.tex);
    gl.uniform1i(this.down.u.tex, 0);
    gl.uniform2f(this.down.u.texel, 1 / this.w, 1 / this.h);
    gl.uniform1f(this.down.u.down, this.glowDown);
    const rx = (g.w * this.glowDown) / this.w, ry = (g.h * this.glowDown) / this.h;
    gl.uniform2f(this.down.u.ratio, rx, ry);
    gl.bindVertexArray(this.vaoQuad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.useProgram(this.blur.p);
    gl.uniform1i(this.blur.u.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, gt.fb);
    gl.bindTexture(gl.TEXTURE_2D, g.tex);
    gl.uniform2f(this.blur.u.dir, 1 / g.w, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, g.fb);
    gl.bindTexture(gl.TEXTURE_2D, gt.tex);
    gl.uniform2f(this.blur.u.dir, 0, 1 / g.h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // The picture.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    gl.useProgram(this.tone.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.a.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, g.tex);
    gl.uniform1i(this.tone.u.energy, 0);
    gl.uniform1i(this.tone.u.glow, 1);
    gl.uniform1f(this.tone.u.density, this.scale * this.scale);
    gl.uniform1f(this.tone.u.sat, SATURATION);
    gl.uniform1f(this.tone.u.glowk, GLOW);
    gl.uniform1f(this.tone.u.face, FACE);
    gl.uniform2f(this.tone.u.size, this.w, this.h);
    gl.uniform2f(this.tone.u.ratio, rx, ry);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.activeTexture(gl.TEXTURE0);
  }
}
