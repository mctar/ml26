#!/usr/bin/env bash
# The radio: every message spoken, then put through a narrow band, a
# compressor and a little grit, as a voice link would. Needs pocket-tts
# (pip install pocket-tts) and ffmpeg. Writes web/radio/<ID>.mp3.
#   tools/radio/make.sh [pocket-tts binary]
set -euo pipefail
cd "$(dirname "$0")/../.."
TTS="${1:-pocket-tts}"
mkdir -p web/radio tools/radio/raw
python3 - <<'PY' > tools/radio/lines.tsv
import json
for k, v in json.load(open('tools/radio/lines.json')).items():
    print(f"{k}\t{v}")
PY
while IFS=$'\t' read -r id text; do
  raw="tools/radio/raw/$id.wav"
  if [ ! -s "$raw" ]; then
    "$TTS" generate --quiet --language english --text "$text" --output-path "$raw" < /dev/null
  fi
  # 300 to 3400 Hz, compressed hard, a touch of crush, and room for the
  # squelch and static the page adds live.
  ffmpeg -nostdin -y -loglevel error -i "$raw" \
    -af "highpass=f=300,lowpass=f=3400,acompressor=threshold=-20dB:ratio=5:attack=4:release=90:makeup=6,acrusher=bits=9:mix=0.18,highpass=f=300,alimiter=limit=0.85,silenceremove=start_periods=1:start_threshold=-45dB:detection=peak,areverse,silenceremove=start_periods=1:start_threshold=-45dB:detection=peak,areverse" \
    -ar 22050 -ac 1 -codec:a libmp3lame -b:a 40k "web/radio/$id.mp3"
  echo "$id"
done < tools/radio/lines.tsv
rm tools/radio/lines.tsv
ls -la web/radio
