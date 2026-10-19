// The page: loads the engine, paces it against the clock, shows one of two
// views of the same running program (the Roadster, or the 1973 tube), and
// turns the controls into the light pen the program reads.
import { Engine, messageName, MESSAGES } from './engine/engine.js';
import { Phosphor } from './phosphor.js';
import { Roadster } from './roadster.js';
import { Sound } from './sound.js';
import { Radio } from './radio.js';

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
/** The program's verdicts on a landing. */
const LANDINGS = ['GREATM', 'GOODM', 'ROUGHM', 'CRIPM'];
/** The layers that can sit over the flight, topmost first. */
const OVERLAYS = ['guide', 'about', 'ending'];

const FIELDS = ['pen_x', 'pen_y', 'pen_down', 'throttle', 'turning', 'choice', 'slot', 'pilot', 'stop'];

/** The messages, as the Roadster reads them. The originals stay on the tube. */
const MESSAGES_2026 = {
  ...MESSAGES,
  GREATM: 'WELL, IT WORKED.',
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
    this.sound = new Sound();
    this.radio = new Radio(this.sound);
    this.state = null;
    this.prev = null;
    this.lastMessage = undefined;
    this.tMachine = 0;
    this.tRender = 0;
    this.lastFrame = 0;
    this.arrival = true;
    this.holds = new Set(); // what is holding the flight: an open sheet, the end card
    this.flight = null; // this descent: when it began, how it came down, whether he ordered
  }

  wallMachine() {
    return this.originT + (performance.now() - this.originWall) * 1000 * this.rate;
  }

  /** Queue an input write; it reaches the machine at its next tend. */
  input(field, value) {
    if (this.replay && field !== 'stop') return; // a replay drives the machine, not the hands
    this.pending.push([field, value]);
    if (field === 'throttle' || field === 'turning' || field === 'pilot') this.coached();
  }

  /** The first move made: the coaching line goes. */
  coached() {
    if (this.coachDone) return;
    this.coachDone = true;
    $('coach').style.opacity = '0';
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
    let t1 = performance.now();
    // While something is over the flight (a sheet, the end card) the
    // machine is given no time at all, and the scene stands still; on
    // release it carries on from the same instant.
    if (this.holds.size) {
      this.rate = 0;
      while (this.holds.size) {
        this.draw(t1);
        await new Promise((r) => requestAnimationFrame(r));
        t1 = performance.now();
      }
      this.originT = this.takenAt;
      this.originWall = t1;
    }
    // The greeting runs fast behind the arrival card; then the machine
    // holds until the card is dismissed; then the game at its pace.
    const wanted = this.greeting() ? this.fastRate : this.arrival ? 0 : this.userRate;
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

  draw(now, force = false) {
    const dt = Math.min(0.1, (now - (this.lastFrame || now)) / 1000);
    this.lastFrame = now;
    this.frames++;
    if (this.arrival) this.orbit(now);
    if (this.arrival && this.state && this.state.t >= GAME_START && now - this.arrivalSince > 3600 && this.sound.ac) this.landed();
    if (!this.roadster.terrain && this.engine.game) {
      this.roadster.load(this.engine.symbols, (a) => this.engine.peek(a));
      this.roadster.maxThrust = this.engine.symbols.MAXTRS;
    }
    this.roadster.rate = this.rate;
    if (this.state && this.roadster.terrain) this.roadster.update(this.state, now, dt);
    this.sounds();
    this.hud();
    if (this.norender && !force) return;
    // The tube is drawn in both views: on the page, or on the diner's screens.
    this.fitTube();
    this.phosphor.frame(this.takenAt, this.taken, this.takenAt);
    if (this.view !== 'tube') this.roadster.render();
  }

  /** The car goes round its orbit on the arrival card, and leaves. */
  orbit(now) {
    const car = $('car'), earth = $('earth'), mars = $('mars');
    if (!car) return;
    const s = (now - this.arrivalSince) / 1000;
    // Sound needs a gesture; after the orbit has played, ask for one.
    if (s > 3 && !this.sound.ac && !this.replay) $('arrival-note').textContent = 'Tap or press a key to begin';
    // Years pass quickly: the Roadster's 1.525-year period, Earth's one,
    // Mars's 1.88, from the launch geometry (roughly: Earth at the car).
    const yrs = s * 1.6;
    const a = 92.75, b = 89.7, c = -23.7;
    const th = (yrs / 1.525) * Math.PI * 2;
    car.setAttribute('cx', (c + a * Math.cos(th)).toFixed(2));
    car.setAttribute('cy', (-b * Math.sin(th)).toFixed(2));
    const te = yrs * Math.PI * 2;
    earth.setAttribute('cx', (70 * Math.cos(te)).toFixed(2));
    earth.setAttribute('cy', (-70 * Math.sin(te)).toFixed(2));
    const tm = Math.PI + (yrs / 1.88) * Math.PI * 2;
    mars.setAttribute('cx', (106.7 * Math.cos(tm)).toFixed(2));
    mars.setAttribute('cy', (-106.7 * Math.sin(tm)).toFixed(2));
  }

  /** The arrival card comes down and the game is on; the first time, the
   * controller reads the brief over the radio. */
  landed() {
    this.arrival = false;
    const a = $('arrival');
    a.style.opacity = '0';
    setTimeout(() => a.classList.add('hidden'), 650);
    if (!this.briefed && !this.replay) {
      this.briefed = true;
      this.radio.say('BRIEF');
    }
    this.radio.preload(Object.keys(MESSAGES_2026).concat(['AIRLOW']));
  }

  fitTube() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const onPage = this.view === 'tube';
    const w = onPage ? Math.round(tube.clientWidth * dpr) : 512, h = onPage ? Math.round(tube.clientHeight * dpr) : 384;
    if (tube.width !== w || tube.height !== h) {
      tube.width = w;
      tube.height = h;
    }
  }

  sounds() {
    const s = this.state, p = this.prev;
    if (!s) return;
    const exploded = this.roadster.exploded;
    this.sound.update(exploded ? 0 : this.roadster.thrustNow, s, 0);
    const alt = (this.alt = this.altitude(s));
    if (p) {
      if (s.radius > 0 && p.radius === 0) this.sound.explosion();
      else if (alt <= 0 && this.altPrev > 0 && s.verdis < 450 && !exploded) this.sound.contact(p.vervel / 10);
      if (this.roadster.puffing && !this.puffWas) this.sound.puff();
    }
    this.puffWas = this.roadster.puffing;
    this.altPrev = alt;
    this.prev = { ...s };
  }

  /**
   * The radar height, as the dashboard shows it. In the close-up the
   * program works it out twice a step: from the full table (for the far
   * view), and from the close-up's own ground, a quarter as high. Only the
   * second is the height above the ground you see, so the first is passed
   * over there; it shows which it is by the ground height it leaves behind.
   */
  altitude(s) {
    const ter = this.roadster.terrain;
    if (ter && this.roadster.closeUp(s)) {
      const full = (ter[s.bigxct] + ter[s.bigxct + 1]) >> 1;
      if (s.avery === full && full >> 2 !== full) return this.altWas ?? s.radary;
    }
    this.altWas = s.radary;
    return s.radary;
  }

  hud() {
    const s = this.state;
    if (!s) return;
    if (this.frames % 3 === 0) {
      $('r-alt').textContent = Math.max(0, this.alt ?? s.radary).toLocaleString('en-US');
      $('r-dist').textContent = s.hordis.toLocaleString('en-US');
      $('r-vv').textContent = (s.vervel / 10).toFixed(1);
      $('r-hv').textContent = (s.horvel / 10).toFixed(1);
      $('r-air').textContent = Math.max(0, Math.round(s.fuel / 10)).toLocaleString('en-US');
      $('r-air-box').classList.toggle('warn', !!s.fuel_low);
      // The car's own screen, when the air runs low.
      $('r-air-box').querySelector('.label').textContent = s.fuel_low ? "Don't panic" : 'Air left';
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
    this.follow(s, m);
    if (m !== this.lastMessage) {
      this.lastMessage = m;
      $('message').textContent = m ? MESSAGES_2026[m] : '';
      if (m && !this.arrival) this.radio.say(m, { urgent: ['DEADM', 'MACDED', 'ROCKMS', 'OLDMS', 'OLDTLT', 'ANGLEJ'].includes(m) });
    }
    if (s.fuel_low && !this.airLowSaid) {
      this.airLowSaid = true;
      if (!this.arrival) this.radio.say('AIRLOW');
    }
    if (!s.fuel_low) this.airLowSaid = false;
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

  /**
   * This descent, for the end card: when it began (after the greeting, or
   * when the program starts again high up), how it came down, and whether
   * he ordered. When the car has gone from the diner, the card.
   */
  follow(s, m) {
    if (s.t < GAME_START) return;
    if (!this.flight || s.verdis - this.flight.verdis > 15000) this.flight = { t: s.t, verdis: s.verdis, touchdown: null, ordered: false, ended: false };
    const f = this.flight;
    f.verdis = s.verdis;
    if (!f.touchdown && LANDINGS.includes(m) && s.verdis < 450) f.touchdown = { vv: s.vervel / 10, msg: m, t: s.t, air: s.fuel / 10 };
    if (m === 'ORDER') f.ordered = true;
    // The program takes the car off the screen once it has climbed away.
    if (f.ordered && !f.ended && s.shipdp === 0) {
      f.ended = true;
      this.ending(f);
    }
  }

  /** The end of a visit to the diner: how it went, and what next. */
  ending(f) {
    const td = f.touchdown;
    $('end-vv').textContent = td ? Math.abs(td.vv).toFixed(1) : '0';
    $('end-grade').textContent = td ? MESSAGES_2026[td.msg] : '';
    $('end-time').textContent = td ? Math.round((td.t - f.t) / 1e6).toLocaleString('en-US') : '0';
    $('end-air').textContent = td ? Math.max(0, Math.round(td.air)).toLocaleString('en-US') : '0';
    $('end-share').textContent = 'Copy replay link';
    this.show('ending');
  }

  /** The flight stops while anything is over it, and goes on after. */
  hold(why, on) {
    if (on) this.holds.add(why);
    else this.holds.delete(why);
    this.sound.pause(this.holds.size > 0);
  }

  /** Open a sheet or the end card over the flight, which waits. */
  show(id) {
    const el = $(id);
    if (!el.classList.contains('hidden')) return;
    for (const other of ['guide', 'about']) if (other !== id) this.hide(other, false);
    if (!this.overlay()) this.returnFocus = document.activeElement;
    el.classList.remove('hidden');
    el.scrollTop = 0;
    this.hold(id, true);
    (el.querySelector('.primary, .close') || el).focus({ preventScroll: true });
  }

  hide(id, refocus = true) {
    const el = $(id);
    if (el.classList.contains('hidden')) return;
    el.classList.add('hidden');
    this.hold(id, false);
    const top = this.overlay();
    if (top) $(top).querySelector('.primary, .close')?.focus({ preventScroll: true });
    else {
      const back = this.returnFocus;
      this.returnFocus = null;
      if (refocus && back && back !== document.body && document.contains(back) && back.offsetParent !== null) back.focus({ preventScroll: true });
      else if (el.contains(document.activeElement)) document.activeElement.blur();
    }
  }

  /** The layer on top, if any. */
  overlay() {
    return OVERLAYS.find((id) => !$(id).classList.contains('hidden')) || null;
  }

  /** Keys while something is over the flight: close it, or the card's own. */
  overlayKey(top, ev) {
    if (ev.code === 'Escape') {
      this.hide(top);
      ev.preventDefault();
      return;
    }
    if (ev.code === 'Tab') {
      // Round the layer's own controls, not out to the page under it.
      const all = [...$(top).querySelectorAll('button, a[href]')].filter((b) => b.offsetParent !== null);
      if (!all.length) return;
      const i = all.indexOf(document.activeElement);
      const next = ev.shiftKey ? (i <= 0 ? all.length - 1 : i - 1) : i === all.length - 1 ? 0 : i + 1;
      all[next].focus();
      ev.preventDefault();
      return;
    }
    if (ev.repeat) return;
    if (top === 'guide' && (ev.code === 'KeyH' || ev.key === '?')) this.hide('guide');
    else if (top === 'ending') {
      if (ev.code === 'KeyS') this.copyReplay($('end-share'));
      else if (ev.code === 'KeyR') this.playAgain();
      else if (ev.code === 'KeyH' || ev.key === '?') this.show('guide');
    }
  }

  /** From the end card: a new flight, from the top. */
  playAgain() {
    this.hide('ending', false);
    this.restart();
  }

  /** The link that replays this flight: in the address bar, and copied
   * where the browser allows it. */
  copyReplay(button = null) {
    this.share().then((u) => {
      history.replaceState(null, '', u);
      if (button) button.textContent = 'Replay link copied';
      else {
        $('message').textContent = 'REPLAY LINK COPIED. THE URL NOW HOLDS THIS FLIGHT.';
        this.lastMessage = undefined;
      }
      try {
        navigator.clipboard?.writeText(u).catch(() => {});
      } catch (e) {
        /* the address bar has it */
      }
    });
  }

  /** For tests: draw the current view once and return it as a PNG. */
  snap() {
    this.draw(performance.now(), true);
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
    this.norender = q.has('norender');
    this.fastRate = Math.max(this.userRate, 24);
    this.rate = this.userRate;
    if (q.get('view') === '1973' || q.has('tube')) this.view = 'tube';
    this.phosphor = new Phosphor(tube);
    this.roadster = new Roadster(sceneCanvas, tube);
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
    if (q.has('pilot')) {
      this.pending.push(['pilot', Number(q.get('pilot')) || 0]);
      this.coached();
    }
    for (;;) {
      this.originWall = performance.now();
      this.originT = 0;
      this.target = LEAD;
      this.sound.bells = 0;
      this.prev = null;
      this.recording = [];
      this.replayAt = 0;
      this.wanted = undefined;
      this.flight = null;
      this.altWas = undefined;
      this.altPrev = undefined;
      this.phosphor.clear();
      this.phosphor.now = 0;
      this.roadster.reset();
      if (!this.arrival) {
        this.arrival = true;
        $('arrival').classList.remove('hidden');
        $('arrival').style.opacity = '1';
      }
      this.arrivalSince = performance.now();
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
    $('about-toggle').addEventListener('click', () => this.show('about'));
    $('about-close').addEventListener('click', () => this.hide('about'));
    $('guide-toggle').addEventListener('click', () => this.show('guide'));
    $('guide-close').addEventListener('click', () => this.hide('guide'));
    $('end-again').addEventListener('click', () => this.playAgain());
    $('end-share').addEventListener('click', (ev) => this.copyReplay(ev.currentTarget));
    $('end-guide').addEventListener('click', () => this.show('guide'));
    // A click on a sheet's backdrop, outside its text, closes it.
    for (const id of ['guide', 'about']) $(id).addEventListener('click', (ev) => {
      if (ev.target === ev.currentTarget) this.hide(id);
    });
    $('arrival').addEventListener('click', () => this.wake());
    $('arrival').addEventListener('touchend', () => this.wake(), { passive: true });

    this.held = new Set();
    window.addEventListener('keydown', (ev) => {
      const top = this.overlay();
      if (top) {
        this.overlayKey(top, ev);
        return;
      }
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.repeat && !['ArrowUp', 'ArrowDown'].includes(ev.code)) return;
      this.wake();
      if (ev.key === '?') {
        this.show('guide');
        ev.preventDefault();
        return;
      }
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
          this.copyReplay();
          break;
        case 'KeyH':
          this.show('guide');
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
    if (this.holds.size) return;
    try {
      this.sound.wake();
    } catch (e) {
      /* no sound */
    }
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
