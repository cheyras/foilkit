// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// @foilkit/patterns — the reference corpus's citations, resolved per pattern.
//
// `reference-clips.json` next door is GENERATED from `reference/<slug>/notes.md`
// by `tools/build-reference-clips.mts`; CI's `--check` fails if it drifts. This
// file is the typed way in, and it does the one thing the raw datum cannot: it
// resolves a PATTERN id (which may be an alias, and may borrow another slug's
// footage) to the clip that pattern's reference actually is.
//
// ── WHAT THIS IS FOR, AND WHAT IT IS NOT FOR ───────────────────────────────
//
// FOR: putting a looping YouTube embed of the exact excerpt in front of a
// person tuning a shader, so they can compare their render against the real
// card on video without the repository shipping a frame of somebody else's
// footage (AGENTS.md F2). It also sends the creator real views, which is the
// point rather than a side effect.
//
// NOT FOR: any pass that needs PIXELS. A YouTube iframe is cross-origin; there
// is no browser API that returns a frame from it, and there will not be one.
// The Gemini articulation passes and the frame-diff harness read local frames
// produced by `reference/fetch-reference.sh` into gitignored `reference-media/`.
// Two consumers, two paths — the full argument is in the header of
// `tools/reference-clips/notes.ts`, and it is the note to read before trying to
// make either path serve the other.

import DATUM from './reference-clips.json' with { type: 'json' }
import { referenceSlug } from './canon-lookup.ts'

export interface ReferenceSource {
  videoId: string
  /** `https://youtu.be/<id>` — the citation as the corpus writes it. */
  url: string
  title: string
  creator: string
}

export interface ReferenceClip {
  /** The `reference/<slug>/` dir this citation came from. */
  slug: string
  source: ReferenceSource
  /** `"19:32 - 20:11"` as the notes write it, or null where none was recorded. */
  chapter: string | null
  /**
   * The tilt demo's bounds, in seconds from the START of the video.
   *
   * Fractional on purpose — `radiant-collection-dots` is 1257.5s–1261.0s — and
   * the player's `seekTo` takes floats, so nothing here is rounded. The URL
   * `t=` parameter and the iframe's `start`/`end` params take INTEGERS only;
   * that rounding happens at the edge, in `watchUrl`, not in the datum.
   *
   * Both null together means no clip was recorded for this dir. That is a real
   * state of the corpus, not a failure, and the pane says so out loud.
   */
  clipStart: number | null
  clipEnd: number | null
  /**
   * Set when this pattern has no reference dir of its own and borrows another's
   * footage — today only `reverse-sheet`, which models the stamped emblem sheet
   * and borrows `pokeball-masterball`. The pane must say so: a contributor
   * comparing a render against footage of a DIFFERENT pattern needs to know
   * that is what they are doing.
   */
  borrowedFrom: string | null
}

export const REFERENCE_CLIPS = DATUM

/** The sha256 the builder stamped over the citations. Changes iff a citation does. */
export const REFERENCE_CLIPS_DIGEST: string = DATUM.notesDigest

const SOURCES = DATUM.sources as Record<string, { url: string; title: string; creator: string }>
const CLIPS = DATUM.clips as Record<
  string,
  { videoId: string; chapter: string | null; clipStart: number | null; clipEnd: number | null }
>

/**
 * The reference citation for a pattern id, or null when the pattern has none.
 *
 * Null means one of two things and the caller does not need to tell them apart:
 * the pattern has no physical foil at all (`none`, the plain-card baseline), or
 * no dir in the corpus answers for it. Either way there is nothing to embed.
 *
 * A NON-null result with null bounds is different, and the caller DOES have to
 * tell that apart: there is a video and a chapter to link out to, but no clip
 * range was ever recorded, so there is nothing to loop.
 */
export function referenceClipFor(patternId: string): ReferenceClip | null {
  const slug = referenceSlug(patternId)
  if (slug === null) return null
  const clip = CLIPS[slug]
  if (clip === undefined) return null
  const source = SOURCES[clip.videoId]
  if (source === undefined) return null
  return {
    slug,
    source: { videoId: clip.videoId, ...source },
    chapter: clip.chapter,
    clipStart: clip.clipStart,
    clipEnd: clip.clipEnd,
    borrowedFrom: slug === patternId ? null : slug,
  }
}

/**
 * A link out to the video at the clip's start — the one that sends a real view
 * to the creator, which is why the pane has it at all.
 *
 * `t=` is INTEGER seconds. YouTube ignores a fractional value rather than
 * rounding it, so a link to `t=1257.5` silently starts at 0 — which is exactly
 * the kind of bug that looks like the creator's video is wrong. Floor rather
 * than round, so the link never lands past the start of the demo.
 */
export function watchUrl(clip: ReferenceClip): string {
  const at = clip.clipStart ?? chapterStartSeconds(clip.chapter)
  return at === null ? clip.source.url : `${clip.source.url}?t=${Math.floor(at)}`
}

/**
 * `"8:35 - 11:11"` → 515. The fallback for a dir with a chapter and no clip:
 * there is still somewhere useful to send a reader, and the top of the chapter
 * is it.
 */
export function chapterStartSeconds(chapter: string | null): number | null {
  if (chapter === null) return null
  const start = chapter.split(/[-–]/)[0]?.trim()
  if (start === undefined || start === '') return null
  const parts = start.split(':').map(Number)
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) return null
  return parts.reduce((a, b) => a * 60 + b, 0)
}
