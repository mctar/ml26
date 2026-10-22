// What the Roadster sounds like, from inside: the gas, the ground, the
// chimes. There is no air outside, so everything here is what the driver
// would hear through the car.

export class Sound {
  constructor() {
    this.ac = null;
    this.thrust = 0;
    this.lowAir = false;
    this.bells = 0;
  }

  /** Everything silent (the radio too), or not; the sounds still run. */
  mute(on) {
    this.muted = on;
    if (!this.master) return;
    const t = this.ac.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(on ? 0 : 0.8, t, 0.04);
  }

  /** Hold every sound, the radio's too, where it is; or let it go on. */
  pause(on) {
    this.paused = on;
    if (!this.ac) return;
    // Faded rather than cut: down over a few tenths, then stopped; back up
    // the same way.
    clearTimeout(this.pauseTimer);
    const g = this.master.gain, t = this.ac.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    if (on) {
      g.setTargetAtTime(0, t, 0.07);
      this.pauseTimer = setTimeout(() => {
        if (this.paused && this.ac.state === 'running') this.ac.suspend();
      }, 450);
    } else {
      if (this.ac.state === 'suspended') this.ac.resume();
      g.setTargetAtTime(this.muted ? 0 : 0.8, t, 0.07);
    }
  }

  /** Start the audio context. Browsers allow this only from a gesture. */
  wake() {
    if (this.ac) {
      if (this.ac.state === 'suspended' && !this.paused) this.ac.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ac = (this.ac = new AC());
    this.master = ac.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    this.master.connect(ac.destination);

    // White noise, two seconds, looped: the raw material.
    const n = ac.sampleRate * 2;
    const buf = ac.createBuffer(1, n, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;

    // The thrusters: noise through a band, gain by thrust.
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 0.6;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4000;
    this.hiss = ac.createGain();
    this.hiss.gain.value = 0;
    src.connect(bp).connect(lp).connect(this.hiss).connect(this.master);
    src.start();
  }

  /** While the radio talks, the thrusters come down. */
  duck(on) {
    this.ducked = on;
  }

  /** Each frame: the thrust fraction 0..1, and the state for one-shots. */
  update(thrustFrac, state, dt) {
    if (!this.ac) return;
    const t = this.ac.currentTime;
    // The gas: level with thrust, a little body at the bottom.
    const target = (thrustFrac > 0 ? 0.04 + 0.22 * Math.sqrt(thrustFrac) : 0) * (this.ducked ? 0.45 : 1);
    this.hiss.gain.setTargetAtTime(target, t, 0.08);
    if (state.fuel_low && !this.lowAir) this.chime();
    this.lowAir = !!state.fuel_low;
    if (state.bells > this.bells) {
      for (let i = this.bells; i < state.bells && i < this.bells + 3; i++) this.bell();
      this.bells = state.bells;
    }
  }

  burst(duration, gain, freq, q, to = this.master) {
    const ac = this.ac;
    const src = ac.createBufferSource();
    src.buffer = this.noise;
    const f = ac.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ac.createGain();
    g.gain.setValueAtTime(gain, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0005, ac.currentTime + duration);
    src.connect(f).connect(g).connect(to);
    src.start();
    src.stop(ac.currentTime + duration + 0.05);
  }

  /** A corner thruster firing. */
  puff() {
    if (!this.ac) return;
    this.burst(0.12, 0.15, 2400, 1.2);
  }

  /**
   * A blow, as it reaches the driver: through the tyres, the frame and
   * the seat, there being no air to bring it. The whole car moving, a low
   * thump; the body panels ringing a little, none in tune with another;
   * the grit of the ground giving under it. Harder with speed, and never
   * twice quite the same. `far`: felt through the ground, not the car
   * (a piece of it coming down somewhere else), and softer.
   */
  thud(speed, far = false) {
    if (!this.ac) return;
    const ac = this.ac, t = ac.currentTime;
    // A rattle of small blows is heard as one.
    if (this.lastThud !== undefined && t - this.lastThud < (far ? 0.09 : 0.05)) return;
    this.lastThud = t;
    const k = Math.min(1, Math.abs(speed) / 30);
    const v = 0.9 + Math.random() * 0.2;
    const level = far ? 0.35 : 1;
    const out = ac.createBiquadFilter();
    out.type = 'lowpass';
    out.frequency.value = far ? 500 : 1800;
    out.connect(this.master);
    const o = ac.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime((70 + 35 * k) * v, t);
    o.frequency.exponentialRampToValueAtTime(27, t + 0.22 + 0.25 * k);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime((0.3 + 0.55 * k) * level, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.3 + 0.4 * k);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.75 + 0.4 * k);
    if (!far) {
      for (const [f, a, d] of [[163, 1, 0.24], [347, 0.6, 0.17], [611, 0.4, 0.12], [1013, 0.22, 0.08]]) {
        const p = ac.createOscillator();
        p.type = 'sine';
        p.frequency.value = f * v * (0.97 + Math.random() * 0.06);
        const pg = ac.createGain();
        pg.gain.setValueAtTime(0.0001, t);
        pg.gain.exponentialRampToValueAtTime(0.0001 + a * 0.05 * (0.3 + k), t + 0.004);
        pg.gain.exponentialRampToValueAtTime(0.00005, t + d * (0.7 + k));
        p.connect(pg).connect(out);
        p.start(t);
        p.stop(t + d * (0.7 + k) + 0.05);
      }
    }
    this.burst(0.1 + 0.25 * k, (0.12 + 0.35 * k) * level, 220 * v, 0.7, out);
  }

  /**
   * The car taking a twist it was not built for, as it goes up on two
   * wheels: metal and bolts slipping and catching, a stutter through a
   * narrow band.
   */
  creak(k = 1, seconds = 1.1) {
    if (!this.ac) return;
    const ac = this.ac, t = ac.currentTime;
    const o = ac.createOscillator();
    o.type = 'sawtooth';
    const base = 16 + 8 * Math.random();
    o.frequency.setValueAtTime(base, t);
    o.frequency.linearRampToValueAtTime(base * 1.9, t + seconds * 0.55);
    o.frequency.linearRampToValueAtTime(base * 1.2, t + seconds);
    // The stutter: the rate itself wavering.
    const lfo = ac.createOscillator();
    lfo.frequency.value = 6 + 3 * Math.random();
    const depth = ac.createGain();
    depth.gain.value = base * 0.45;
    lfo.connect(depth).connect(o.frequency);
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 780 + 300 * Math.random();
    bp.Q.value = 7;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.45 * k, t + seconds * 0.3);
    g.gain.setValueAtTime(0.45 * k, t + seconds * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    o.connect(bp).connect(g).connect(this.master);
    o.start(t);
    lfo.start(t);
    o.stop(t + seconds + 0.05);
    lfo.stop(t + seconds + 0.05);
  }

  /** The end of the car; or, shown again slowly (`slow`), the same an
   * octave down and drawn out, and softer. */
  explosion(hard = true, slow = false) {
    if (!this.ac) return;
    const s = slow ? 2 : 1, g = slow ? 0.6 : 1;
    this.burst((hard ? 1.6 : 1.1) * s, (hard ? 0.9 : 0.75) * g, 180 / s, 0.5);
    this.burst(0.5 * s, 0.6 * g, 1200 / s, 0.7);
    if (slow) {
      // The thump, slowed: lower, longer.
      const ac = this.ac, t = ac.currentTime;
      const o = ac.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(52, t);
      o.frequency.exponentialRampToValueAtTime(18, t + 1.1);
      const gg = ac.createGain();
      gg.gain.setValueAtTime(0.0001, t);
      gg.gain.exponentialRampToValueAtTime(0.6, t + 0.02);
      gg.gain.exponentialRampToValueAtTime(0.0005, t + 1.3);
      o.connect(gg).connect(this.master);
      o.start(t);
      o.stop(t + 1.4);
    } else this.thud(60);
  }

  /** Air low: two soft notes, as a car would. */
  chime() {
    if (!this.ac) return;
    const ac = this.ac;
    for (const [i, f] of [[0, 880], [0.18, 660]]) {
      const o = ac.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, ac.currentTime + i);
      g.gain.exponentialRampToValueAtTime(0.18, ac.currentTime + i + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0005, ac.currentTime + i + 0.5);
      o.connect(g).connect(this.master);
      o.start(ac.currentTime + i);
      o.stop(ac.currentTime + i + 0.55);
    }
  }

  /** The tube switched off: the thump of the high voltage going, a tick,
   * and a whine falling away as the picture collapses. */
  powerOff() {
    if (!this.ac) return;
    const ac = this.ac, t = ac.currentTime;
    const o = ac.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(95, t);
    o.frequency.exponentialRampToValueAtTime(30, t + 0.35);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.4, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.42);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.45);
    this.burst(0.05, 0.22, 3200, 0.9);
    const w = ac.createOscillator();
    w.type = 'sine';
    w.frequency.setValueAtTime(5800, t);
    w.frequency.exponentialRampToValueAtTime(700, t + 0.38);
    const gw = ac.createGain();
    gw.gain.setValueAtTime(0.014, t);
    gw.gain.exponentialRampToValueAtTime(0.0002, t + 0.4);
    w.connect(gw).connect(this.master);
    w.start(t);
    w.stop(t + 0.42);
  }

  /** Under the opening shot: a low, slow swell, gone by the flight. */
  swell(seconds = 6) {
    if (!this.ac) return;
    const ac = this.ac, t = ac.currentTime;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07, t + seconds * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    g.connect(lp).connect(this.master);
    for (const [f, d] of [[55, 0], [82.4, 0.4], [110.6, -0.3]]) {
      const o = ac.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      o.detune.value = d * 10;
      o.connect(g);
      o.start(t);
      o.stop(t + seconds + 0.1);
    }
  }

  /** The GT40's bell, kept: the LK40's beeper. */
  bell() {
    if (!this.ac) return;
    const ac = this.ac;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'square';
    o.frequency.value = 1000;
    g.gain.setValueAtTime(0.04, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0005, ac.currentTime + 0.12);
    o.connect(g).connect(this.master);
    o.start();
    o.stop(ac.currentTime + 0.13);
  }
}
