// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// tools/reference-clips/notes.test.ts — the notes.md parser, driven against
// fixtures that are the REAL heading shapes the corpus contains.
//
// Three halves:
//
//  * SYNTHETIC HEADINGS. Every shape a `reference/<slug>/notes.md` actually
//    takes — the 39-pattern-video form, the two vocabulary-extension forms, the
//    mm:ss form, and the no-media interlude. These are copied from the corpus
//    rather than invented, because the thing under test is a parser over prose
//    somebody hand-wrote and the only failures worth catching are the ones that
//    format actually produces.
//  * THE LOUD FAILURES. Every problem the builder is supposed to refuse, each
//    asserted to name the slug it is about.
//  * THE REAL CORPUS. `reference/` itself, asserted for SHAPE: it parses, it
//    agrees with MANIFEST.json, and the counts are the ones the pane's empty
//    state was designed against.

import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  buildReferenceClips,
  parseNotes,
  ReferenceClipsError,
  serializeReferenceClips,
  toSeconds,
  type ManifestLike,
} from './notes.ts'

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..')

// ── The heading shapes the corpus contains ─────────────────────────────────

/** The 39-pattern-video form. 41 of the 44 dirs look exactly like this. */
const CHAPTERED = `# Ace spec

Video chapter: **19:32 - 20:11** of [All 39 Pokemon Card Holo Patterns Explained](https://youtu.be/wQ2TvnHVdys) by **Sleeve No Card Behind**.
Frames: 8 keyframes spanning the tilt demo at 1172.3s-1180.0s; clip: 1173.0s-1176.5s (360p, silent).

## Cards / material shown

- Grand Tree (SV ACE SPEC) - tilt demo
`

/** A vocabulary extension: no chapter, the citation on a Source: line. */
const VOCAB = `# Detective Pikachu (vocabulary extension — not from the 39-pattern video)

Source: **[Charizard 5/18 - Pokemon Detective Pikachu](https://youtu.be/WjuDazguHnE)** by
**Pokemon Holo** (YouTube, Feb 2021 — single-card tilt showcase channel). Frames: 8
keyframes spanning the tilt demo at 3.5s-11.5s; clip: 5s-8.5s (360p, silent).

## Cards / material shown

- Charizard — Detective Pikachu 5/18
`

/** mm:ss bounds, transcribed off the video's own timeline. Only shiny-vault. */
const MMSS = `# Shiny vault (vocabulary extension — not from the 39-pattern video)

Source: **[The Entire History of Shiny Pokémon Cards](https://youtu.be/_cyddOc1SMU)** (Jul 2026) by
**Sleeve No Card Behind** — the same creator as the 39-pattern corpus video.
Video chapter: **18:19 - 19:30** (the Hidden Fates shiny vault segment).
Frames: 8 keyframes spanning the tilt demo at 19:18-19:26; clip: 19:20-19:23.5 (360p,
silent).

## Cards / material shown
`

/** The interlude: a chapter, a creator, and NOTHING excerpted. */
const NO_MEDIA = `# What is a holo card? (interlude)

Video chapter: **8:35 - 11:11** of [All 39 Pokemon Card Holo Patterns Explained](https://youtu.be/wQ2TvnHVdys)
by **Sleeve No Card Behind**. No media extracted — this is the physics/production background
segment.

## Key facts for shader authors
`

test('the 39-pattern-video heading yields id, chapter, creator and fractional clip bounds', () => {
  const n = parseNotes('ace-spec', CHAPTERED)
  assert.equal(n.videoId, 'wQ2TvnHVdys')
  assert.equal(n.title, 'All 39 Pokemon Card Holo Patterns Explained')
  assert.equal(n.creator, 'Sleeve No Card Behind')
  assert.equal(n.chapter, '19:32 - 20:11')
  assert.equal(n.clipStart, 1173)
  assert.equal(n.clipEnd, 1176.5)
  assert.equal(n.noMedia, false)
})

test('a vocabulary extension parses with no chapter — the citation is on the Source line', () => {
  const n = parseNotes('detective-pikachu', VOCAB)
  assert.equal(n.videoId, 'WjuDazguHnE')
  assert.equal(n.title, 'Charizard 5/18 - Pokemon Detective Pikachu')
  assert.equal(n.creator, 'Pokemon Holo')
  assert.equal(n.chapter, null)
  assert.equal(n.clipStart, 5)
  assert.equal(n.clipEnd, 8.5)
})

test('mm:ss bounds become seconds, and the fraction survives the conversion', () => {
  const n = parseNotes('shiny-vault', MMSS)
  assert.equal(n.clipStart, 19 * 60 + 20)
  assert.equal(n.clipEnd, 19 * 60 + 23.5)
  assert.equal(n.chapter, '18:19 - 19:30')
})

test('the no-media interlude parses to a citation with no bounds, not to a failure', () => {
  const n = parseNotes('_interlude-what-is-a-holo', NO_MEDIA)
  assert.equal(n.videoId, 'wQ2TvnHVdys')
  assert.equal(n.chapter, '8:35 - 11:11')
  assert.equal(n.clipStart, null)
  assert.equal(n.clipEnd, null)
  assert.equal(n.noMedia, true)
})

test('only the heading is read — a timestamp in the body is not a clip range', () => {
  // gold-secret's body names macro close-ups "at ~28s-34s" that were
  // deliberately NOT excerpted. A parser over the whole file takes them.
  const withDecoy = `${CHAPTERED}\nThe source also holds macro close-ups; clip: 28s-34s (not excerpted).\n`
  assert.equal(parseNotes('gold-secret', withDecoy).clipStart, 1173)
})

test('toSeconds reads both spellings, and refuses what is neither', () => {
  assert.equal(toSeconds('96.5'), 96.5)
  assert.equal(toSeconds('96.5s'), 96.5)
  assert.equal(toSeconds('1:36'), 96)
  assert.equal(toSeconds('1:02:03'), 3723)
  assert.equal(toSeconds(''), null)
  assert.equal(toSeconds('soon'), null)
})

// ── The builder, and every failure it is supposed to be loud about ──────────

/** A manifest that agrees with whatever notes are passed alongside it. */
function manifestFor(notes: Array<{ slug: string; markdown: string }>): ManifestLike {
  const derived: NonNullable<ManifestLike['derived']> = {}
  for (const { slug, markdown } of notes) {
    const n = parseNotes(slug, markdown)
    derived[slug] = {
      source: n.videoId,
      chapter: n.chapter,
      clip: n.clipStart === null ? null : { fromSec: n.clipStart, toSec: n.clipEnd },
    }
  }
  return { derived }
}

const CORPUS = [
  { slug: 'ace-spec', markdown: CHAPTERED },
  { slug: 'detective-pikachu', markdown: VOCAB },
  { slug: 'shiny-vault', markdown: MMSS },
  { slug: '_interlude-what-is-a-holo', markdown: NO_MEDIA },
]

test('a mixed corpus builds: three sources, four dirs, three of them with a clip', () => {
  const file = buildReferenceClips({ notes: CORPUS, manifest: manifestFor(CORPUS) })
  assert.deepEqual(Object.keys(file.sources).sort(), ['WjuDazguHnE', '_cyddOc1SMU', 'wQ2TvnHVdys'])
  assert.equal(Object.keys(file.clips).length, 4)
  assert.equal(Object.values(file.clips).filter((c) => c.clipStart !== null).length, 3)
  // The absence is CARRIED, not dropped. A dir missing from the datum and a dir
  // present with null bounds are different claims, and the pane renders them
  // differently — "no reference clip recorded" versus nothing at all.
  assert.deepEqual(file.clips['_interlude-what-is-a-holo'], {
    videoId: 'wQ2TvnHVdys',
    chapter: '8:35 - 11:11',
    clipStart: null,
    clipEnd: null,
  })
})

test('the digest is over the citations, and it moves when one of them does', () => {
  const a = buildReferenceClips({ notes: CORPUS, manifest: manifestFor(CORPUS) })
  const b = buildReferenceClips({ notes: [...CORPUS].reverse(), manifest: manifestFor(CORPUS) })
  assert.equal(a.notesDigest, b.notesDigest, 'input order must not change the output')
  assert.equal(serializeReferenceClips(a), serializeReferenceClips(b))

  const moved = CORPUS.map((n) =>
    n.slug === 'ace-spec' ? { ...n, markdown: n.markdown.replace('1176.5s', '1177.5s') } : n,
  )
  assert.notEqual(buildReferenceClips({ notes: moved, manifest: manifestFor(moved) }).notesDigest, a.notesDigest)
})

test('a notes.md with no video id fails by name rather than degrading to "no clip"', () => {
  const notes = [{ slug: 'orphan', markdown: '# Orphan\n\nNo source recorded.\n' }]
  assert.throws(
    () => buildReferenceClips({ notes, manifest: manifestFor(notes) }),
    (err: unknown) => err instanceof ReferenceClipsError && /orphan: no youtu\.be/.test(err.message),
  )
})

test('a "clip:" whose range does not parse is a typo, and is refused as one', () => {
  // The failure mode this exists for: the regex simply does not match, both
  // bounds come back null, and without this guard a mangled timestamp is
  // indistinguishable from the interlude's genuine absence. The pane would then
  // tell a contributor "no reference clip recorded" about a clip that exists.
  const notes = [{ slug: 'half', markdown: CHAPTERED.replace('1173.0s-1176.5s', '1173.0s-') }]
  assert.equal(parseNotes('half', notes[0]!.markdown).clipStart, null)
  assert.equal(parseNotes('half', notes[0]!.markdown).clipMalformed, true)
  assert.throws(
    () => buildReferenceClips({ notes, manifest: manifestFor(notes) }),
    (err: unknown) => err instanceof ReferenceClipsError && /half: the heading says "clip:"/.test(err.message),
  )
})

test('and the interlude, which never says "clip:", is NOT caught by that guard', () => {
  assert.equal(parseNotes('_interlude-what-is-a-holo', NO_MEDIA).clipMalformed, false)
})

test('a clip that ends before it starts is refused', () => {
  const notes = [{ slug: 'backwards', markdown: CHAPTERED.replace('1173.0s-1176.5s', '1176.5s-1173.0s') }]
  assert.throws(
    () => buildReferenceClips({ notes, manifest: manifestFor(notes) }),
    (err: unknown) => err instanceof ReferenceClipsError && /backwards: clip ends at 1173s/.test(err.message),
  )
})

test('two dirs attributing one video to different creators is a contradiction, not a merge', () => {
  const notes = [
    { slug: 'a-first', markdown: CHAPTERED },
    { slug: 'b-second', markdown: CHAPTERED.replace('Sleeve No Card Behind', 'Somebody Else') },
  ]
  assert.throws(
    () => buildReferenceClips({ notes, manifest: manifestFor(notes) }),
    (err: unknown) => err instanceof ReferenceClipsError && /b-second: attributes wQ2TvnHVdys to "Somebody Else"/.test(err.message),
  )
})

test('an empty corpus is a broken checkout and says so', () => {
  assert.throws(
    () => buildReferenceClips({ notes: [], manifest: {} }),
    (err: unknown) => err instanceof ReferenceClipsError && /broken checkout/.test(err.message),
  )
})

// ── The cross-check against MANIFEST.json ──────────────────────────────────
//
// The whole reason it exists: `reference/manifest.mjs` is a SECOND parser over
// the same prose, and two parsers over one hand-written format drift.

test('a clip bound that moved in notes.md but not in MANIFEST.json fails the build', () => {
  const stale = manifestFor(CORPUS)
  stale.derived!['ace-spec']!.clip = { fromSec: 1173, toSec: 1180 }
  assert.throws(
    () => buildReferenceClips({ notes: CORPUS, manifest: stale }),
    (err: unknown) =>
      err instanceof ReferenceClipsError &&
      /ace-spec: clip 1173s–1176\.5s in notes\.md, 1173s–1180s in MANIFEST\.json/.test(err.message),
  )
})

test('a chapter that disagrees with the manifest fails the build', () => {
  const stale = manifestFor(CORPUS)
  stale.derived!['ace-spec']!.chapter = '19:32 - 20:99'
  assert.throws(
    () => buildReferenceClips({ notes: CORPUS, manifest: stale }),
    (err: unknown) => err instanceof ReferenceClipsError && /ace-spec: chapter/.test(err.message),
  )
})

test('a dir the manifest carries and the notes do not fails the build', () => {
  const extra = manifestFor(CORPUS)
  extra.derived!['ghost'] = { source: 'wQ2TvnHVdys', chapter: null, clip: null }
  assert.throws(
    () => buildReferenceClips({ notes: CORPUS, manifest: extra }),
    (err: unknown) => err instanceof ReferenceClipsError && /ghost: MANIFEST\.json carries it/.test(err.message),
  )
})

test('a dir the notes carry and the manifest does not fails the build', () => {
  const short = manifestFor(CORPUS.slice(1))
  assert.throws(
    () => buildReferenceClips({ notes: CORPUS, manifest: short }),
    (err: unknown) => err instanceof ReferenceClipsError && /ace-spec: parsed from notes\.md, absent from MANIFEST\.json/.test(err.message),
  )
})

// ── The real corpus ────────────────────────────────────────────────────────

test('the real reference/ parses, agrees with its manifest, and has one dir with no clip', async () => {
  const dir = join(REPO, 'reference')
  const notes: Array<{ slug: string; markdown: string }> = []
  for (const entry of (await readdir(dir)).sort()) {
    if (!(await stat(join(dir, entry))).isDirectory()) continue
    try {
      notes.push({ slug: entry, markdown: await readFile(join(dir, entry, 'notes.md'), 'utf8') })
    } catch {
      /* not a pattern dir */
    }
  }
  const manifest = JSON.parse(await readFile(join(dir, 'MANIFEST.json'), 'utf8')) as ManifestLike

  // Throws — loudly, naming slugs — if anything above is wrong about the corpus.
  const file = buildReferenceClips({ notes, manifest })

  assert.equal(Object.keys(file.sources).length, 5, 'MANIFEST.json says FIVE source videos, not six')
  assert.equal(Object.keys(file.clips).length, 44)
  const without = Object.entries(file.clips).filter(([, c]) => c.clipStart === null)
  assert.deepEqual(
    without.map(([slug]) => slug),
    ['_interlude-what-is-a-holo'],
    'the interlude is the only dir with no clip — it is the physics segment, and no media was cut from it',
  )
  // Some dirs cite the same video at different chapters; that is the corpus's
  // normal shape, not a duplicate to collapse.
  const fromMainVideo = Object.values(file.clips).filter((c) => c.videoId === 'wQ2TvnHVdys')
  assert.equal(fromMainVideo.length, 39 + 1, '39 pattern chapters plus the interlude come from the one video')
})
