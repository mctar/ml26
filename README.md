# Moonlander, 2026

Jack Burness's Moonlander (DEC GT40, 1973) in a browser, built on
[the recovery](https://github.com/mctar/moonlander): the program as it
survives, translated routine by routine into Rust and proved against the
original binary step for step. Nothing of the physics or the rules is
rewritten here. The translation runs whole, compiled to WebAssembly, and
the page reads the game out of the original's own variables.

Live at [moonlander.btrbot.com](https://moonlander.btrbot.com).

## What is where

- `engine/`: the Rust crate that wraps the recovery's `moonlander` and
  `gt40` crates for the browser. A C ABI with no generated glue: `tend` is
  called out at least once per millisecond of machine time with the beam's
  picture and the game's state, read from the original's variables at
  their original addresses; the host puts the light pen back in.
- `web/`: the page. `engine/engine.js` drives the WebAssembly through
  Binaryen's Asyncify, which lets a program that never returns pause for a
  frame; `phosphor.js` is the recovery's P39 phosphor model on the GPU;
  `roadster.js` is the 2026 view (three.js: the land round the TERAIN
  table, the diner, what earlier games left behind, the camera, with the
  pieces from `world/`); `sound.js` is what the driver hears; `main.js` paces the
  machine against the clock, keeps the two views, turns the controls into
  the pen, and holds the machine still while the guide, About or an end
  card is open. The page opens on the tube, with the program's own
  greeting drawn in real time; after a few seconds the tube switches off
  and the title comes up in the GT40's own letters (`title.js`, from the
  VT11 character generator) over the car drifting against the Earth,
  which waits for a key; then the camera draws back into the flight. The Earth is NASA's Blue Marble with its clouds
  (`world/earth.jpg`). Every way a flight can end (lunch at the diner, a flag, a
  tip-over, a crater, a boulder, someone else's car, the diner itself) gets
  its own card; Play again runs through the program's own wait at speed
  and keeps the Moon, with everything earlier flights left on it. `vendor/three.js` is a bundled subset of three.js, built
  from `vendor/three-entry.js` with esbuild.
- `web/world/`: the pieces of the 2026 view. `land.js` is the country
  round the flight line: Burness's skyline exact along the line, his
  peaks spreading into massifs away from it, plains in front, highlands
  behind, craters of every size, and the curve of the Moon out to the
  horizon, in rings of mesh that grow coarser away from the line;
  `landworker.js` works out its heights and the sunlight on each of its
  points (the shadows of mountains miles away) off the page's thread.
  `car.js` is the Roadster,
  lofted from a few profiles, on springs that keep it on the ground;
  `astronaut.js` the driver, posed by two-bone inverse kinematics, with a
  low-gravity lope that plants his feet where they land; `choreo.js` the
  climb out and back in, keyed in the car's frame; `driver.js` runs him
  from the program's own man (PALSY, PALNOR, MOVMAN), early enough to be
  on time; `props.js` the flag and the order; `plume.js` the cold-gas
  jets, raymarched; `ballistic.js` dust and ejecta on vacuum trajectories,
  and the sheet of dust the jets drive along the ground; `rigid.js` rigid
  bodies against the ground (the terrain, the boulders, the diner's roof,
  cars left from earlier games), with friction and wheels that roll,
  stepped at a fixed rate and drawn between steps, so they move evenly at
  any frame rate, and pushed out of the ground by moving them rather than
  by speeding them up, so nothing hops off it; `topple.js` the car going
  over when the program says it has tipped: rolled up over an edge with
  the edge kept on the ground, past the balance, then falling the way a
  car falls and lying where it came to rest for the games after;
  `debris.js` a crash, from the car meeting what it hit to the pieces at
  rest; `prints.js` boot prints.
- `web/lab.html`: a page for checking the 2026 view, not linked from the
  site. It replays flights recorded by `tools/lab/record.mjs` through the
  real view frame by frame, and measures every frame: the driver's soles
  against the ground, every part of him against the car's body and
  fittings, the tyres and hull against the ground. It can also step the
  view as a 60 or 120 Hz display would, unevenly as browsers do, to
  measure how smoothly things move.
- `web/radio.js` plays the spoken messages in `web/radio/`, made by
  `tools/radio/make.sh` from `tools/radio/lines.json` with pocket-tts and
  ffmpeg.
- `build.sh`: Rust to wasm32, then `wasm-opt --asyncify`.
- `.github/workflows/pages.yml`: tests, builds and publishes the site.

## Keys and switches

Drag the thrust bar or use the up and down keys; the arrows turn, Shift
for the big ones. V shows the 1973 tube, R starts again, S copies a replay
link, A hands over to the autopilot, M turns the sound off and on, H (or
?) opens the pilot's guide. D, which the page does not mention, opens the
demo flights: pick an ending and the autopilot flies it on a fresh Moon,
fast from the heights and near real time at the ground.
Query parameters: `?view=1973` opens
on the tube, `?pilot=N` starts the autopilot (0 land, 1 the diner, 2 a
flag, 7 climb away, 10 into the diner, 1000 plus a terrain index to come
down there, whatever is there), `?rate=N` runs the machine at N
times real time, `?debug` shows timings, `?norender` skips drawing (for
tests).

## Building

Rust with the `wasm32-unknown-unknown` target and Node 22. Then:

    ./build.sh
    node web/engine/engine.test.mjs 60     # the autopilot flies, headless
    python3 -m http.server -d web          # and open http://localhost:8000

## The domain

`web/CNAME` names `moonlander.btrbot.com`. The DNS record to match is a
CNAME from `moonlander` to `mctar.github.io`, DNS only (no proxy) so that
GitHub can issue the certificate; then turn on "Enforce HTTPS" in the
repository's Pages settings.

## Licence

MIT, as the recovery. Moonlander itself is Jack Burness's work, 1973.
