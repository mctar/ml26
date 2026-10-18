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
  picture and the game's state; the host puts the light pen back in.
- `web/`: the page. `engine/engine.js` drives the WebAssembly through
  Binaryen's Asyncify, which lets a program that never returns pause for a
  frame; `phosphor.js` is the recovery's P39 phosphor model on the GPU;
  `main.js` paces the machine against the clock and turns the mouse,
  a finger or the keyboard into the pen.
- `build.sh`: Rust to wasm32, then `wasm-opt --asyncify`.
- `.github/workflows/pages.yml`: tests, builds and publishes the site.

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
