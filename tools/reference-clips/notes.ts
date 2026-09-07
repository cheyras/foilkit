// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// tools/reference-clips/notes.ts — promote the reference corpus's citations
// from PROSE to a datum the running app can read.
//
// Every `reference/<slug>/notes.md` opens with the same three facts, written
// for a human: which video the excerpt came from, which chapter of it, and the
// second-range the clip was cut at. Subtask 12 puts a looping YouTube embed of
// that exact range in the canon lab, and a React component cannot parse prose
// at render time — so this parses each notes.md ONCE, at build time, into
// `packages/patterns/src/reference-clips.json`.
//
// ── TWO CONSUMERS, TWO PATHS. DO NOT UNIFY THEM. ───────────────────────────
//
// The same three numbers now feed two things that look like one thing:
//
//   1. THE EMBED (this file → reference-clips.json → the canon lab's pane).
//      A YouTube iframe seeked to the clip range. It exists for HUMAN EYES.
//      Nothing may ever read pixels back out of it: the iframe is cross-origin,
//      `drawImage` on it taints nothing because it cannot be drawn at all, and
//      no amount of effort will change that. It is a picture of the truth for a
//      person to compare against, and that is its whole job.
//
//   2. THE LOCAL FRAMES (`reference/fetch-reference.sh` → `reference-media/`).
//      Real decoded pixels on disk. The Gemini articulation passes
//      (`reference/pipeline/gemini_vision.py`) and the frame-diff harness read
//      THESE. They cannot read the embed, so the fetch script is not redundant
//      with it and deleting either one does not make the other cover its work.
//
// A future reader will notice both start from the same notes.md and try to make
// one serve the other. It cannot be done in the direction that matters: no
// browser API returns pixels from a YouTube frame. If you are here to unify
// them, the answer is that the citation is shared and the media is not.
//
// ── WHY THE CROSS-CHECK AGAINST MANIFEST.json ──────────────────────────────
//
// `reference/manifest.mjs` already parses these same headings, for the fetch
// script's plan. That is now a SECOND reader of the same prose, and two parsers
// over one hand-written format drift the moment somebody edits a notes.md
// heading. `buildReferenceClips` therefore re-reads MANIFEST.json and fails
// loudly on any divergence — the committed manifest and the committed datum
// have to agree about every video id, chapter and clip bound, or the build
// stops. That is cheap, and it is the only thing standing between "somebody
// nudged a timestamp" and a pane that loops the wrong four seconds forever.

import { createHash } from 'node:crypto'

/** A source video, as the corpus cites it. */
export interface ReferenceSourceRecord {
  url: string
  title: string
  creator: string
}

/** One pattern dir's citation. `clipStart`/`clipEnd` are null when none was recorded. */
export interface ReferenceClipRecord {
  videoId: string
  chapter: string | null
  clipStart: number | null
  clipEnd: number | null
}

export interface ReferenceClipsFile {
  $doc: string[]
  version: 1
  /**
   * sha256 over the citations themselves, NOT a clock.
   *
   * `--check` needs the builder to produce identical bytes from identical
   * inputs, and a `new Date()` stamp fails that one second later. A date bumped
   * by hand would be worse: it would go stale silently. This changes when, and
   * only when, a citation changes — which is the thing anybody would have
   * wanted the date for.
   */
  notesDigest: string
  sources: Record<string, ReferenceSourceRecord>
  clips: Record<string, ReferenceClipRecord>
}

/** What one notes.md heading yields. Nothing here is checked yet. */
export interface ParsedNotes {
  slug: string
  videoId: string | null
  title: string | null
  creator: string | null
  chapter: string | null
  clipStart: number | null
  clipEnd: number | null
  /** The notes say in so many words that nothing was excerpted. */
  noMedia: boolean
  /**
   * The heading says `clip:` and the range after it did not parse.
   *
   * This is the difference that matters between the two ways `clipStart` ends
   * up null. A dir with no `clip:` at all genuinely has no clip — the interlude
   * is the physics segment and nothing was cut from it. A dir that SAYS `clip:`
   * and then says something unreadable has a typo, and letting that degrade
   * into "no reference clip recorded" would put the pane's honest empty state
   * in front of a contributor as a lie about a clip that exists.
   */
  clipMalformed: boolean
}

export class ReferenceClipsError extends Error {
  override name = 'ReferenceClipsError'
}

/**
 * `"1:36"`, `"96.5"` or `"96.5s"` → seconds.
 *
 * Both spellings are in the corpus and both are load-bearing: 41 notes write
 * plain seconds, `shiny-vault` writes `19:20-19:23.5` because its chapter was
 * transcribed from the video's own timeline. Fractions survive either way —
 * `radiant-collection-dots` loops 1257.5s–1261.0s and `seekTo` takes floats.
 */
export function toSeconds(raw: string): number | null {
  const s = raw.trim().replace(/s$/, '')
  if (s === '') return null
  if (s.includes(':')) {
    const parts = s.split(':').map(Number)
    if (parts.some((n) => !Number.isFinite(n))) return null
    return parts.reduce((a, b) => a * 60 + b, 0)
  }
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * Parse one notes.md heading.
 *
 * Only the text BEFORE the first `## ` section is read. The body of a notes.md
 * is free prose that routinely names other timestamps — `gold-secret` mentions
 * macro close-ups "at ~28s-34s" that were deliberately not excerpted — and a
 * parser that ran over the whole file would eventually pick one of them up.
 *
 * The patterns are deliberately the same shapes `reference/manifest.mjs` uses.
 * They are duplicated rather than shared because that script is plain `.mjs`
 * run by bare `node` from `fetch-reference.sh`; `buildReferenceClips` is what
 * keeps the two honest, not an import.
 */
export function parseNotes(slug: string, markdown: string): ParsedNotes {
  const head = markdown.split('\n## ')[0] ?? ''
  const clip = /clip:\s*([0-9:.]+s?)\s*[-–]\s*([0-9:.]+s?)/.exec(head)
  return {
    slug,
    videoId: /youtu\.be\/([A-Za-z0-9_-]{6,})/.exec(head)?.[1] ?? null,
    title: /\[([^\]]+)\]\(https:\/\/youtu\.be\//.exec(head)?.[1] ?? null,
    creator: /by\s+\*\*([^*]+)\*\*/.exec(head)?.[1]?.trim() ?? null,
    chapter: /Video chapter:\s*\*\*([^*]+)\*\*/.exec(head)?.[1]?.trim() ?? null,
    clipStart: clip ? toSeconds(clip[1]!) : null,
    clipEnd: clip ? toSeconds(clip[2]!) : null,
    noMedia: /No media extracted/i.test(head),
    clipMalformed: clip === null && /\bclip:/i.test(head),
  }
}

/** The shape `buildReferenceClips` needs out of `reference/MANIFEST.json`. */
export interface ManifestLike {
  sources?: Record<string, { title?: string | null; creator?: string | null }>
  derived?: Record<
    string,
    {
      source?: string | null
      chapter?: string | null
      clip?: { fromSec?: number | null; toSec?: number | null } | null
      noMedia?: boolean
    }
  >
}

export interface BuildInput {
  /** One entry per `reference/<slug>/notes.md`, in any order. */
  notes: Array<{ slug: string; markdown: string }>
  /** The committed `reference/MANIFEST.json`, parsed. */
  manifest: ManifestLike
}

/**
 * Build the datum, or throw naming every slug that is wrong.
 *
 * Loud rather than lenient, on purpose. A citation that silently degrades to
 * "no clip recorded" is indistinguishable from a pattern that genuinely has
 * none, and the pane's honest empty state would then be a lie about 43 of the
 * 44 dirs rather than the truth about one of them.
 */
export function buildReferenceClips(input: BuildInput): ReferenceClipsFile {
  const problems: string[] = []
  const sources: Record<string, ReferenceSourceRecord> = {}
  const clips: Record<string, ReferenceClipRecord> = {}

  if (input.notes.length === 0) {
    throw new ReferenceClipsError('no reference/<slug>/notes.md found — that is a broken checkout, not an empty corpus')
  }

  for (const { slug, markdown } of [...input.notes].sort((a, b) => (a.slug < b.slug ? -1 : 1))) {
    const n = parseNotes(slug, markdown)

    if (n.videoId === null) {
      problems.push(`${slug}: no youtu.be/<id> in the heading — every notes.md names its source video`)
      continue
    }

    // A `clip:` whose range did not parse, or an end at or before its start, is
    // a TYPO rather than an absence. Absence is a heading with no `clip:` in it
    // at all, and it is legitimate.
    if (n.clipMalformed) {
      problems.push(`${slug}: the heading says "clip:" and the range after it did not parse — fix the typo, or drop the "clip:" if there is genuinely no clip`)
      continue
    }
    if ((n.clipStart === null) !== (n.clipEnd === null)) {
      problems.push(`${slug}: half a clip range (${n.clipStart} → ${n.clipEnd}) — a range needs both ends or neither`)
      continue
    }
    if (n.clipStart !== null && n.clipEnd !== null && n.clipEnd <= n.clipStart) {
      problems.push(`${slug}: clip ends at ${n.clipEnd}s, at or before its start ${n.clipStart}s`)
      continue
    }

    // The source table. First dir to cite a video supplies its title and
    // creator; a later dir citing the same video with a DIFFERENT creator is a
    // contradiction in the corpus, not a merge to resolve quietly.
    const existing = sources[n.videoId]
    if (existing === undefined) {
      if (n.title === null || n.creator === null) {
        // Some vocabulary-extension notes put the title in the link and the
        // creator on the next line; both still parse. A miss here is real.
        problems.push(`${slug}: cites ${n.videoId} with no ${n.title === null ? 'title' : 'creator'} to attribute it to`)
        continue
      }
      sources[n.videoId] = { url: `https://youtu.be/${n.videoId}`, title: n.title, creator: n.creator }
    } else if (n.creator !== null && n.creator !== existing.creator) {
      problems.push(`${slug}: attributes ${n.videoId} to "${n.creator}", but another notes.md says "${existing.creator}"`)
      continue
    }

    clips[slug] = {
      videoId: n.videoId,
      chapter: n.chapter,
      clipStart: n.clipStart,
      clipEnd: n.clipEnd,
    }
  }

  problems.push(...crossCheck(clips, input.manifest))

  if (problems.length > 0) {
    throw new ReferenceClipsError(
      `${problems.length} problem(s) in the reference corpus:\n  ${problems.join('\n  ')}`,
    )
  }

  // Sorted so that adding a dir which cites an already-cited video cannot
  // reorder the table and produce a diff that is not a change.
  const sortedSources: Record<string, ReferenceSourceRecord> = {}
  for (const id of Object.keys(sources).sort()) sortedSources[id] = sources[id]!

  const withClip = Object.values(clips).filter((c) => c.clipStart !== null).length
  return {
    $doc: [
      'reference-clips.json — the citation half of the reference corpus, machine-readable.',
      '',
      'GENERATED by tools/build-reference-clips.mts from reference/<slug>/notes.md, which',
      'is the source of truth. Never hand-edit this file: edit the notes.md heading and',
      'rebuild. CI runs the builder with --check and fails if the two disagree.',
      '',
      'It exists so the canon lab can embed the SAME four seconds of the SAME video the',
      'corpus was cut from, at foilkit.deckpal.app, with no media in the repository. The',
      'embed is for human eyes only — a YouTube iframe is cross-origin and no pixel can',
      'be read back out of it. The Gemini articulation passes and the frame-diff harness',
      'read local frames from reference/fetch-reference.sh instead. Two consumers, two',
      'paths; see tools/reference-clips/notes.ts for why they cannot be unified.',
      '',
      `${Object.keys(sortedSources).length} source videos, ${Object.keys(clips).length} pattern dirs, ${withClip} with a clip range.`,
      'A dir with null bounds has no clip recorded, and the pane says exactly that.',
      '',
      'These are citations of third-party video, not measurements of a printing. Neither',
      'this file nor anything else in the repository grants a right in that footage; see',
      'NOTICE and AGENTS.md F2.',
    ],
    version: 1,
    notesDigest: digestOf(sortedSources, clips),
    sources: sortedSources,
    clips,
  }
}

/** sha256 over the citation records only — never the prose, never the $doc. */
function digestOf(
  sources: Record<string, ReferenceSourceRecord>,
  clips: Record<string, ReferenceClipRecord>,
): string {
  return createHash('sha256').update(JSON.stringify({ sources, clips })).digest('hex')
}

/**
 * The second reader check. `reference/manifest.mjs` parses the same headings
 * for `fetch-reference.sh`'s plan, and a divergence between the two means one
 * of the committed artifacts no longer describes the notes.
 */
function crossCheck(clips: Record<string, ReferenceClipRecord>, manifest: ManifestLike): string[] {
  const problems: string[] = []
  const derived = manifest.derived ?? {}

  for (const slug of Object.keys(derived)) {
    if (clips[slug] === undefined) problems.push(`${slug}: MANIFEST.json carries it, reference/${slug}/notes.md does not`)
  }

  for (const [slug, clip] of Object.entries(clips)) {
    const d = derived[slug]
    if (d === undefined) {
      problems.push(`${slug}: parsed from notes.md, absent from MANIFEST.json — re-run reference/manifest.mjs build`)
      continue
    }
    if (d.source != null && d.source !== clip.videoId) {
      problems.push(`${slug}: notes.md cites ${clip.videoId}, MANIFEST.json says ${d.source}`)
    }
    if ((d.chapter ?? null) !== clip.chapter) {
      problems.push(`${slug}: chapter "${clip.chapter}" in notes.md, "${d.chapter}" in MANIFEST.json`)
    }
    // MANIFEST records `clip: null` for a noMedia dir and `{present:false}` for
    // one whose media is simply not on this machine, so read the BOUNDS rather
    // than the presence flag — the bounds are the thing the embed needs.
    const from = d.clip?.fromSec ?? null
    const to = d.clip?.toSec ?? null
    if (from !== clip.clipStart || to !== clip.clipEnd) {
      problems.push(
        `${slug}: clip ${clip.clipStart}s–${clip.clipEnd}s in notes.md, ${from}s–${to}s in MANIFEST.json`,
      )
    }
  }
  return problems
}

// ── Serialization ───────────────────────────────────────────────────────────
//
// Byte-deterministic, so `--check` is a comparison and not a coin toss. There
// is no clock anywhere in this builder — see `notesDigest`. Keys are inserted
// in sorted order above; `JSON.stringify` preserves that.

export function serializeReferenceClips(file: ReferenceClipsFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}
