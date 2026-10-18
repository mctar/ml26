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

  /** Start the audio context. Browsers allow this only from a gesture. */
  wake() {
    if (this.ac) {
      if (this.ac.state === 'suspended') this.ac.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ac = (this.ac = new AC());
    this.master = ac.createGain();
    this.master.gain.value = 0.8;
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

  /** Each frame: the thrust fraction 0..1, and the state for one-shots. */
  update(thrustFrac, state, dt) {
    if (!this.ac) return;
    const t = this.ac.currentTime;
    // The gas: level with thrust, a little body at the bottom.
    const target = thrustFrac > 0 ? 0.04 + 0.22 * Math.sqrt(thrustFrac) : 0;
    this.hiss.gain.setTargetAtTime(target, t, 0.08);
    if (state.fuel_low && !this.lowAir) this.chime();
    this.lowAir = !!state.fuel_low;
    if (state.bells > this.bells) {
      for (let i = this.bells; i < state.bells && i < this.bells + 3; i++) this.bell();
      this.bells = state.bells;
    }
  }

  burst(duration, gain, freq, q) {
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
    src.connect(f).connect(g).connect(this.master);
    src.start();
    src.stop(ac.currentTime + duration + 0.05);
  }

  /** A corner thruster firing. */
  puff() {
    if (!this.ac) return;
    this.burst(0.12, 0.15, 2400, 1.2);
  }

  /** Wheels on the ground, harder with speed. */
  contact(fps) {
    if (!this.ac) return;
    const ac = this.ac;
    const k = Math.min(1, Math.abs(fps) / 40);
    const o = ac.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(70, ac.currentTime);
    o.frequency.exponentialRampToValueAtTime(30, ac.currentTime + 0.3);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.4 + 0.5 * k, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0005, ac.currentTime + 0.35);
    o.connect(g).connect(this.master);
    o.start();
    o.stop(ac.currentTime + 0.4);
    this.burst(0.2 + 0.3 * k, 0.2 + 0.4 * k, 300, 0.8);
  }

  /** The end of the car. */
  explosion() {
    if (!this.ac) return;
    this.burst(1.6, 0.9, 180, 0.5);
    this.burst(0.5, 0.6, 1200, 0.7);
    this.contact(60);
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
