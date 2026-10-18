// The engine's host side: loads the WebAssembly, drives it through the
// Asyncify unwind/rewind dance, and hands the page the picture and the
// state once a frame. Works in a browser and in Node (for tests).
//
// The machine calls `tend` at least once per millisecond of machine time.
// Most calls return at once. When the machine has run far enough ahead of
// the wall clock, `tend` unwinds the WebAssembly stack and `run` sleeps
// until the frame is due, then rewinds it and the machine goes on exactly
// where it was.

const STATE_WORDS = {
  // Offsets in 32-bit words into the State struct. t and ticks are f64.
  t: 0, ticks: 2,
  angle: 4, turn: 5, horvel: 6, vervel: 7, hordis: 8, verdis: 9, horacc: 10, veracc: 11, accel: 12,
  percnt: 13, thrust: 14, fuel: 15, weight: 16, time: 17, bigxct: 18, radary: 19, avery: 20, avert: 21,
  leftd: 22, lefeet: 23, indexl: 24, dnum: 25, sysmes: 26, radius: 27, manx: 28, many: 29, flagx: 30,
  flagy: 31, hitcnt: 32, lpflg1: 33, fuel_low: 34, shipdp: 35, flame: 36, dust: 37, diner: 38, bells: 39, pen_on: 40, pen_x: 41, pen_y: 42,
};
const STATE_SIZE = 176; // 43 words, padded to the f64 alignment
const INPUT_WORDS = { pen_x: 0, pen_y: 1, pen_down: 2, throttle: 3, turning: 4, choice: 5, slot: 6, pilot: 7, stop: 8 };
const INPUT_SIZE = 9 * 4;
const BEAM_WORDS = 8;

const ASYNCIFY_STACK = 256 * 1024;

export class Engine {
  /**
   * @param {WebAssembly.Module} module the instrumented engine
   * @param {object} host callbacks: frame(beams: Float32Array, state) -> {yield: bool, stop: bool}, sleep() -> Promise, log(text)
   */
  constructor(module, host) {
    this.module = module;
    this.host = host;
    this.asyncState = 0; // 0 normal, 1 unwinding, 2 rewinding
    this.result = 0;
    this.symbols = null;
    this.state = {};
    this.game = 0;
    this.stopped = false;
    this.pending = null;
  }

  async init() {
    const imports = {
      env: {
        ml_log: (ptr, len) => {
          const s = new TextDecoder().decode(new Uint8Array(this.memory.buffer, ptr, len));
          (this.host.log || console.log)(s);
        },
        tend: (t, beams, n, statePtr, inputPtr) => this.tend(t, beams, n, statePtr, inputPtr),
      },
    };
    this.instance = await WebAssembly.instantiate(this.module, imports);
    this.exports = this.instance.exports;
    this.memory = this.exports.memory;
    // Asyncify's save area: [start, end] then the bytes.
    this.data = this.exports.ml_alloc(8 + ASYNCIFY_STACK);
    const d = new Int32Array(this.memory.buffer, this.data, 2);
    d[0] = this.data + 8;
    d[1] = this.data + 8 + ASYNCIFY_STACK;
    // The addresses the host needs.
    const cap = 4096;
    const buf = this.exports.ml_alloc(cap);
    const n = this.exports.ml_symbols(buf, cap);
    const text = new TextDecoder().decode(new Uint8Array(this.memory.buffer, buf, Math.min(n, cap)));
    this.exports.ml_free(buf, cap);
    this.symbols = {};
    for (const line of text.split('\n')) {
      const [k, v] = line.split('=');
      if (k) this.symbols[k] = Number(v);
    }
    if (this.symbols.STATE_SIZE !== STATE_SIZE || this.symbols.INPUT_SIZE !== INPUT_SIZE) {
      throw new Error(`engine.js is out of step with the engine: state ${this.symbols.STATE_SIZE}/${STATE_SIZE}, input ${this.symbols.INPUT_SIZE}/${INPUT_SIZE}`);
    }
    return this;
  }

  /** The import. Returns the bit set the engine expects. */
  tend(t, beamsPtr, n, statePtr, inputPtr) {
    if (this.asyncState === 2) {
      // Back from the pause: the frame is over, carry on.
      this.asyncState = 0;
      this.exports.asyncify_stop_rewind();
      return this.result;
    }
    this.statePtr = statePtr;
    this.inputPtr = inputPtr;
    this.readState(statePtr);
    const beams = new Float32Array(this.memory.buffer, beamsPtr, n * BEAM_WORDS);
    const r = this.host.frame(t, beams, this.state, this);
    let bits = 0;
    if (r.stop) bits |= 1;
    if (r.take) bits |= 2;
    if (!r.yield) return bits;
    // Pause here until the host says the frame is due.
    this.result = bits;
    this.asyncState = 1;
    this.exports.asyncify_start_unwind(this.data);
    return 0;
  }

  readState(ptr) {
    const f = new Float64Array(this.memory.buffer, ptr, 2);
    const w = new Int32Array(this.memory.buffer, ptr, STATE_SIZE / 4);
    const fl = new Float32Array(this.memory.buffer, ptr, STATE_SIZE / 4);
    const s = this.state;
    s.t = f[0];
    s.ticks = f[1];
    for (const k in STATE_WORDS) {
      if (k === 't' || k === 'ticks') continue;
      s[k] = (k === 'pen_x' || k === 'pen_y') ? fl[STATE_WORDS[k]] : w[STATE_WORDS[k]];
    }
    return s;
  }

  /** Write a field of the Input struct. Safe between frames. */
  setInput(field, value) {
    if (!this.inputPtr) return;
    const i = INPUT_WORDS[field];
    if (i === undefined) throw new Error(`no input ${field}`);
    if (field === 'pen_x' || field === 'pen_y') {
      new Float32Array(this.memory.buffer, this.inputPtr, INPUT_SIZE / 4)[i] = value;
    } else {
      new Int32Array(this.memory.buffer, this.inputPtr, INPUT_SIZE / 4)[i] = value | 0;
    }
  }

  getInput(field) {
    if (!this.inputPtr) return 0;
    const i = INPUT_WORDS[field];
    if (field === 'pen_x' || field === 'pen_y') return new Float32Array(this.memory.buffer, this.inputPtr, INPUT_SIZE / 4)[i];
    return new Int32Array(this.memory.buffer, this.inputPtr, INPUT_SIZE / 4)[i];
  }

  /** A word of the original's memory. */
  peek(addr) {
    return this.exports.ml_peek(this.game, addr);
  }

  /** Load the program and run it until the host stops it. */
  async run() {
    this.game = this.exports.ml_new();
    this.stopped = false;
    let code = this.exports.ml_run(this.game);
    while (this.asyncState === 1) {
      this.asyncState = 0;
      this.exports.asyncify_stop_unwind();
      await this.host.sleep();
      this.asyncState = 2;
      this.exports.asyncify_start_rewind(this.data);
      code = this.exports.ml_run(this.game);
    }
    this.stopped = true;
    this.exports.ml_destroy(this.game);
    this.game = 0;
    return code;
  }
}

export const MESSAGES = {
  N2FAST: 'TAKE IT NICE AND EASY. A PERFECT LANDING IS UNDER 8 FPS',
  GREATM: 'FANTASTIC, A PERFECT LANDING',
  GOODM: 'CONGRATULATIONS ON A GOOD LANDING',
  ROUGHM: 'THE LANDING WAS A LITTLE FAST',
  CRIPM: 'THE LANDING WAS TOO FAST AND DAMAGE WAS DONE TO THE SHIP',
  DEADM: 'WELL, YOU CERTAINLY BLEW THAT ONE. THERE WERE NO SURVIRORS',
  ANGLEM: 'BUT THE ANGLE WAS TOO GREAT AND THE SHIP TIPPED OVER',
  ANGLEJ: 'SORRY, BUT THERE WERE NO SURVIVORS',
  SIDEM: 'BUT THE HORIZONTAL VELOCITY WAS TOO GREAT, AND YOU CRASHED ANYWAY',
  BUMPYM: 'BUT THE TERRAIN IS TOO ROUGH, AND YOU TIPPED OVER',
  ROCKMS: 'YOU JUST CRASHED INTO THAT ROCK',
  OLDMS: 'YOU JUST CRASHED ON TOP OF AN OLD LUNAR MODULE',
  FLAGMS: 'YOU HAVE JUST VAPORIZED A PREVIOUSLY PLANTED AMERICAN FLAG',
  OLDTLT: 'NICE WORK. YOU JUST CRASHED INTO A PREVIOUSLY CRASHED SHIP',
  // The one message in mixed case, over two lines; "MacDonald's" as written.
  MACDED: "Well, you've just destroyed the only MacDonald's on the moon. What a CLOD.",
  ORDER: 'TWO CHEESEBURGERS AND A BIG MAC TO GO.',
  MANMSG: "THAT'S ONE SMALL STEP FOR A MAN, ONE GIANT LEAP FOR MANKIND.",
  LFTMSG: 'BOY, ARE YOU INEPT',
  RGTMSG: 'YOU HAVE JUST CRASHED INTO THE EDGE OF THE MOON',
  TOPMSG: 'SORRY, BUT WHEN YOU LOSE TV COVERAGE, YOU ALSO LOSE YOUR FUEL',
  VFAST: "TOO FAST. YOU'RE GOING TO CRASH",
  FAST: 'BETTER START SLOWING IT UP PRETTY SOON',
};

/** The name of the message at SYSMES, or null. */
export function messageName(symbols, sysmes) {
  if (!sysmes) return null;
  for (const k in MESSAGES) if (symbols[k] === sysmes) return k;
  return null;
}
