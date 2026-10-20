// The voice link: the program's messages read over the radio. The clips
// are made by tools/radio/make.sh (a local text-to-speech model, then a
// narrow band and a compressor); the page adds the squelch and the static
// live, and ducks the thrusters while the controller talks.

export class Radio {
  /** @param {import('./sound.js').Sound} sound */
  constructor(sound) {
    this.sound = sound;
    this.clips = new Map();
    this.loading = new Map();
    this.playing = null;
    this.queue = [];
    this.enabled = true;
    this.endedAt = 0; // performance.now() when the last line finished
  }

  /** Nothing said, nothing waiting, and quiet for at least `ms`. */
  idle(ms = 0) {
    return !this.playing && !this.queue.length && performance.now() - this.endedAt >= ms;
  }

  get ac() {
    return this.sound.ac;
  }

  async load(id) {
    if (this.clips.has(id)) return this.clips.get(id);
    if (!this.loading.has(id)) {
      this.loading.set(id, (async () => {
        try {
          const r = await fetch(new URL(`./radio/${id}.mp3`, import.meta.url));
          if (!r.ok) throw new Error(r.statusText);
          const buf = await this.ac.decodeAudioData(await r.arrayBuffer());
          this.clips.set(id, buf);
          return buf;
        } catch (e) {
          console.warn('no radio clip', id, e.message);
          this.clips.set(id, null);
          return null;
        }
      })());
    }
    return this.loading.get(id);
  }

  /** Fetch everything once sound is allowed, so the first call is prompt. */
  preload(ids) {
    if (!this.ac) return;
    for (const id of ids) this.load(id);
  }

  /** Say this line; a line already queued is replaced by the newer one.
   * The brief is background: anything the program says cuts it short. */
  say(id, { urgent = false } = {}) {
    if (!this.ac || !this.enabled) return;
    if (this.playing) {
      if (urgent || this.playing.id === 'BRIEF') this.stop();
      else {
        this.queue = [id];
        return;
      }
    }
    this.play(id);
  }

  stop() {
    if (this.playing) {
      // Cut off as a radio is, with a click, not mid-syllable.
      const p = this.playing;
      try {
        if (p.gain) {
          const t = this.ac.currentTime;
          p.gain.gain.cancelScheduledValues(t);
          p.gain.gain.setValueAtTime(p.gain.gain.value, t);
          p.gain.gain.linearRampToValueAtTime(0, t + 0.06);
          p.src.onended = null;
          p.src.stop(t + 0.07);
          for (const n of p.after || []) n.stop(t + 0.07);
          this.squelch(t + 0.06, 0.7);
          this.sound.duck(false);
        } else if (p.src) p.src.stop();
      } catch (e) {
        /* already done */
      }
      this.playing = null;
      this.endedAt = performance.now();
    }
    this.queue = [];
  }

  async play(id) {
    const ac = this.ac;
    this.playing = { id, src: null };
    const buf = await this.load(id);
    if (!buf || !this.playing || this.playing.id !== id) {
      if (this.playing && this.playing.id === id) this.playing = null;
      this.next();
      return;
    }
    const t0 = ac.currentTime + 0.02;
    const dur = buf.duration;
    // The voice.
    const src = ac.createBufferSource();
    src.buffer = buf;
    const g = ac.createGain();
    g.gain.value = 0.9;
    src.connect(g).connect(this.sound.master);
    // The static under it, and the squelch at both ends.
    const hiss = this.static(t0 - 0.05, dur + 0.25);
    this.squelch(t0 - 0.06);
    const close = this.squelch(t0 + dur + 0.08, 0.7);
    this.sound.duck(true);
    src.start(t0);
    this.playing.src = src;
    this.playing.gain = g;
    this.playing.after = [hiss, close]; // what is booked for its end
    src.onended = () => {
      if (this.playing && this.playing.src === src) this.playing = null;
      this.endedAt = performance.now();
      this.sound.duck(false);
      this.next();
    };
  }

  next() {
    const id = this.queue.shift();
    if (id) this.play(id);
  }

  squelch(at, level = 1) {
    const ac = this.ac;
    const src = ac.createBufferSource();
    src.buffer = this.sound.noise;
    const f = ac.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 1800;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.22 * level, at + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0005, at + 0.05);
    src.connect(f).connect(g).connect(this.sound.master);
    src.start(at);
    src.stop(at + 0.08);
    return src;
  }

  static(at, dur) {
    const ac = this.ac;
    const src = ac.createBufferSource();
    src.buffer = this.sound.noise;
    src.loop = true;
    const f = ac.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2200;
    f.Q.value = 0.5;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.028, at + 0.03);
    g.gain.setValueAtTime(0.028, at + dur - 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f).connect(g).connect(this.sound.master);
    src.start(at);
    src.stop(at + dur + 0.02);
    return src;
  }
}
