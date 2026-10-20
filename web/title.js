// The title in the GT40's own letters: the VT11 character generator's six
// by eight dots (crates/gt40/src/chargen.rs in the recovery, from open-simh's
// display/vt11.c), each dot a point of light, lit in the order the beam
// would draw them: letter by letter, column by column, from the bottom up.

const GLYPHS = {
  M: [0xff, 0x40, 0x30, 0x30, 0x40, 0xff],
  O: [0x3c, 0x42, 0x81, 0x81, 0x42, 0x3c],
  N: [0xff, 0x20, 0x10, 0x08, 0x04, 0xff],
  L: [0x81, 0xff, 0x81, 0x01, 0x01, 0x03],
  A: [0x3f, 0x48, 0x88, 0x88, 0x48, 0x3f],
  D: [0x81, 0xff, 0x81, 0x81, 0x42, 0x3c],
  E: [0x81, 0xff, 0x91, 0x91, 0x91, 0xc3],
  R: [0x81, 0xff, 0x90, 0x98, 0x94, 0x63],
};
const ADVANCE = 8; // dot columns from one letter to the next

/** A dot of light as a sprite: a hard core and a soft glow, in one colour. */
function sprite(px, rgb) {
  const size = Math.ceil(px * 4);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const m = size / 2;
  const glow = g.createRadialGradient(m, m, 0, m, m, m);
  glow.addColorStop(0, `rgba(${rgb},0.55)`);
  glow.addColorStop(0.18, `rgba(${rgb},0.32)`);
  glow.addColorStop(0.45, `rgba(${rgb},0.07)`);
  glow.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = glow;
  g.fillRect(0, 0, size, size);
  g.fillStyle = `rgb(${rgb})`;
  g.beginPath();
  g.arc(m, m, px * 0.36, 0, Math.PI * 2);
  g.fill();
  return c;
}

export class Title {
  /** @param {HTMLCanvasElement} canvas the full-screen canvas to draw on */
  constructor(canvas, text = 'MOONLANDER') {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dots = [];
    for (const [li, ch] of [...text].entries()) {
      for (const [x, bits] of GLYPHS[ch].entries()) {
        for (let y = 0; y < 8; y++) if (bits & (1 << y)) this.dots.push({ c: li * ADVANCE + x, r: 7 - y });
      }
    }
    this.cols = text.length * ADVANCE - 2;
    this.box = null;
    this.key = '';
  }

  /**
   * Fit the canvas to the screen and lay the title out across it, its
   * middle at `at` of the height. Returns the title's box in CSS pixels.
   */
  layout(at) {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const key = `${w}x${h}@${dpr}:${at}`;
    if (key === this.key) return this.box;
    this.key = key;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.dpr = dpr;
    // Wide on a phone, a little narrower on a desktop, never huge.
    const share = w < 640 ? 0.9 : 0.74;
    const pitch = Math.min((w * share) / this.cols, 15);
    this.pitch = pitch;
    this.x0 = (w - (this.cols - 1) * pitch) / 2;
    this.y0 = h * at - 3.5 * pitch;
    this.green = sprite(pitch * dpr, '150,255,120');
    this.white = sprite(pitch * dpr, '246,246,240');
    this.box = { left: this.x0 - pitch / 2, top: this.y0 - pitch / 2, width: this.cols * pitch, height: 8 * pitch, pitch };
    return this.box;
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Draw at `t` seconds since the beam began: the dots lit over `sweep`
   * seconds, each flaring as it is struck and settling; `white` from the
   * phosphor's green (0) to white (1); `alpha` for the whole.
   */
  draw(t, { sweep = 1.2, white = 0, alpha = 1 } = {}) {
    const g = this.ctx, d = this.dpr, p = this.pitch;
    this.clear();
    if (alpha <= 0.001) return;
    g.globalCompositeOperation = 'lighter';
    const n = this.dots.length;
    const size = this.green.width;
    for (let i = 0; i < n; i++) {
      const lit = sweep > 0 ? t - (i / n) * sweep : t;
      if (lit < 0) break;
      // Struck hard, then settling to what the refresh keeps up.
      const b = Math.min(1, lit / 0.02) * (1 + 1.3 * Math.exp(-lit / 0.09));
      const x = (this.x0 + this.dots[i].c * p) * d - size / 2;
      const y = (this.y0 + this.dots[i].r * p) * d - size / 2;
      const a = Math.min(1, b) * alpha;
      const hot = Math.max(0, b - 1);
      if (white < 1) {
        g.globalAlpha = Math.min(1, a * (1 - white) + hot * 0.5);
        g.drawImage(this.green, x, y);
      }
      if (white > 0 || hot > 0) {
        g.globalAlpha = Math.min(1, a * white + hot * 0.45);
        g.drawImage(this.white, x, y);
      }
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  }
}
