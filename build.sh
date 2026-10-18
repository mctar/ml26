#!/usr/bin/env bash
# Build the engine for the browser: Rust to wasm32, then Binaryen's Asyncify
# so the translation's nested routines can pause for a frame. Output lands in
# web/engine/engine.wasm. Needs cargo with the wasm32-unknown-unknown target
# and node (binaryen comes from npm).
set -euo pipefail
cd "$(dirname "$0")"

cargo build -p ml26-engine --release --target wasm32-unknown-unknown

if ! command -v wasm-opt >/dev/null; then
  if [ ! -x node_modules/.bin/wasm-opt ]; then
    npm install --no-save --no-audit --no-fund binaryen@132.0.0
  fi
  export PATH="$PWD/node_modules/.bin:$PATH"
fi

mkdir -p web/engine
wasm-opt --asyncify --pass-arg=asyncify-imports@env.tend -O3 \
  target/wasm32-unknown-unknown/release/ml26_engine.wasm -o web/engine/engine.wasm
ls -l web/engine/engine.wasm
