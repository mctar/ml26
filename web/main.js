// The page: loads the engine, paces it against the clock, shows one of two
// views of the same running program (the Roadster, or the 1973 tube), and
// turns the controls into the light pen the program reads.
import { Engine, messageName, MESSAGES } from './engine/engine.js';
import { Phosphor } from './phosphor.js';
import { Roadster } from './roadster.js';

const $ = (id) => document.getElementById(id);
const tube = $('tube');
const sceneCanvas = $('scene');

/** Machine microseconds the machine may run ahead of the wall clock. */
const LEAD = 8_000;
/** The most machine time computed for one frame, in microseconds. A slow
 * frame rate makes the game run slower, never stall or race to catch up. */
const MAX_STEP = 250_000;
/** Machine time at which the greeting ends and the game begins. */
const GAME_START = 30.6e6;

const FIELDS = ['pen_x', 'pen_y', 'pen_down', 'throttle', 'turning', 'choice', 'slot', 'pilot', 'stop'];

/** The messages, as the Roadster reads them. The originals stay on the tube. */
const MESSAGES_2026 = {
  ...MESSAGES,
  GREATM: 'WELL, IT WORKED.',
  ORDER: 'ONE BURGER IN A CYBERTRUCK BOX, TO GO.',
  MANMSG: 'MADE ON EARTH BY HUMANS.',
  ROCKMS: 'YOU JUST CRASHED INTO 2018 CN41',
  TOPMSG: 'SORRY, BUT WHEN YOU LOSE THE LIVESTREAM, YOU ALSO LOSE YOUR AIR',
  FAST: "DON'T PANIC. START SLOWING IT UP PRETTY SOON.",
  MACDED: "Well, you've just destroyed the only diner on the moon. What a CLOD.",
};

class Page {
  constructor() {
    this.view = 'roadster';
    this.phosphor = null;
    this.roadster = null;
    this.pending = [];       // input writes waiting for the machine: [field, value]
    this.recording = [];     // every write made, with the tick it was made at
    this.replay = null;      // writes to make, from a URL
    this.replayAt = 0;
    this.originWall = 0;
    this.originT = 0;
    this.target = LEAD;
    this.rate = 1;
    this.taken = new Float32Array(0);
    this.takenAt = 0;
    this.frames = 0;
    this.bells = 0;
    this.audio = null;
    this.state = null;
    this.lastMessage = undefined;
    this.tMachine = 0;
    this.tRender = 0;
    this.lastFrame = 0;
    this.arrival = true;
  }

  wallMachine() {
    return this.originT + (performance.now() - this.originWall) * 1000 * this.rate;
  }

  /** Queue an input write; it reaches the machine at its next tend. */
  input(field, value) {
    if (this.replay && field !== 'stop') return; // a replay drives the machine, not the hands
    this.pending.push([field, value]);
  }

  /** The engine's callback, at least once per machine millisecond. */
  frame(t, beams, state, eng) {
    this.state = state;
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
    this.taken = beams.slice();
    this.takenAt = t;
    return { yield: true, take: true };
  }

  async sleep() {
    const t0 = performance.now();
    this.tMachine += t0 - (this.tResume || t0);
    await new Promise((r) => requestAnimationFrame(r));
    const t1 = performance.now();
    // The greeting runs fast behind the arrival card; the game at its pace.
    const wanted = this.greeting() ? this.fastRate : this.userRate;
    if (wanted !== this.rate) {
      this.originT = this.wallMachine();
      this.originWall = t1;
      this.rate = wanted;
    }
    let wm = this.wallMachine();
    if (wm > this.takenAt + MAX_STEP * this.rate) {
      this.originT = this.takenAt + MAX_STEP * this.rate;
      this.originWall = t1;
      wm = this.originT;
    }
    this.target = wm + LEAD;
    this.draw(t1);
    this.tRender += performance.now() - t1;
    this.tResume = performance.now();
  }

  greeting() {
    return this.state && this.state.t < GAME_START && !this.replay;
  }

  draw(now) {
    const dt = Math.min(0.1, (now - (this.lastFrame || now)) / 1000);
    this.lastFrame = now;
    this.frames++;
    if (this.arrival && this.state && this.state.t >= GAME_START) this.landed();
    if (this.view === 'tube') {
      this.fitTube();
      this.phosphor.frame(this.takenAt, this.taken, this.takenAt);
    } else {
      if (!this.roadster.terrain && this.engine.game) {
        this.roadster.load(this.engine.symbols, (a) => this.engine.peek(a));
        this.roadster.maxThrust = this.engine.symbols.MAXTRS;
      }
      if (this.state && this.roadster.terrain) this.roadster.frame(this.state, now, dt);
    }
    this.sounds();
    this.hud();
  }

  /** The arrival card comes down and the game is on. */
  landed() {
    this.arrival = false;
    const a = $('arrival');
    a.style.opacity = '0';
    setTimeout(() => a.classList.add('hidden'), 650);
  }

  fitTube() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(tube.clientWidth * dpr), h = Math.round(tube.clientHeight * dpr);
    if (tube.width !== w || tube.height !== h) {
      tube.width = w;
      tube.height = h;
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

  hud() {
    const s = this.state;
    if (!s) return;
    if (this.frames % 3 === 0) {
      $('r-alt').textContent = Math.max(0, s.radary).toLocaleString('en-US');
      $('r-dist').textContent = s.hordis.toLocaleString('en-US');
      $('r-vv').textContent = (s.vervel / 10).toFixed(1);
      $('r-hv').textContent = (s.horvel / 10).toFixed(1);
      $('r-air').textContent = Math.max(0, Math.round(s.fuel / 10)).toLocaleString('en-US');
      $('r-air-box').classList.toggle('warn', !!s.fuel_low);
      $('r-pct').textContent = s.percnt;
      const pct = Math.max(0, Math.min(100, s.percnt));
      const th = $('throttle');
      th.querySelector('.fill').style.height = `${pct}%`;
      th.querySelector('.knob').style.bottom = `${pct}%`;
      const ghost = th.querySelector('.ghost');
      if (this.wanted != null && this.wanted !== s.percnt) {
        ghost.style.opacity = '1';
        ghost.style.bottom = `${this.wanted}%`;
      } else {
        ghost.style.opacity = '0';
      }
    }
    const m = messageName(this.engine.symbols, s.sysmes);
    if (m !== this.lastMessage) {
      this.lastMessage = m;
      $('message').textContent = m ? MESSAGES_2026[m] : '';
    }
    if (this.frames % 15 === 0) {
      const secs = (s.t / 1e6).toFixed(0);
      if (this.debug) {
        const now = performance.now();
        const fps = (15000 / (now - (this.lastShow || now - 250))).toFixed(0);
        this.lastShow = now;
        $('status').textContent = `${secs} s · ${fps} fps · ${((this.wallMachine() - s.t) / 1000).toFixed(0)} ms behind · ${this.taken.length / 8} beams · machine ${(this.tMachine / this.frames).toFixed(1)} ms/f · render ${(this.tRender / this.frames).toFixed(1)} ms/f`;
      } else {
        $('status').textContent = `${secs} s`;
      }
    }
  }

  /** For tests: draw the current view once and return it as a PNG. */
  snap() {
    this.draw(performance.now());
    return (this.view === 'tube' ? tube : sceneCanvas).toDataURL('image/png');
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
    const q = new URLSearchParams(location.search);
    this.debug = q.has('debug');
    this.userRate = Number(q.get('rate')) || 1;
    this.fastRate = Math.max(this.userRate, 24);
    this.rate = this.userRate;
    if (q.get('view') === '1973' || q.has('tube')) this.view = 'tube';
    this.phosphor = new Phosphor(tube);
    this.roadster = new Roadster(sceneCanvas);
    this.setView(this.view);

    const module = await WebAssembly.compileStreaming(fetch(new URL('./engine/engine.wasm', import.meta.url)));
    this.engine = await new Engine(module, {
      log: (s) => console.log('[engine]', s),
      frame: (t, b, s, e) => this.frame(t, b, s, e),
      sleep: () => this.sleep(),
    }).init();
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get('r')) {
      try {
        this.replay = await Page.decode(h.get('r'));
        $('arrival-note').textContent = 'A replay. Press R for a flight of your own.';
      } catch (e) {
        console.warn('bad replay', e);
      }
    }
    this.bind();
    if (q.has('pilot')) this.pending.push(['pilot', Number(q.get('pilot')) || 0]);
    for (;;) {
      this.originWall = performance.now();
      this.originT = 0;
      this.target = LEAD;
      this.bells = 0;
      this.recording = [];
      this.replayAt = 0;
      this.wanted = undefined;
      this.phosphor.clear();
      this.phosphor.now = 0;
      this.roadster.reset();
      if (!this.arrival) {
        this.arrival = true;
        $('arrival').classList.remove('hidden');
        $('arrival').style.opacity = '1';
      }
      const code = await this.engine.run();
      if (code !== 0) {
        $('status').textContent = ['', 'HALTED', 'BUS ERROR', 'CONTROL LEFT THE PROGRAM'][code] || `STOPPED (${code})`;
        break;
      }
      this.replay = null;
      this.restarting = false;
    }
  }

  setView(v) {
    this.view = v;
    tube.classList.toggle('hidden', v !== 'tube');
    sceneCanvas.classList.toggle('hidden', v === 'tube');
    $('hud').classList.toggle('hidden', v === 'tube');
    $('hint').classList.toggle('hidden', v !== 'tube');
    $('hint').textContent = 'The 1973 view. The mouse is the light pen: hold it on the bar for throttle, on the arrows to turn. V returns to the Roadster.';
    $('view-toggle').textContent = v === 'tube' ? 'Roadster' : '1973 view';
  }

  bind() {
    // The tube: the mouse is the pen.
    const pen = (ev) => {
      const r = tube.getBoundingClientRect();
      const dpr = tube.width / r.width;
      const [x, y] = this.phosphor.toRaster((ev.clientX - r.left) * dpr, (ev.clientY - r.top) * dpr);
      return [Math.round(x), Math.round(y)];
    };
    let down = false;
    tube.addEventListener('pointerdown', (ev) => {
      this.wake();
      down = true;
      tube.setPointerCapture(ev.pointerId);
      const [x, y] = pen(ev);
      this.input('pen_x', x);
      this.input('pen_y', y);
      this.input('pen_down', 1);
      ev.preventDefault();
    });
    tube.addEventListener('pointermove', (ev) => {
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
    tube.addEventListener('pointerup', up);
    tube.addEventListener('pointercancel', up);
    tube.addEventListener('contextmenu', (ev) => ev.preventDefault());

    // The throttle bar: drag to the percentage wanted.
    const th = $('throttle');
    const thAt = (ev) => {
      const r = th.getBoundingClientRect();
      const pct = Math.round(100 * (1 - (ev.clientY - r.top) / r.height));
      return Math.max(10, Math.min(100, pct));
    };
    let dragging = false;
    th.addEventListener('pointerdown', (ev) => {
      this.wake();
      dragging = true;
      th.setPointerCapture(ev.pointerId);
      this.throttleTo(thAt(ev));
      ev.preventDefault();
    });
    th.addEventListener('pointermove', (ev) => {
      if (dragging) this.throttleTo(thAt(ev));
    });
    const thUp = () => (dragging = false);
    th.addEventListener('pointerup', thUp);
    th.addEventListener('pointercancel', thUp);
    th.addEventListener('wheel', (ev) => {
      this.throttleTo((this.wanted ?? this.state?.percnt ?? 75) + (ev.deltaY < 0 ? 2 : -2));
      ev.preventDefault();
    }, { passive: false });

    // The arrows.
    for (const b of document.querySelectorAll('#turn button')) {
      const d = Number(b.dataset.turn);
      const start = (ev) => {
        this.wake();
        b.classList.add('on');
        this.input('turning', d);
        ev.preventDefault();
      };
      const stop = () => {
        if (!b.classList.contains('on')) return;
        b.classList.remove('on');
        this.input('turning', this.keyTurning());
      };
      b.addEventListener('pointerdown', start);
      b.addEventListener('pointerup', stop);
      b.addEventListener('pointercancel', stop);
      b.addEventListener('pointerleave', stop);
    }

    $('view-toggle').addEventListener('click', () => this.setView(this.view === 'tube' ? 'roadster' : 'tube'));
    $('about-toggle').addEventListener('click', () => $('about').classList.remove('hidden'));
    $('about-close').addEventListener('click', () => $('about').classList.add('hidden'));
    $('arrival').addEventListener('click', () => this.wake());

    this.held = new Set();
    window.addEventListener('keydown', (ev) => {
      if (ev.repeat && !['ArrowUp', 'ArrowDown'].includes(ev.code)) return;
      if (ev.code === 'Escape') $('about').classList.add('hidden');
      this.wake();
      this.held.add(ev.code);
      switch (ev.code) {
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ShiftLeft':
        case 'ShiftRight':
          this.input('turning', this.keyTurning());
          break;
        case 'ArrowUp':
        case 'ArrowDown':
          this.throttleTo((this.wanted ?? this.state?.percnt ?? 75) + (ev.code === 'ArrowUp' ? 5 : -5));
          break;
        case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4':
          this.input('slot', Number(ev.code.slice(-1)) - 1);
          break;
        case 'KeyA':
          this.input('pilot', this.engine.getInput('pilot') === 0 ? -1 : 0);
          break;
        case 'KeyV':
          this.setView(this.view === 'tube' ? 'roadster' : 'tube');
          break;
        case 'KeyR':
          this.restart();
          break;
        case 'KeyS':
          this.share().then((u) => {
            navigator.clipboard?.writeText(u).catch(() => {});
            history.replaceState(null, '', u);
            $('message').textContent = 'REPLAY LINK COPIED. THE URL NOW HOLDS THIS FLIGHT.';
            this.lastMessage = undefined;
          });
          break;
        default:
          return;
      }
      ev.preventDefault();
    });
    window.addEventListener('keyup', (ev) => {
      this.held.delete(ev.code);
      if (['ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight'].includes(ev.code)) this.input('turning', this.keyTurning());
    });
  }

  keyTurning() {
    const h = this.held;
    const fast = h.has('ShiftLeft') || h.has('ShiftRight');
    const l = h.has('ArrowLeft'), r = h.has('ArrowRight');
    return l === r ? 0 : (l ? -1 : 1) * (fast ? 2 : 1);
  }

  throttleTo(pct) {
    this.wanted = Math.max(10, Math.min(100, Math.round(pct)));
    this.input('throttle', this.wanted);
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
  $('status').textContent = e.message;
  console.error(e);
});
