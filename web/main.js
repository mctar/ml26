// The page: loads the engine, paces it against the clock, shows one of two
// views of the same running program (the Roadster, or the 1973 tube), and
// turns the controls into the light pen the program reads.
import { Engine, messageName, MESSAGES } from './engine/engine.js';
import { Phosphor } from './phosphor.js';
import { Roadster } from './roadster.js';
import { Sound } from './sound.js';
import { Radio } from './radio.js';
import { Title } from './title.js';

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
/** Machine time at which the opening holds the greeting on the tube, if no
 * key has come by then: all of it drawn, a few seconds before its end. */
const GREET_HOLD = 26e6;
/** The opening: how long the greeting stays on the tube before 2026 comes
 * up, and how long the camera takes to draw back into the flight's own
 * view once the key has come (seconds). */
const TUBE_SECONDS = 9;
const PULL = 2.9;
const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const smooth = (x) => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};
/** The program's verdicts on a landing. */
const LANDINGS = ['GREATM', 'GOODM', 'ROUGHM', 'CRIPM'];
/** The layers that can sit over the flight, topmost first. */
const OVERLAYS = ['guide', 'about', 'demo', 'ending'];
/**
 * The demo flights, behind D: the autopilot flies each to one way of
 * ending, on a fresh Moon, quickly where nothing much happens. A plan is
 * the engine's autopilot number (engine/src/lib.rs), -1 for nobody at the
 * controls, or 'here' for the place the last flight came down.
 */
const DEMOS = [
  { name: 'Lunch at the diner', what: 'Orders at the window, carries the bag back, lifts off.', plans: [1] },
  { name: 'A flag in the open', what: 'A gentle landing well away from the diner.', plans: [2] },
  { name: 'A little fast', what: 'Down at about 20 ft/s, and still walks away.', plans: [3] },
  { name: 'Damage done', what: 'Down at over 30 ft/s. The car minds.', plans: [4] },
  { name: 'Sideways', what: 'Touches down sliding, and over it goes.', plans: [5] },
  { name: 'Too steep', what: 'Comes down across a step in the ground.', plans: [9] },
  { name: 'Hands off', what: 'Nobody touches anything.', plans: [-1] },
  { name: 'Straight up', what: 'Full thrust until the program loses sight of the car.', plans: [7] },
  { name: 'Into the diner', what: 'Straight onto the roof.', plans: [10] },
  { name: 'Into a boulder', what: 'Picks a rock and lands on it.', plans: [1650] },
  { name: 'Parking dispute', what: 'Plants a flag, then comes back to the same spot.', plans: [2, 'here'] },
  { name: 'Same spot, twice', what: 'Tips over, then comes back to the same spot.', plans: [5, 'here'] },
];

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

/** The tilt messages, which the program draws at the flame's place. */
const TILTS = ['SIDEM', 'ANGLEM', 'BUMPYM'];
/** Messages that end a flight in a heap, and what kind of heap. */
const WRECKS = { DEADM: 'crash', ROCKMS: 'rock', OLDMS: 'oldship', OLDTLT: 'wreck', MACDED: 'dinerdead' };
/** The program's verdicts, as one word or two for the card. */
const GRADE = { GREATM: 'Perfect', GOODM: 'Good', ROUGHM: 'A little fast', CRIPM: 'Damaged' };

const fmt = (v, d = 0) => (Number.isFinite(v) ? v : 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const secs = (f, t) => Math.max(0, Math.round((t - f.t) / 1e6));

/**
 * How each way of finishing reads on the card: a heading, a line of our
 * own under the program's, the readouts that matter for it, and how long
 * after the moment itself the card comes up (machine seconds; the program
 * waits about ten before its next descent, nine after a crash).
 */
const ENDINGS = {
  diner: {
    after: 0.4,
    title: () => 'Back from the diner',
    quip: () => 'Lunch rides home on his lap.',
    stats: (f) => [touchdown(f), ['Time to land', fmt(secs(f, f.td.t)), 's'], ['Air left', fmt(f.td.air), 'lb']],
  },
  flag: {
    after: 8.6,
    title: () => 'Flag planted',
    quip: (f) => (f.dinerGone ? 'No diner on this Moon any more, so a flag it is.' : `The diner was ${fmt(f.toDiner)} ft away. The flag will have to do.`),
    stats: (f) => [touchdown(f), ['Time to land', fmt(secs(f, f.td.t)), 's'], f.dinerGone ? ['Air left', fmt(f.td.air), 'lb'] : ['To the diner', fmt(f.toDiner), 'ft']],
  },
  tipped: {
    after: 6,
    title: () => 'Tipped over',
    quip: (f) => ({
      SIDEM: `Parallel parking at ${fmt(Math.abs(f.at.hv), 1)} ft/s. The program allows 10.`,
      ANGLEM: `Down at a ${fmt(Math.abs(f.at.angle))}\u00b0 lean. The program allows 15.`,
      BUMPYM: `One side came down ${fmt(f.at.step)} ft lower than the other. The program allows less than 48.`,
    })[f.tilt],
    stats: (f) => [
      touchdown(f),
      {
        SIDEM: ['Sideways', fmt(Math.abs(f.at.hv), 1), 'ft/s', '10 at most', true],
        ANGLEM: ['Lean', fmt(Math.abs(f.at.angle)), '\u00b0', '15 at most', true],
        BUMPYM: ['Ground step', fmt(f.at.step), 'ft', 'under 48', true],
      }[f.tilt],
      ['Time to land', fmt(secs(f, f.at.t)), 's'],
    ],
  },
  crash: {
    after: 5,
    title: (f) => (f.at.air <= 0 ? 'Out of air' : 'New crater'),
    quip: (f) =>
      f.at.air > 0
        ? `Down at ${fmt(Math.abs(f.at.vv), 1)} ft/s. Under 60 would have counted as a landing.`
        : f.offEdge
          ? 'Leaving the map costs all your air. Gravity did the rest.'
          : `The air ran out at ${fmt(f.airOutAt ?? 0)} ft. Gravity did the rest.`,
    stats: (f) => [['Impact', fmt(Math.abs(f.at.vv), 1), 'ft/s', 'under 60 lands', true], ['Flight time', fmt(secs(f, f.at.t)), 's'], ['Air left', fmt(f.at.air), 'lb', f.at.air <= 0 ? 'none' : '', f.at.air <= 0]],
  },
  rock: { after: 6.5, title: () => 'Rock meets Roadster', quip: () => 'Small solar system.', stats: (f) => inFlight(f) },
  oldship: { after: 6.5, title: () => 'Parking dispute', quip: () => 'That space was taken.', stats: (f) => inFlight(f) },
  wreck: { after: 6.5, title: () => 'Same spot, twice', quip: () => 'Lightning never strikes the same place twice. Roadsters do.', stats: (f) => inFlight(f) },
  dinerdead: { after: 6.5, title: () => 'Diner closed', quip: () => 'It stays closed until a New Moon.', stats: (f) => inFlight(f) },
};

function touchdown(f) {
  return ['Touchdown', fmt(Math.abs(f.td.vv), 1), 'ft/s', GRADE[f.td.msg] || '', f.td.msg === 'CRIPM'];
}

function inFlight(f) {
  return [['Speed', fmt(Math.hypot(f.at.vv, f.at.hv), 1), 'ft/s'], ['Flight time', fmt(secs(f, f.at.t)), 's'], ['Air left', fmt(f.at.air), 'lb']];
}

/** What this Moon has seen, for the card: "2 lunches, 1 flag, 3 crashes". */
function tallyLine(t) {
  const part = (n, one, many) => (n ? `${n} ${n === 1 ? one : many}` : '');
  const parts = [part(t.lunch, 'lunch', 'lunches'), part(t.flag, 'flag', 'flags'), part(t.tipped, 'tip-over', 'tip-overs'), part(t.crash, 'crash', 'crashes'), t.diner ? 'no diner' : ''].filter(Boolean);
  if (!parts.length) return '';
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return `This Moon so far: ${list}.`;
}

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
    // The opening: { phase: 'tube' } the 1973 greeting until a key, then
    // { phase: 'show' } the switch to 2026 and into the flight; null after.
    this.intro = null;
    this.holds = new Set(); // what is holding the flight: an open sheet, the end card
    this.flight = null; // this descent: when it began, how it came down, how it ended
    this.tally = { lunch: 0, flag: 0, tipped: 0, crash: 0, diner: false }; // this Moon's flights
    this.skipping = false; // through the program's wait before its next descent
    this.demo = null; // a demo flight under way: { ...DEMOS[i], step }
    this.muted = false;
    try {
      this.muted = localStorage.getItem('moonlander.muted') === '1';
    } catch (e) {
      /* no storage: sound on */
    }
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
    if (this.holds.size || this.introHolds()) {
      this.rate = 0;
      while (this.holds.size || this.introHolds()) {
        this.draw(t1);
        await new Promise((r) => requestAnimationFrame(r));
        t1 = performance.now();
      }
      this.originT = this.takenAt;
      this.originWall = t1;
    }
    // The greeting in real time on the tube until a key, then fast to the
    // start, where the opening holds the machine until it is over; then
    // the game at its pace.
    const i = this.intro;
    const wanted = i && i.phase === 'tube' ? 1 : (i && this.state && this.state.t < GAME_START) || this.greeting() || this.skipping ? this.fastRate : this.demo ? this.demoPace() : this.userRate;
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
    // The opening stops the machine exactly where it holds it.
    const i2 = this.intro;
    if (i2 && this.state) {
      const cap = i2.phase === 'tube' ? GREET_HOLD : GAME_START;
      if (this.state.t < cap) this.target = Math.min(this.target, cap);
    }
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
    if (this.holds.has('about')) this.orbit(now);
    if (this.intro) this.introStep(now);
    if (!this.roadster.terrain && this.engine.game) {
      this.roadster.load(this.engine.symbols, (a) => this.engine.peek(a));
      this.roadster.maxThrust = this.engine.symbols.MAXTRS;
    }
    this.roadster.rate = this.rate;
    if (this.state && this.roadster.terrain) this.roadster.update(this.state, now, dt);
    this.sounds();
    this.hud();
    if (this.norender && !force) return;
    // The tube is drawn in both views: on the page, or on the diner's
    // screens. Held at the end of the greeting, it keeps the last picture.
    const resized = this.fitTube();
    const i = this.intro;
    if (!(i && i.phase === 'tube' && this.introHolds()) || resized) this.phosphor.frame(this.takenAt, this.taken, this.takenAt);
    if (this.view === 'tube') return;
    if (!i) this.roadster.render();
    else if (i.phase === 'show' && i.shown) this.roadster.render();
    else if (this.roadster.landShown !== undefined && !this.warm && this.state && this.state.t > 2e6) {
      // Once, behind the tube, so the scene's shaders are ready for it.
      this.warm = true;
      this.roadster.render();
    }
  }

  /** The real one going round its orbit, in About. */
  orbit(now) {
    const car = $('car'), earth = $('earth'), mars = $('mars');
    if (!car) return;
    const s = now / 1000 - 2;
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

  /** The opening's state: what has to be ready, and when. */
  introBegin(phase, full) {
    this.intro = { phase, full, clock: 0, shown: false };
    const el = $('intro');
    el.classList.remove('hidden', 'wait');
    el.classList.toggle('tube', phase === 'tube');
    $('intro-go').classList.remove('on');
    $('intro-sub').style.opacity = '0';
    if (!this.title) this.title = new Title($('title'));
    this.title.clear();
    $('hud').classList.add('away');
    sceneCanvas.style.opacity = '0';
    if (phase === 'tube') {
      tube.classList.remove('hidden', 'off');
      $('hint').classList.add('hidden');
      $('intro-go').querySelector('.key').textContent = this.replay ? 'Press any key to watch the replay' : 'Press any key to fly';
      $('intro-go').querySelector('.touch').textContent = this.replay ? 'Tap to watch the replay' : 'Tap to fly';
    }
  }

  /**
   * A key or a tap in the opening. On the tube: on to 2026 at once. Over
   * the title: the flight. While the camera draws back: straight in.
   */
  introKey() {
    const i = this.intro;
    if (!i) return false;
    this.wake();
    if (i.phase === 'tube') this.introOn();
    else if (i.full && i.goAt === undefined) {
      i.goAt = i.clock;
      $('intro').classList.remove('wait');
      $('intro-go').classList.remove('on');
      this.sound.swell(PULL + 1.5);
    } else if (i.full) i.skip = true;
    return true;
  }

  /** From the tube to 2026: the tube switches off, the title is struck. */
  introOn() {
    const i = this.intro;
    i.phase = 'show';
    i.clock = 0;
    $('intro').classList.remove('tube');
    this.sound.powerOff();
    if (calm() || this.view === 'tube') this.tubeAway();
    else {
      tube.classList.add('off');
      setTimeout(() => this.tubeAway(), 430);
    }
  }

  /** The tube goes, unless it is the view. */
  tubeAway() {
    tube.classList.remove('off');
    if (this.view !== 'tube') tube.classList.add('hidden');
    else $('hint').classList.remove('hidden');
  }

  /** Whether the opening is holding the machine where it is. */
  introHolds() {
    const i = this.intro, s = this.state;
    if (!i || !s) return false;
    return i.phase === 'tube' ? s.t >= GREET_HOLD : s.t >= GAME_START;
  }

  /**
   * The opening, each frame. First the program's greeting on the tube, a
   * few seconds of it. Then, the first time: the title struck in green
   * dots on the dark, the scene coming up behind it as the dots turn
   * white, and the car drifting against the Earth for as long as nobody
   * presses anything; then the long draw back into the flight's own view.
   * Later games: the title briefly, and the flight.
   */
  introStep(now) {
    const i = this.intro, s = this.state;
    // Its own clock, by the frame, so a slow frame slows it down rather
    // than jumping it on: a lost moment of it is a moment nobody saw.
    const dt = Math.min(Math.max(0, (now - (i.last ?? now)) / 1000), this.introCap ?? 0.1);
    i.last = now;
    i.clock += dt;
    const tau = i.clock;
    if (i.phase === 'tube') {
      if (tau >= TUBE_SECONDS) this.introOn();
      return;
    }
    const scene = this.view !== 'tube';
    const rr = this.roadster;
    const ready = s && s.t >= GAME_START && (!scene || (rr.landShown !== undefined && rr.earth && rr.earth.visible));
    if (ready && i.readyAt === undefined) i.readyAt = tau;
    if (!scene) {
      if (ready) this.introEnd();
      return;
    }
    const full = i.full && !i.skip;
    const box = this.title.layout(0.72);
    const sub = $('intro-sub'), go = $('intro-go');
    sub.style.top = `${box.top + box.height + box.pitch * 2.2}px`;
    sub.textContent = this.demo ? this.demo.name : 'Roadster edition';
    const sweep = calm() ? 0 : full ? 1.25 : 0.45;
    const t0 = full ? 0.45 : 0;
    // The scene, once there is a scene to show, and not before the title.
    if (i.readyAt !== undefined && i.sceneAt === undefined && tau >= (full ? 1.5 : 0.45)) i.sceneAt = tau;
    i.shown = i.sceneAt !== undefined;
    let k = 0, fade = 0, hero = 0, pullAt = Infinity;
    if (i.shown) {
      hero = tau - i.sceneAt;
      fade = smooth(hero / (full ? 1.2 : 0.45));
      if (full && i.goAt !== undefined) {
        // The draw back, once the key has come and the scene is up.
        pullAt = Math.max(i.goAt, i.sceneAt + 0.8);
        k = calm() ? (tau >= pullAt + 0.4 ? 1 : 0) : Math.min(1, Math.max(0, (tau - pullAt) / PULL));
      }
    }
    sceneCanvas.style.opacity = String(fade);
    rr.opening = full && i.shown ? { t: hero, k } : null;
    // Waiting for the key, once the title is struck and the scene is up.
    if (full && i.goAt === undefined && i.shown && hero > 1.4 && !go.classList.contains('on')) {
      go.style.top = `${box.top + box.height + box.pitch * 2.2 + 46}px`;
      go.classList.add('on');
      $('intro').classList.add('wait');
    }
    // The title: struck, whitening with the scene, gone as the camera
    // draws back (or, later games, after a moment).
    const out = full ? pullAt : (i.sceneAt ?? Infinity) + 0.5;
    const alpha = 1 - smooth((tau - out) / (full ? 0.6 : 0.8));
    this.title.draw(tau - t0, { sweep, white: fade, alpha });
    sub.style.opacity = String(Math.min(alpha, smooth((tau - t0 - sweep - 0.1) / 0.6)));
    if (k > 0.7 || (!full && i.shown && hero > 0.5)) $('hud').classList.remove('away');
    const done = full ? k >= 1 : i.shown && hero >= 1.0;
    if (done || (i.skip && ready)) this.introEnd();
  }

  /** The opening is over and the game is on; the first time, the
   * controller reads the brief over the radio. */
  introEnd() {
    this.intro = null;
    this.roadster.opening = null;
    this.roadster.openingCentre = null;
    this.roadster.first = true;
    sceneCanvas.style.opacity = '1';
    this.title.clear();
    $('intro').classList.add('hidden');
    $('intro').classList.remove('wait');
    $('intro-sub').style.opacity = '0';
    $('intro-go').classList.remove('on');
    $('hud').classList.remove('away');
    if (!this.briefed && !this.replay) {
      this.briefed = true;
      this.radio.say('BRIEF');
    }
    this.radio.preload(Object.keys(MESSAGES_2026).concat(['AIRLOW']));
  }

  fitTube() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const onPage = this.view === 'tube' || !tube.classList.contains('hidden');
    const w = onPage ? Math.round(tube.clientWidth * dpr) : 512, h = onPage ? Math.round(tube.clientHeight * dpr) : 384;
    if (tube.width !== w || tube.height !== h) {
      tube.width = w;
      tube.height = h;
      return true;
    }
    return false;
  }

  sounds() {
    const s = this.state, p = this.prev;
    if (!s) return;
    const exploded = this.roadster.exploded;
    this.sound.update(exploded ? 0 : this.roadster.thrustNow, s, 0);
    const alt = (this.alt = this.altitude(s));
    // The car's own blows and the burst, when the 2026 view has them; the
    // program's explosion when it is far out and the view has none.
    for (const e of this.roadster.takeEvents()) {
      if (e.kind === 'burst' && this.view !== 'tube') this.sound.explosion(e.hard);
      else if (e.kind === 'blow') this.sound.contact(Math.min(40, e.speed * 2));
    }
    if (p) {
      if (s.radius > 0 && p.radius === 0 && (this.view === 'tube' || !this.roadster.crash)) this.sound.explosion();
      else if (alt <= 0 && this.altPrev > 0 && s.verdis < 450 && !exploded && !this.roadster.topple) this.sound.contact(p.vervel / 10);
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
    // A tipped car's reason is drawn where the flame was, after the verdict.
    const fm = messageName(this.engine.symbols, s.flame);
    const tilt = TILTS.includes(fm) ? fm : null;
    this.follow(s, m, tilt);
    if (m !== this.lastMessage || tilt !== this.lastTilt) {
      const fresh = m !== this.lastMessage;
      this.lastMessage = m;
      this.lastTilt = tilt;
      $('message').textContent = [m && MESSAGES_2026[m], tilt && MESSAGES_2026[tilt]].filter(Boolean).join(' ');
      if (!this.intro) {
        // How it ended cuts short whatever warning was still being read.
        if (m && fresh) this.radio.say(m, { urgent: Object.keys(WRECKS).includes(m) || LANDINGS.includes(m) });
        if (tilt) this.radio.say(tilt);
      }
    }
    if (s.fuel_low && !this.airLowSaid) {
      this.airLowSaid = true;
      if (!this.intro) this.radio.say('AIRLOW');
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
   * when the program starts again high up), how it came down, and how it
   * ended. A little after the ending, when the program has shown it, the
   * card; if the program is quicker than that, the card comes anyway.
   */
  follow(s, m, tilt) {
    if (s.t < GAME_START) return;
    const fresh = !this.flight || s.verdis - this.flight.verdis > 15000;
    if (fresh) {
      const was = this.flight;
      if (was && was.kind && !was.shown) this.ending(was);
      this.flight = { t: s.t, verdis: s.verdis, td: null, kind: null, shown: false };
      this.skipping = false;
    }
    const f = this.flight;
    f.verdis = s.verdis;
    if (this.skipping && s.t - (this.skipFrom ?? s.t) > 20e6) this.skipping = false;
    const now = () => ({ t: s.t, vv: s.vervel / 10, hv: s.horvel / 10, angle: s.angle, air: Math.max(0, s.fuel / 10), hordis: s.hordis, indexl: s.indexl });
    if (s.fuel <= 0 && f.airOutAt === undefined) f.airOutAt = Math.max(0, this.alt ?? s.radary);
    if (!f.td && LANDINGS.includes(m) && s.verdis < 450) f.td = { ...now(), msg: m };
    if (f.kind) {
      // The card waits for the controller to finish talking, and a breath
      // after; not for ever, should the sound be stuck.
      if (!f.shown && s.t >= f.at.t + ENDINGS[f.kind].after * 1e6) {
        f.due ??= performance.now();
        if (this.radio.idle(600) || performance.now() - f.due > 8000) this.ending(f);
      }
      return;
    }
    const end = (kind, extra = {}) => {
      f.kind = kind;
      f.at = { ...now(), ...extra };
    };
    if (m === 'ORDER') f.ordered = true;
    if (['LFTMSG', 'RGTMSG', 'TOPMSG'].includes(m)) f.offEdge = m;
    if (f.ordered && s.shipdp === 0) end('diner'); // the car has climbed away
    else if (m === 'MANMSG') {
      end('flag');
      const diner = this.roadster.dinerX;
      f.dinerGone = !(s.diner & 1) || diner == null;
      f.toDiner = diner == null ? 0 : Math.round(Math.abs((f.td ? f.td.hordis : s.hordis) - diner));
    } else if (tilt) {
      const ter = this.roadster.terrain;
      end('tipped', { step: ter ? Math.abs((ter[s.indexl + 1] ?? 0) - (ter[s.indexl] ?? 0)) : 0 });
      f.tilt = tilt;
    } else if (WRECKS[m]) end(WRECKS[m]);
  }

  /** The end of a flight: how it went, what this Moon has seen, what next. */
  ending(f) {
    f.shown = true;
    const d = this.demo;
    if (d && d.step < d.plans.length - 1) {
      // A demo in two parts: on to the next flight, card unseen.
      d.step++;
      this.input('pilot', this.demoPlan(d, f));
      this.skipping = true;
      this.skipFrom = this.state?.t;
      return;
    }
    const e = ENDINGS[f.kind];
    if (!f.td) f.td = { ...f.at, msg: null };
    const t = this.tally;
    if (f.kind === 'diner') t.lunch++;
    else if (f.kind === 'flag') t.flag++;
    else if (f.kind === 'tipped') t.tipped++;
    else t.crash++;
    if (f.kind === 'dinerdead') t.diner = true;
    const card = $('ending');
    card.dataset.kind = f.kind;
    $('ending-title').textContent = e.title(f);
    const line = { diner: 'ORDER', flag: 'MANMSG' }[f.kind];
    $('ending-line').textContent = line ? MESSAGES_2026[line] : f.kind === 'tipped' ? [f.td.msg && MESSAGES_2026[f.td.msg], MESSAGES_2026[f.tilt]].filter(Boolean).join(' ') : MESSAGES_2026[Object.keys(WRECKS).find((k) => WRECKS[k] === f.kind)];
    $('ending-quip').textContent = e.quip(f);
    const box = $('ending-stats');
    box.textContent = '';
    for (const st of e.stats(f)) {
      if (!st) continue;
      const [label, value, unit, note, warn] = st;
      const r = document.createElement('div');
      r.className = 'readout' + (warn ? ' warn' : '');
      r.innerHTML = '<div class="label"></div><div class="value"><span></span><span class="unit"></span></div><div class="note"></div>';
      r.querySelector('.label').textContent = label;
      r.querySelector('.value span').textContent = value;
      r.querySelector('.unit').textContent = unit;
      r.querySelector('.note').textContent = note || '';
      box.appendChild(r);
    }
    $('ending-tally').textContent = tallyLine(t);
    $('end-share').textContent = 'Copy replay link';
    // In a demo the card offers the demo again, another, or the controls.
    card.classList.toggle('demo', !!d);
    $('end-again').textContent = d ? 'Run it again' : 'Play again';
    $('end-new').textContent = d ? 'Fly yourself' : 'New Moon';
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
    for (const other of ['guide', 'about', 'demo']) if (other !== id) this.hide(other, false);
    if (!this.overlay()) this.returnFocus = document.activeElement;
    el.classList.remove('hidden');
    el.scrollTop = 0;
    this.hold(id, true);
    (el.querySelector(id === 'demo' ? '#demo-list button' : '.primary, .close') || el).focus({ preventScroll: true });
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
      if (top === 'ending') this.playAgain();
      else this.hide(top);
      ev.preventDefault();
      return;
    }
    if (top === 'demo') {
      const items = [...document.querySelectorAll('#demo-list button')];
      const i = items.indexOf(document.activeElement);
      if (ev.code === 'ArrowDown' || ev.code === 'ArrowUp') {
        items[(i + (ev.code === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
        ev.preventDefault();
      } else if (/^Digit[1-9]$/.test(ev.code) && items[Number(ev.code.slice(-1)) - 1]) {
        this.startDemo(Number(ev.code.slice(-1)) - 1);
        ev.preventDefault();
      } else if (ev.code === 'KeyD' && !ev.repeat) this.hide('demo');
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
      else if (ev.code === 'KeyN' || ev.code === 'KeyR') this.newMoon();
      else if (ev.code === 'KeyD') this.show('demo');
      else if (ev.code === 'KeyH' || ev.key === '?') this.show('guide');
      else if (ev.code === 'KeyM') this.mute(!this.muted);
    }
  }

  /** From the end card: the next descent on this Moon, which keeps its
   * flags, wrecks and craters, straight away (the program's own wait is run
   * through at speed). */
  playAgain() {
    if (this.demo) return this.startDemo(this.demo.index);
    this.hide('ending', false);
    this.skipping = true;
    this.skipFrom = this.state?.t;
  }

  /** From the end card: a clean Moon, the program loaded afresh. */
  newMoon() {
    this.hide('ending', false);
    if (this.demo) this.stopDemo();
    this.restart();
  }

  /** A demo flight: a fresh Moon, the autopilot on the demo's plan. */
  startDemo(index) {
    this.hide('demo', false);
    this.hide('ending', false);
    this.demo = { ...DEMOS[index], index, step: 0 };
    this.wake();
    this.restart();
  }

  /** The demo flight is the person's again. */
  stopDemo() {
    if (!this.demo) return;
    this.demo = null;
    this.input('pilot', -1);
    $('coach').classList.remove('demo');
    $('coach').style.opacity = '0';
  }

  /** The engine's plan for this step of a demo. */
  demoPlan(d, last = null) {
    const p = d.plans[d.step];
    if (p === 'here') return 1000 + (last?.td?.indexl ?? last?.at?.indexl ?? 0);
    return p;
  }

  /** How fast a demo runs: briskly down from the heights, near real time
   * for the landing, a little quicker for the walk and the lunch, and real
   * time once it has gone wrong, so the crash or the tip and what the
   * controller says about it play out as they would. */
  demoPace() {
    const s = this.state;
    if (!s || s.verdis > 450) return 16;
    const f = this.flight;
    if (f && f.kind && f.kind !== 'diner' && f.kind !== 'flag') return 1;
    return f && (f.td || f.kind) ? 3 : 2;
  }

  /** Sound off or on, remembered in this browser. */
  mute(on) {
    this.muted = on;
    this.sound.mute(on);
    const b = $('sound-toggle');
    b.textContent = on ? 'Unmute' : 'Mute';
    b.setAttribute('aria-label', on ? 'Turn sound on' : 'Turn sound off');
    try {
      localStorage.setItem('moonlander.muted', on ? '1' : '0');
    } catch (e) {
      /* remembered for this visit only */
    }
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
      this.tally = { lunch: 0, flag: 0, tipped: 0, crash: 0, diner: false };
      this.skipping = false;
      this.altWas = undefined;
      this.altPrev = undefined;
      this.phosphor.clear();
      this.phosphor.now = 0;
      this.roadster.forgetWrecks();
      this.roadster.reset();
      // The first time, the tube and its greeting; after that, the title.
      const first = !this.opened;
      this.opened = true;
      this.warm = false;
      this.introBegin(first ? 'tube' : 'show', first && this.view !== 'tube');
      if (this.demo) {
        this.demo.step = 0;
        const plan = this.demoPlan(this.demo);
        this.pending.push(['pilot', plan]);
        const c = $('coach');
        c.textContent = `Demo: ${this.demo.name.toLowerCase()}. Esc to take over.`;
        c.classList.add('demo');
        c.style.opacity = '1';
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
    $('about-toggle').addEventListener('click', () => this.show('about'));
    $('about-close').addEventListener('click', () => this.hide('about'));
    $('guide-toggle').addEventListener('click', () => this.show('guide'));
    $('guide-close').addEventListener('click', () => this.hide('guide'));
    $('end-again').addEventListener('click', () => this.playAgain());
    $('end-demo').addEventListener('click', () => this.show('demo'));
    $('demo-close').addEventListener('click', () => this.hide('demo'));
    const list = $('demo-list');
    DEMOS.forEach((d, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.innerHTML = '<span class="k"></span><span class="n"></span><span class="w"></span>';
      b.querySelector('.k').textContent = i < 9 ? String(i + 1) : '';
      b.querySelector('.n').textContent = d.name;
      b.querySelector('.w').textContent = d.what;
      b.addEventListener('click', () => this.startDemo(i));
      li.appendChild(b);
      list.appendChild(li);
    });
    $('end-new').addEventListener('click', () => this.newMoon());
    $('sound-toggle').addEventListener('click', () => this.mute(!this.muted));
    this.mute(this.muted);
    $('end-share').addEventListener('click', (ev) => this.copyReplay(ev.currentTarget));
    $('end-guide').addEventListener('click', () => this.show('guide'));
    // A click on a sheet's backdrop, outside its text, closes it.
    for (const id of ['guide', 'about', 'demo']) $(id).addEventListener('click', (ev) => {
      if (ev.target === ev.currentTarget) this.hide(id);
    });
    $('intro').addEventListener('click', () => this.introKey());

    this.held = new Set();
    window.addEventListener('keydown', (ev) => {
      const top = this.overlay();
      if (top) {
        this.overlayKey(top, ev);
        return;
      }
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.repeat && !['ArrowUp', 'ArrowDown'].includes(ev.code)) return;
      // In the opening a key moves it on, and does nothing else; the sound
      // switch and the guide work as ever.
      const i = this.intro;
      if (i && (i.phase === 'tube' || i.full) && !['KeyM', 'KeyH'].includes(ev.code) && ev.key !== '?' && !/^(Shift|Control|Alt|Meta)$/.test(ev.key)) {
        this.introKey();
        ev.preventDefault();
        return;
      }
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
          if (this.demo) this.stopDemo();
          else this.input('pilot', this.engine.getInput('pilot') === 0 ? -1 : 0);
          break;
        case 'KeyD':
          this.show('demo');
          break;
        case 'Escape':
          if (!this.demo) return;
          this.stopDemo();
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
        case 'KeyM':
          this.mute(!this.muted);
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
