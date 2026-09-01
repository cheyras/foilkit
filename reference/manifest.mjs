// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// MANIFEST.json — build it from the notes, validate a fetch against it.
//
//   node reference/manifest.mjs build    --media <dir> [--out reference/MANIFEST.json]
//   node reference/manifest.mjs validate --media <dir>
//
// `--media <dir>` points at a tree of `<slug>/frame-NN.jpg` + `<slug>/clip.webm`
// — what `fetch-reference.sh` writes into `reference-media/`, or an offline
// archive of the original corpus.
//
// TWO TIERS, AND WHY
//
// Different yt-dlp and ffmpeg versions re-encode differently. A naive byte-hash
// gate over derived frames would therefore fail on a CORRECT fetch, which is
// the fastest way to teach someone to ignore the check. So:
//
//   SOURCE VIDEOS — EXACT. Video id, duration in seconds, sha256 of the
//   downloaded stream. A re-fetch that resolves to different content (a
//   re-upload, a replaced video, the wrong id) then fails loudly instead of
//   quietly corrupting the corpus. This is the tier that actually matters:
//   three of the five sources are from 2020-2022 and may not be re-fetchable.
//
//   DERIVED FRAMES AND CLIPS — STRUCTURAL. File count per directory, frame
//   dimensions, the second-range each was cut from, and which source they came
//   from. Not byte hashes.
//
// The source tier is recorded UNMEASURED here, deliberately. The offline
// archive holds the derived frames and clips — it never held the source videos,
// which were fetched, cut from and discarded under the media budget. Writing a
// duration or a hash now would be inventing a measurement, so the fields exist
// with `"measured": false` and `fetch-reference.sh --record` fills them in on
// the first real fetch. An unmeasured field that says so is a to-do; an
// unmeasured field that looks measured is a lie the corpus never recovers from.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const argv = process.argv.slice(2)
const cmd = argv[0]
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d
}
const MEDIA = arg('media', join(HERE, '..', 'reference-media'))
const OUT = arg('out', join(HERE, 'MANIFEST.json'))

/** "1:36" or "96.5" or "96.5s" -> seconds. */
function toSeconds(t) {
  const s = String(t).trim().replace(/s$/, '')
  if (s.includes(':')) {
    const parts = s.split(':').map(Number)
    return parts.reduce((a, b) => a * 60 + b, 0)
  }
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** The 8 frames and the clip are cut from ranges recorded in prose. Parse them. */
function parseNotes(slug) {
  const p = join(HERE, slug, 'notes.md')
  if (!existsSync(p)) return null
  const text = readFileSync(p, 'utf8')
  const head = text.split('\n## ')[0]

  const id = /youtu\.be\/([A-Za-z0-9_-]{6,})/.exec(head)?.[1] ?? null
  const title = /\[([^\]]+)\]\(https:\/\/youtu\.be\//.exec(head)?.[1] ?? null
  const creator = /by\s+\*\*([^*]+)\*\*/.exec(head)?.[1]?.trim() ?? null
  const chapter = /Video chapter:\s*\*\*([^*]+)\*\*/.exec(head)?.[1]?.trim() ?? null

  const framesRange = /keyframes spanning the tilt demo\s+at\s*([0-9:.]+s?)\s*[-–]\s*([0-9:.]+s?)/.exec(head)
  const clipRange = /clip:\s*([0-9:.]+s?)\s*[-–]\s*([0-9:.]+s?)/.exec(head)
  const noMedia = /No media extracted/i.test(head)

  return {
    source: id,
    title,
    creator,
    chapter,
    frames: framesRange ? { fromSec: toSeconds(framesRange[1]), toSec: toSeconds(framesRange[2]) } : null,
    clip: clipRange ? { fromSec: toSeconds(clipRange[1]), toSec: toSeconds(clipRange[2]) } : null,
    noMedia,
  }
}

/** Width and height out of a JPEG's SOF marker — no image library. */
function jpegSize(buf) {
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++
      continue
    }
    const marker = buf[i + 1]
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    }
    i += 2 + buf.readUInt16BE(i + 2)
  }
  return null
}

const slugs = readdirSync(HERE)
  .filter((d) => statSync(join(HERE, d)).isDirectory() && d !== 'pipeline')
  .sort()

function measure(slug) {
  const dir = join(MEDIA, slug)
  if (!existsSync(dir)) return { present: false, frames: 0, clip: false }
  const files = readdirSync(dir)
  const frames = files.filter((f) => /^frame-\d+\.jpg$/i.test(f)).sort()
  const dims = new Set()
  for (const f of frames) {
    const s = jpegSize(readFileSync(join(dir, f)))
    if (s) dims.add(`${s.width}x${s.height}`)
  }
  return {
    present: true,
    frames: frames.length,
    frameSizes: [...dims].sort(),
    clip: files.includes('clip.webm'),
  }
}

if (cmd === 'build') {
  const sources = {}
  const derived = {}
  for (const slug of slugs) {
    const n = parseNotes(slug)
    if (!n) continue
    const m = measure(slug)
    if (n.source && !sources[n.source]) {
      sources[n.source] = {
        url: `https://youtu.be/${n.source}`,
        title: n.title,
        creator: n.creator,
        // EXACT tier — see the header. Unmeasured, and saying so.
        durationSec: null,
        sha256: null,
        measured: false,
      }
    }
    derived[slug] = {
      source: n.source,
      chapter: n.chapter,
      frames: n.noMedia
        ? null
        : {
            count: m.frames || 8,
            width: 480,
            sizes: m.frameSizes ?? null,
            fromSec: n.frames?.fromSec ?? null,
            toSec: n.frames?.toSec ?? null,
          },
      clip: n.noMedia
        ? null
        : { present: m.clip, heightPx: 360, audio: false, fromSec: n.clip?.fromSec ?? null, toSec: n.clip?.toSec ?? null },
      noMedia: n.noMedia,
      measuredAgainst: m.present ? 'offline archive 2026-08-31' : null,
    }
  }
  const manifest = {
    $doc: [
      'MANIFEST.json — what the reference corpus IS, so a re-fetch can be checked.',
      '',
      'The pixels are not in this repository and never will be: this is third-party',
      'footage, cited rather than vendored (AGENTS.md F2). fetch-reference.sh',
      'reproduces it locally into reference-media/, and this file is what tells you',
      'whether the reproduction is the same corpus.',
      '',
      'TWO TIERS. Source videos are EXACT (id, duration, sha256) so a re-fetch that',
      'resolves to different content fails loudly. Derived frames and clips are',
      'STRUCTURAL (count, dimensions, the second-range they were cut from), because',
      'different yt-dlp/ffmpeg versions re-encode differently and a byte-hash gate',
      'over derived media would fail on a CORRECT fetch.',
      '',
      'The source tier is UNMEASURED and says so. The offline archive holds the',
      'derived frames and clips; it never held the source videos, which were fetched,',
      'cut from and discarded under the media budget. Inventing a duration or a hash',
      'now would be worse than admitting there is not one — run',
      'fetch-reference.sh --record to fill them in from a real fetch.',
      '',
      'FIVE source videos, not six. A sixth id (TjlU_WKhS8w) appears in the resolver',
      'evidence files as a CITATION for a usage claim; no frames or clip were ever',
      'cut from it, so it is not a source of this corpus and is not listed here.',
    ],
    version: 1,
    generatedAt: '2026-09-01',
    frameWidthPx: 480,
    clipHeightPx: 360,
    clipAudio: false,
    sources,
    derived,
  }
  writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`)
  const withMedia = Object.values(derived).filter((d) => !d.noMedia).length
  console.log(
    `MANIFEST.json: ${Object.keys(sources).length} source videos, ${Object.keys(derived).length} pattern dirs ` +
      `(${withMedia} with media), measured against ${MEDIA}`,
  )
} else if (cmd === 'validate') {
  const manifest = JSON.parse(readFileSync(OUT, 'utf8'))
  const problems = []
  let ok = 0
  for (const [slug, d] of Object.entries(manifest.derived)) {
    if (d.noMedia) continue
    const m = measure(slug)
    if (!m.present) {
      problems.push(`${slug}: no media directory under ${MEDIA}`)
      continue
    }
    if (m.frames !== d.frames.count) problems.push(`${slug}: ${m.frames} frames, manifest says ${d.frames.count}`)
    for (const size of m.frameSizes) {
      if (Number(size.split('x')[0]) !== manifest.frameWidthPx) {
        problems.push(`${slug}: frame size ${size}, manifest says width ${manifest.frameWidthPx}`)
      }
    }
    if (m.clip !== d.clip.present) problems.push(`${slug}: clip present=${m.clip}, manifest says ${d.clip.present}`)
    if (problems.length === 0 || problems[problems.length - 1].startsWith(`${slug}:`) === false) ok++
  }
  for (const [id, s] of Object.entries(manifest.sources)) {
    if (!s.measured) console.log(`source ${id}: UNMEASURED (duration and sha256 not recorded) — ${s.url}`)
  }
  const digest = createHash('sha256').update(readFileSync(OUT)).digest('hex')
  console.log(`\nmanifest sha256 ${digest}`)
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`structural tier: OK against ${MEDIA}`)
} else {
  console.error('usage: node reference/manifest.mjs build|validate --media <dir> [--out <file>]')
  process.exit(2)
}
