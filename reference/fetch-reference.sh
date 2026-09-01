#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 Chey Rasmussen
#
# fetch-reference.sh — reproduce the foil reference corpus locally.
#
# The pixels are not in this repository and never will be. The frames and clips
# in this corpus are cut from other people's videos; foilkit ships the analysis
# and the citations, never the third-party material they were made from
# (AGENTS.md F2). This script is the other half of that bargain: it downloads
# the sources and cuts the same excerpts into `reference-media/`, which is
# gitignored.
#
#   reference/fetch-reference.sh                  # everything
#   reference/fetch-reference.sh cosmos tinsel    # named patterns only
#   reference/fetch-reference.sh --list           # what would be fetched
#   reference/fetch-reference.sh --record         # also fill MANIFEST's source tier
#   reference/fetch-reference.sh --keep-video     # do not delete the downloads
#
# Requires: yt-dlp, ffmpeg, node (for the manifest reader). Nothing else.
#
# ── THE ONE PARAMETER THAT WAS NEVER WRITTEN DOWN ──────────────────────────
#
# Every notes.md says "8 keyframes spanning the tilt demo at X-Y". The frame
# WIDTH (480 px) and the clip format (360p, silent) were recorded. The
# KEYFRAME SELECTION RULE was not, and the original operator is not available
# to be asked.
#
# This script uses EVEN SPACING: eight samples across [X, Y] inclusive, so
# frame 1 is at X and frame 8 is at Y. That is the most likely reading of
# "8 keyframes spanning" and it is what the archived frames look like — but
# it is a RECONSTRUCTION, not a recovered procedure. If the original used
# ffmpeg scene detection, or I-frame snapping, or thumbnail extraction, the
# frames this produces will be near-misses rather than matches, and no
# comparison against the archive can distinguish "wrong rule" from "different
# decoder" after two re-encodes.
#
# That is precisely why MANIFEST.json's derived tier is STRUCTURAL. What is
# checkable — eight frames, 480 px wide, cut from the recorded range of the
# recorded video — this script reproduces exactly. Frame-for-frame identity is
# not claimed and is not checked, because it cannot honestly be either.
#
# The source tier IS exact, and it is the one that matters: three of the five
# sources are from 2020-2022 and may not be re-fetchable. `--record` writes the
# duration and the sha256 of what actually downloaded, so the SECOND person to
# run this can tell whether they got the same video.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
MANIFEST="$HERE/MANIFEST.json"
MEDIA="${FOILKIT_REFERENCE_MEDIA:-$ROOT/reference-media}"
WORK="${FOILKIT_REFERENCE_WORK:-$MEDIA/.sources}"

FRAME_COUNT=8
FRAME_WIDTH=480
CLIP_HEIGHT=360

LIST_ONLY=0
RECORD=0
KEEP_VIDEO=0
WANTED=()

for a in "$@"; do
  case "$a" in
    --list) LIST_ONLY=1 ;;
    --record) RECORD=1 ;;
    --keep-video) KEEP_VIDEO=1 ;;
    -h|--help) sed -n '3,50p' "${BASH_SOURCE[0]}"; exit 0 ;;
    --*) echo "unknown option: $a" >&2; exit 2 ;;
    *) WANTED+=("$a") ;;
  esac
done

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 3; }; }
need node
[ "$LIST_ONLY" = 1 ] || { need yt-dlp; need ffmpeg; }

[ -f "$MANIFEST" ] || { echo "no MANIFEST.json — run: node reference/manifest.mjs build" >&2; exit 4; }

# The manifest is the plan. One node call emits a tab-separated line per
# pattern that has media, so the shell never parses JSON.
plan() {
  node -e '
    const m = require(process.argv[1]);
    const want = process.argv.slice(2);
    for (const [slug, d] of Object.entries(m.derived)) {
      if (d.noMedia || !d.frames) continue;
      if (want.length && !want.includes(slug)) continue;
      const c = d.clip ?? {};
      process.stdout.write([
        slug, d.source, d.frames.fromSec, d.frames.toSec,
        c.present ? c.fromSec : "", c.present ? c.toSec : "",
      ].join("\t") + "\n");
    }
  ' "$MANIFEST" "${WANTED[@]+"${WANTED[@]}"}"
}

if [ "$LIST_ONLY" = 1 ]; then
  plan | while IFS=$'\t' read -r slug src f0 f1 c0 c1; do
    printf '%-26s %s  frames %ss-%ss  clip %s\n' "$slug" "$src" "$f0" "$f1" "${c0:+${c0}s-${c1}s}"
  done
  exit 0
fi

mkdir -p "$MEDIA" "$WORK"

# ── 1. the sources ─────────────────────────────────────────────────────────
# One download per video, reused by every pattern cut from it. 360p is what the
# corpus was cut at; asking for more would change the frames and waste the
# bandwidth. Audio is never downloaded — nothing here needs it, and a silent
# excerpt is a narrower excerpt.
declare -A HAVE=()
fetch_source() {
  local id="$1" out="$WORK/$id.mp4"
  [ -n "${HAVE[$id]:-}" ] && return 0
  if [ ! -f "$out" ]; then
    echo "==> downloading $id"
    yt-dlp \
      --no-playlist \
      --format 'bestvideo[height<=360][ext=mp4]/bestvideo[height<=360]/best[height<=360]' \
      --output "$out" \
      "https://www.youtube.com/watch?v=$id"
  fi
  HAVE[$id]="$out"
}

# ── 2. the excerpts ────────────────────────────────────────────────────────
# EVEN SPACING across the recorded range — see the header. `-ss` before `-i` so
# ffmpeg seeks rather than decodes to the timestamp, and `-frames:v 1` so each
# invocation produces exactly one frame at exactly one time.
cut_frames() {
  local src="$1" dir="$2" from="$3" to="$4"
  local step
  step="$(node -e 'const [f,t,n]=process.argv.slice(1).map(Number);process.stdout.write(String(n>1?(t-f)/(n-1):0))' "$from" "$to" "$FRAME_COUNT")"
  for i in $(seq 1 "$FRAME_COUNT"); do
    local at
    at="$(node -e 'const [f,s,i]=process.argv.slice(1).map(Number);process.stdout.write((f+s*(i-1)).toFixed(3))' "$from" "$step" "$i")"
    ffmpeg -nostdin -loglevel error -y \
      -ss "$at" -i "$src" \
      -frames:v 1 -vf "scale=$FRAME_WIDTH:-2" \
      "$(printf '%s/frame-%02d.jpg' "$dir" "$i")"
  done
}

cut_clip() {
  local src="$1" dir="$2" from="$3" to="$4"
  local dur
  dur="$(node -e 'const [f,t]=process.argv.slice(1).map(Number);process.stdout.write((t-f).toFixed(3))' "$from" "$to")"
  ffmpeg -nostdin -loglevel error -y \
    -ss "$from" -i "$src" -t "$dur" \
    -an -vf "scale=-2:$CLIP_HEIGHT" \
    -c:v libvpx-vp9 -b:v 0 -crf 34 -row-mt 1 \
    "$dir/clip.webm"
}

COUNT=0
while IFS=$'\t' read -r slug src f0 f1 c0 c1; do
  fetch_source "$src"
  dir="$MEDIA/$slug"
  mkdir -p "$dir"
  echo "==> $slug  ($src  ${f0}s-${f1}s)"
  cut_frames "${HAVE[$src]}" "$dir" "$f0" "$f1"
  [ -n "$c0" ] && cut_clip "${HAVE[$src]}" "$dir" "$c0" "$c1"
  COUNT=$((COUNT + 1))
done < <(plan)

# ── 3. the exact tier ──────────────────────────────────────────────────────
# Only with --record, and only from a download that actually happened: this is
# the field the archive could never supply, and it is worth nothing if it is
# filled in from anywhere but a real fetch.
if [ "$RECORD" = 1 ]; then
  for id in "${!HAVE[@]}"; do
    file="${HAVE[$id]}"
    sha="$(node -e 'const c=require("crypto"),f=require("fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$file")"
    dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$file")"
    node -e '
      const fs = require("fs");
      const [p, id, sha, dur] = process.argv.slice(1);
      const m = JSON.parse(fs.readFileSync(p, "utf8"));
      m.sources[id] = { ...m.sources[id], sha256: sha, durationSec: Number(Number(dur).toFixed(3)), measured: true, recordedAt: new Date().toISOString().slice(0, 10) };
      fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
      console.log(`recorded ${id}: ${Number(dur).toFixed(1)}s ${sha.slice(0, 16)}`);
    ' "$MANIFEST" "$id" "$sha" "$dur"
  done
fi

if [ "$KEEP_VIDEO" != 1 ]; then
  rm -rf "$WORK"
fi

echo
echo "$COUNT pattern(s) -> $MEDIA"
node "$HERE/manifest.mjs" validate --media "$MEDIA"
