// Record a flight for the lab: run the engine headless with the autopilot
// and save the game state at 30 Hz of machine time, with the terrain and
// feature tables whenever the program changes them.
//
//   node tools/lab/record.mjs <plan> <out.json> [seconds-after-touchdown]
//
// Plans are the autopilot's (see engine/src/lib.rs): 0 land, 1 the diner,
// 2 a flag, 4 hard, 5 tilted, 10 into the diner.
import { readFileSync, writeFileSync } from 'node:fs';
import { Engine } from '../../web/engine/engine.js';

const [plan = '1', out = 'flight.json', after = '75'] = process.argv.slice(2);
const wasm = readFileSync(new URL('../../web/engine/engine.wasm', import.meta.url));
const module = await WebAssembly.compile(wasm);

const FIELDS = ['t', 'ticks', 'angle', 'turn', 'horvel', 'vervel', 'hordis', 'verdis', 'horacc', 'veracc', 'accel', 'percnt', 'thrust', 'fuel', 'weight', 'time', 'bigxct', 'radary', 'avery', 'avert', 'leftd', 'lefeet', 'indexl', 'dnum', 'sysmes', 'radius', 'manx', 'many', 'flagx', 'flagy', 'hitcnt', 'lpflg1', 'fuel_low', 'shipdp', 'flame', 'dust', 'diner', 'bells', 'pen_on', 'pen_x', 'pen_y'];
const frames = [];
const tables = []; // [frame index, TERAIN words, FEATUR words]
let next = 0;
let downAt = null;
let flying = false;
let lastKey = '';
let yieldAt = 16667;

const engine = await new Engine(module, {
  log: (s) => console.error('[engine]', s),
  frame(t, beams, s, eng) {
    if (eng.getInput('pilot') !== Number(plan)) eng.setInput('pilot', Number(plan));
    if (t >= next) {
      next = t + 1e6 / 30;
      frames.push(FIELDS.map((f) => s[f]));
      const S = eng.symbols;
      const ter = [];
      for (let i = 0; i < 911; i++) ter.push(eng.peek(S.TERAIN + 2 * i));
      const fet = [];
      for (let a = (S.FEATUR & ~1); a < S.FEATUR + 456; a += 2) fet.push(eng.peek(a));
      const key = ter.join(',') + '|' + fet.join(',');
      if (key !== lastKey) {
        tables.push([frames.length - 1, ter, fet]);
        lastKey = key;
      }
      if (s.verdis > 1000) flying = true;
      if (downAt === null && flying && s.verdis < 450 && s.radary <= 0) downAt = t;
    }
    if (downAt !== null && t > downAt + Number(after) * 1e6) return { stop: true, take: true };
    if (t > 900e6) return { stop: true, take: true };
    if (t < yieldAt) return { yield: false };
    yieldAt = t + 16667;
    return { yield: true, take: true };
  },
  async sleep() {
    await new Promise((r) => setImmediate(r));
  },
}).init();
await engine.run();
writeFileSync(out, JSON.stringify({ plan: Number(plan), fields: FIELDS, symbols: engine.symbols, featurBase: engine.symbols.FEATUR & ~1, frames, tables }));
console.log(`${frames.length} frames, ${tables.length} table states, touchdown at ${downAt ? (downAt / 1e6).toFixed(1) : '-'} s -> ${out}`);
