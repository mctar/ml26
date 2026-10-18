// node web/engine/engine.test.mjs
// Runs the engine headless: the autopilot lands, with the host pausing the
// machine every 16 ms of machine time as a browser would every frame.
import { readFileSync } from 'node:fs';
import { Engine, messageName } from './engine.js';

const wasm = readFileSync(new URL('./engine.wasm', import.meta.url));
const module = await WebAssembly.compile(wasm);

const FRAME = 16_667;
let nextYield = FRAME;
let frames = 0, beamsSeen = 0, calls = 0;
let lastMsg = null;
const limit = Number(process.argv[2] || 120) * 1e6;
const t0 = performance.now();

const engine = await new Engine(module, {
  log: (s) => console.log('[engine]', s),
  frame(t, beams, state, eng) {
    calls++;
    if (eng.getInput('pilot') !== 0) eng.setInput('pilot', 0);
    const m = messageName(eng.symbols, state.sysmes);
    if (m !== lastMsg) {
      console.log(`${(t / 1e6).toFixed(2)}s  ${m || '-'}   alt ${state.radary} ft, vv ${state.vervel / 10} fps, fuel ${state.fuel / 10}`);
      lastMsg = m;
    }
    if (t >= limit) return { stop: true, yield: false, take: true };
    if (t < nextYield) return { yield: false };
    nextYield = t + FRAME;
    frames++;
    beamsSeen += beams.length / 8;
    return { yield: true, take: true };
  },
  async sleep() {
    // A browser would await the next animation frame.
    await new Promise((r) => setImmediate(r));
  },
}).init();

const code = await engine.run();
const wall = (performance.now() - t0) / 1000;
console.log(`exit ${code}: ${frames} frames, ${calls} tend calls, ${beamsSeen} beams, ${(limit / 1e6).toFixed(0)}s of machine time in ${wall.toFixed(2)}s (${(limit / 1e6 / wall).toFixed(1)}x)`);
