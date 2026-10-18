// The page: loads the engine, paces it against the clock, shows the tube,
// and turns the mouse, a finger or the keyboard into the light pen.
import { Engine, messageName } from './engine/engine.js';
import { Phosphor } from './phosphor.js';

const canvas = document.getElementById('tube');
const hint = document.getElementById('hint');
const status = document.getElementById('status');

/** Machine microseconds the machine may run ahead of the wall clock. */
const LEAD = 8_000;
/** The most machine time computed for one frame, in microseconds. A slow
 * frame rate makes the game run slower, never stall or race to catch up. */
const MAX_STEP = 250_000;

const FIELDS = ['pen_x', 'pen_y', 'pen_down', 'throttle', 'turning', 'choice', 'slot', 'pilot', 'stop'];

class Page {
  constructor() {
    this.phosphor = new Phosphor(canvas);
    this.pending = [];       // input writes waiting for the machine: [field, value]
    this.recording = [];     // every write made, with the tick it was made at
    this.replay = null;      // writes to make, from a URL
    this.replayAt = 0;
    this.originWall = 0;
    this.originT = 0;
    this.target = LEAD;
    this.taken = null;       // beams taken at the last yield
    this.takenAt = 0;
    this.frames = 0;
    this.bells = 0;
    this.audio = null;
    this.state = null;
    this.lastMessage = null;
    this.tMachine = 0;
    this.tRender = 0;
  }

  wallMachine() {
    return this.originT + (performance.now() - this.originWall) * 1000 * this.rate;
  }

  /** Queue an input write; it reaches the machine at its next tend. */
  input(field, value) {
    if (this.replay) return; // a replay drives the machine, not the hands
    this.pending.push([field, value]);
  }

  /** The engine's callback, at least once per machine millisecond. */
  frame(t, beams, state, eng) {
    this.state = state;
    // Writes from the page land here, at a known tick, so a replay can make
    // them at the same tick.
    if (this.pending.length) {
      for (const [f, v] of this.pending) {
        eng.setInput(f, v);
        if (f !== 'stop') this.recording.push(state.ticks, FIELDS.indexOf(f), v);
      }
      this.pending.length = 0;
    }
    if (this.replay) {
      const r = this.replay;
      while (this.replayAt < r.length && r[this.replayAt] <= state.ticks) {
        eng.setInput(FIELDS[r[this.replayAt + 1]], r[this.replayAt + 2]);
        this.replayAt += 3;
      }
    }
    if (t < this.target) return { yield: false };
    // Far enough ahead: take the picture and pause until the next frame.
    this.taken = beams.slice();
    this.takenAt = t;
    return { yield: true, take: true };
  }

  async sleep() {
    const t0 = performance.now();
    this.tMachine += t0 - (this.tResume || t0);
    await new Promise((r) => requestAnimationFrame(r));
    const t1 = performance.now();
    let wm = this.wallMachine();
    if (wm > this.takenAt + MAX_STEP * this.rate) {
      // The tab was hidden or frames are slow: the clock starts again from
      // here rather than racing to catch up.
      this.originT = this.takenAt + MAX_STEP * this.rate;
      this.originWall = t1;
      wm = this.originT;
    }
    this.target = wm + LEAD;
    this.fit();
    if (!this.norender) this.phosphor.frame(this.takenAt, this.taken, this.takenAt);
    this.frames++;
    this.sounds();
    this.show();
    this.tRender += performance.now() - t1;
    this.tResume = performance.now();
  }

  /** For tests: draw the last picture and return it as a PNG data URL. */
  snap() {
    this.fit();
    this.phosphor.frame(this.takenAt, this.taken || new Float32Array(0), this.takenAt);
    return canvas.toDataURL('image/png');
  }

  fit() {
    // The tube fills the main area, 4:3, however the footer wraps.
    const main = canvas.parentElement;
    const cw = Math.min(main.clientWidth - 16, ((main.clientHeight - 16) * 4) / 3);
    const ch = (cw * 3) / 4;
    if (Math.abs(cw - canvas.clientWidth) > 0.5 || Math.abs(ch - canvas.clientHeight) > 0.5) {
      canvas.style.width = `${cw}px`;
      canvas.style.height = `${ch}px`;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(cw * dpr), h = Math.round(ch * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  sounds() {
    const s = this.state;
    if (!s) return;
    if (s.bells > this.bells) {
      if (this.audio) for (let i = this.bells; i < s.bells && i < this.bells + 3; i++) this.bell();
      this.bells = s.bells;
    }
  }

  /** The GT40's bell: the LK40's beeper, a short square-ish tone. */
  bell() {
    const ac = this.audio;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'square';
    o.frequency.value = 1000;
    g.gain.setValueAtTime(0.05, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0005, ac.currentTime + 0.12);
    o.connect(g).connect(ac.destination);
    o.start();
    o.stop(ac.currentTime + 0.13);
  }

  show() {
    const s = this.state;
    if (!s) return;
    const m = messageName(this.engine.symbols, s.sysmes);
    if (m !== this.lastMessage) this.lastMessage = m;
    if (this.frames % 15 === 0) {
      const secs = (s.t / 1e6).toFixed(0);
      if (this.debug) {
        const now = performance.now();
        const fps = (15000 / (now - (this.lastShow || now - 250))).toFixed(0);
        this.lastShow = now;
        status.textContent = `${secs} s · ${fps} fps · ${((this.wallMachine() - s.t) / 1000).toFixed(0)} ms behind · ${this.taken ? this.taken.length / 8 : 0} beams · machine ${(this.tMachine / this.frames).toFixed(1)} ms/f · render ${(this.tRender / this.frames).toFixed(1)} ms/f`;
      } else {
        status.textContent = `${secs} s`;
      }
    }
  }

  /** Encode the recording for a URL: deflated triplets, base64url. */
  async share() {
    const data = new Float32Array(this.recording);
    const cs = new CompressionStream('deflate-raw');
    const w = cs.writable.getWriter();
    w.write(new Uint8Array(data.buffer));
    w.close();
    const buf = await new Response(cs.readable).arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const url = new URL(location.href);
    url.hash = `r=${b64}`;
    return url.toString();
  }

  static async decode(b64) {
    const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const ds = new DecompressionStream('deflate-raw');
    const w = ds.writable.getWriter();
    w.write(bytes);
    w.close();
    const buf = await new Response(ds.readable).arrayBuffer();
    return new Float32Array(buf);
  }

  async start() {
    const module = await WebAssembly.compileStreaming(fetch(new URL('./engine/engine.wasm', import.meta.url)));
    this.engine = await new Engine(module, {
      log: (s) => console.log('[engine]', s),
      frame: (t, b, s, e) => this.frame(t, b, s, e),
      sleep: () => this.sleep(),
    }).init();
    const q = new URLSearchParams(location.search);
    this.debug = q.has('debug');
    // Machine time per wall time; for tests on slow software renderers.
    this.rate = Number(q.get('rate')) || 1;
    this.norender = q.has('norender');
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get('r')) {
      try {
        this.replay = await Page.decode(h.get('r'));
        hint.textContent = 'A replay. Press R for a game of your own.';
      } catch (e) {
        console.warn('bad replay', e);
      }
    }
    this.bind();
    for (;;) {
      this.originWall = performance.now();
      this.originT = 0;
      this.target = LEAD;
      this.bells = 0;
      this.recording = [];
      this.replayAt = 0;
      this.phosphor.clear();
      this.phosphor.now = 0;
      const code = await this.engine.run();
      if (code !== 0) {
        status.textContent = ['', 'HALTED', 'BUS ERROR', 'CONTROL LEFT THE PROGRAM'][code] || `STOPPED (${code})`;
        break;
      }
      // Stopped by the page: a restart.
      this.replay = null;
      this.restarting = false;
    }
  }

  bind() {
    const pen = (ev) => {
      const r = canvas.getBoundingClientRect();
      const dpr = canvas.width / r.width;
      const [x, y] = this.phosphor.toRaster((ev.clientX - r.left) * dpr, (ev.clientY - r.top) * dpr);
      return [Math.round(x), Math.round(y)];
    };
    let down = false;
    canvas.addEventListener('pointerdown', (ev) => {
      this.wake();
      down = true;
      canvas.setPointerCapture(ev.pointerId);
      const [x, y] = pen(ev);
      this.input('pen_x', x);
      this.input('pen_y', y);
      this.input('pen_down', 1);
      ev.preventDefault();
    });
    canvas.addEventListener('pointermove', (ev) => {
      if (!down) return;
      const [x, y] = pen(ev);
      if (x !== this.px || y !== this.py) {
        this.px = x;
        this.py = y;
        this.input('pen_x', x);
        this.input('pen_y', y);
      }
    });
    const up = () => {
      if (!down) return;
      down = false;
      this.input('pen_down', 0);
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

    const held = new Set();
    const turning = () => {
      const fast = held.has('ShiftLeft') || held.has('ShiftRight');
      const l = held.has('ArrowLeft'), r = held.has('ArrowRight');
      return l === r ? 0 : (l ? -1 : 1) * (fast ? 2 : 1);
    };
    window.addEventListener('keydown', (ev) => {
      if (ev.repeat && !['ArrowUp', 'ArrowDown'].includes(ev.code)) return;
      this.wake();
      held.add(ev.code);
      switch (ev.code) {
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ShiftLeft':
        case 'ShiftRight':
          this.input('turning', turning());
          break;
        case 'ArrowUp':
        case 'ArrowDown': {
          const now = this.wanted ?? this.state?.percnt ?? 75;
          this.wanted = Math.max(10, Math.min(100, now + (ev.code === 'ArrowUp' ? 5 : -5)));
          this.input('throttle', this.wanted);
          break;
        }
        case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4':
          this.input('slot', Number(ev.code.slice(-1)) - 1);
          break;
        case 'KeyA':
          this.input('pilot', this.engine.getInput('pilot') === 0 ? -1 : 0);
          break;
        case 'KeyR':
          this.restart();
          break;
        case 'KeyS':
          this.share().then((u) => {
            navigator.clipboard?.writeText(u).catch(() => {});
            history.replaceState(null, '', u);
            hint.textContent = 'Replay link copied: the URL now holds this game.';
          });
          break;
        default:
          return;
      }
      ev.preventDefault();
    });
    window.addEventListener('keyup', (ev) => {
      held.delete(ev.code);
      if (['ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight'].includes(ev.code)) this.input('turning', turning());
      if (['ArrowUp', 'ArrowDown'].includes(ev.code)) this.wanted = undefined;
    });
    window.addEventListener('resize', () => this.fit());
  }

  /** Sound can start only from a gesture. */
  wake() {
    if (!this.audio) {
      try {
        this.audio = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {
        /* no sound */
      }
    }
    if (this.audio?.state === 'suspended') this.audio.resume();
  }

  restart() {
    if (this.restarting) return;
    this.restarting = true;
    this.replay = null;
    this.pending.push(['stop', 1]);
  }
}

const page = new Page();
window.moonlander = page;
page.start().catch((e) => {
  status.textContent = e.message;
  console.error(e);
});
