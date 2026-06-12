#!/usr/bin/env bash
# Assemble the promo: frames + generated music + game sfx -> vertical mp4.
# Run AFTER scripts/promo.ts and scripts/promo-audio.ts. Requires ffmpeg + jq.
set -euo pipefail

OUT="${1:-/tmp/atbolo-promo}" # pass /tmp/atbolo-promo-sq for the square cut
SFX="$(cd "$(dirname "$0")/../public/assets/sfx" && pwd)"
cd "$OUT"

# --- pick a tasteful subset of sfx events --------------------------------
# dedupe events landing within 0.15s of the previous one of the same kind,
# then cap per kind so the mix doesn't turn to mud
jq -c '
  group_by(.kind) | map(
    sort_by(.t)
    | reduce .[] as $e ([]; if (length == 0) or ($e.t - .[-1].t > 0.15) then . + [$e] else . end)
    | if .[0].kind == "fire" then .[0:12]
      elif .[0].kind == "boom" then .[0:14]
      elif .[0].kind == "bigboom" then .[0:9]
      else . end
  ) | flatten | sort_by(.t)
' events.json > picked.json

N=$(jq length picked.json)
echo "mixing $N sfx events"

# --- build the ffmpeg mix command ----------------------------------------
INPUTS=(-i music.wav)
FILTER=""
MIX="[0:a]"
i=1
while read -r ev; do
  kind=$(jq -r .kind <<<"$ev")
  t=$(jq -r .t <<<"$ev")
  ms=$(printf '%.0f' "$(echo "$t * 1000" | bc)")
  case $kind in
    fire)    f="fire$((i % 3)).ogg";    vol=0.40 ;;
    boom)    f="boom$((i % 3)).ogg";    vol=0.65 ;;
    bigboom) f="bigboom$((i % 2)).ogg"; vol=0.85 ;;
    capture) f="capture0.ogg";          vol=0.90 ;;
  esac
  INPUTS+=(-i "$SFX/$f")
  FILTER+="[$i:a]adelay=${ms}|${ms},volume=${vol}[s$i];"
  MIX+="[s$i]"
  i=$((i + 1))
done < <(jq -c '.[]' picked.json)

# limit a touch low: the AAC encode overshoots transient peaks slightly
FILTER+="${MIX}amix=inputs=$i:normalize=0:duration=first,alimiter=limit=0.85[mix]"

ffmpeg -y "${INPUTS[@]}" -filter_complex "$FILTER" -map '[mix]' -ar 44100 mix.wav 2>/dev/null
echo "wrote mix.wav"

# --- final encode ----------------------------------------------------------
# force standard bt709 color tags: PNG sources otherwise leave an sRGB
# transfer + unknown matrix in the VUI, which strict transcoding pipelines
# (e.g. Bluesky's video service) can hang on
ffmpeg -y -framerate 30 -i frames/f%05d.png -i mix.wav \
  -vf "scale=out_color_matrix=bt709:out_range=tv,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709" \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 \
  -c:v libx264 -preset medium -crf 21 -pix_fmt yuv420p -profile:v high -level 4.0 \
  -c:a aac -b:a 160k -shortest -movflags +faststart \
  atbolo-promo.mp4 2>/dev/null
echo "wrote $OUT/atbolo-promo.mp4"
ffprobe -v error -show_entries format=duration,size -of default=noprint_wrappers=1 atbolo-promo.mp4
