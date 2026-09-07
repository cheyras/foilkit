// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The canon lab's reference pane: the real card, on video, looping.
//
// The corpus used to ship a 3.5-second `clip.webm` per pattern and this pane
// used to be a `<video>` tag pointed at it. Subtask 2 removed that media,
// because it was cut from other people's videos and foilkit cites rather than
// vendors (AGENTS.md F2), which left the pane an empty slot. This fills it from
// the SOURCE: the same seconds of the same video, embedded from YouTube, which
// also means every look a contributor takes is a real view for the creator.
// That is the point of doing it this way rather than a nearer-to-hand one.
//
// WHAT IT CANNOT DO. Nothing may read pixels out of this. A YouTube iframe is
// cross-origin and no browser API returns a frame from one. The Gemini
// articulation passes and the frame-diff harness read local frames from
// `reference/fetch-reference.sh` instead — two consumers, two paths, and the
// argument for why they cannot be unified is in `tools/reference-clips/notes.ts`.

import { useEffect, useMemo, useRef, useState } from 'react'
import { referenceClipFor, watchUrl, type ReferenceClip } from '@foilkit/patterns'
import { Chip } from '../ui.tsx'
import { createClipLoop, type ClipLoop } from './clipLoop.ts'
import { embedUrl, loadYtApi, type YtPlayerHandle } from './ytApi.ts'

/** `1257.5` → `20:57.5`, the way the notes write a timestamp. */
function stamp(seconds: number): string {
  const whole = Math.floor(seconds)
  const frac = seconds - whole
  const m = Math.floor(whole / 60)
  const s = whole % 60
  return `${m}:${String(s).padStart(2, '0')}${frac > 0 ? `.${Math.round(frac * 10)}` : ''}`
}

type Phase = 'idle' | 'loading' | 'playing' | 'failed'

/**
 * The credit line. It appears in every state, including the ones where nothing
 * plays, because attribution is not conditional on the embed working.
 *
 * Deliberately a plain credit and a link, and NOT a claim about permission.
 * Nobody has been asked yet, and a line reading "linked with permission" would
 * be a false statement about a real person on a public site.
 */
function Credit({ clip }: { clip: ReferenceClip }) {
  return (
    <p className="mt-[6px] text-[10px] leading-[14px] text-text-muted">
      Reference footage: <b className="font-semibold text-text-primary">{clip.source.creator}</b> —{' '}
      <a
        href={watchUrl(clip)}
        target="_blank"
        rel="noreferrer noopener"
        className="underline hover:text-text-primary"
      >
        {clip.source.title}
      </a>
      {clip.chapter !== null && <> · chapter {clip.chapter}</>}
      {clip.borrowedFrom !== null && (
        <> · borrowed from <b className="font-semibold">{clip.borrowedFrom}</b> — the nearest physical sheet</>
      )}
      . Embedded from the source; no footage is stored in this repository. Cited in{' '}
      <code>reference/{clip.slug}/notes.md</code>.
    </p>
  )
}

export function ReferencePane({ patternId }: { patternId: string }) {
  // MEMOISED, and it matters. `referenceClipFor` builds a fresh object every
  // call; an un-memoised one is a new dependency identity on every render, and
  // the effect below would tear its own player down a frame after building it.
  const clip = useMemo(() => referenceClipFor(patternId), [patternId])

  /**
   * ACTIVATION AND PHASE ARE TWO DIFFERENT THINGS, deliberately.
   *
   * `active` is the person's decision — it is what a click sets, and it is the
   * only thing the effect below keys on. `phase` is a report of how that
   * decision is going, and the effect WRITES it. Keying the effect on the phase
   * it sets is a loop that eats itself: the effect builds a player, reports
   * `playing`, and React tears the whole thing down again because a dependency
   * changed. That bug shipped in the first draft of this file and the E2E run
   * caught it — the pane rendered perfectly and never looped once.
   */
  const [active, setActive] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const playerRef = useRef<YtPlayerHandle | null>(null)
  const loopRef = useRef<ClipLoop | null>(null)

  const start = clip?.clipStart ?? null
  const end = clip?.clipEnd ?? null
  const hasRange = clip !== null && start !== null && end !== null

  // Switching pattern puts the embed away. Not cosmetic: the player is bound to
  // one video id and one range, and leaving it running would loop the PREVIOUS
  // pattern's footage beside the new pattern's render — the single most
  // misleading thing this pane could do.
  useEffect(() => {
    setActive(false)
    setPhase('idle')
    setError(null)
  }, [patternId])

  useEffect(() => {
    if (!active || start === null || end === null || clip === null) return
    let cancelled = false
    setPhase('loading')
    setError(null)

    void loadYtApi()
      .then((YT) => {
        const element = frameRef.current
        if (cancelled || element === null) return
        // Adopt the iframe we rendered rather than letting the API build one:
        // that is what keeps the nocookie domain a property of our markup.
        // See ytApi.ts § embedUrl.
        const player = new YT.Player(element, {
          events: {
            onReady: () => {
              if (cancelled) return
              playerRef.current = player
              loopRef.current = createClipLoop(player, { start, end })
              setPhase('playing')
            },
            onError: (event) => {
              if (cancelled) return
              // 100/101/150: the video is gone, or its owner forbade embedding.
              // Three of the five sources are from 2020-2022, so this is a real
              // eventuality rather than a defensive flourish, and the honest
              // answer is the link-out — which still works.
              setError(`YouTube refused to play this video here (error ${event.data}).`)
              setPhase('failed')
            },
          },
        })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setPhase('failed')
      })

    return () => {
      cancelled = true
      loopRef.current?.stop()
      loopRef.current = null
      playerRef.current?.destroy?.()
      playerRef.current = null
    }
    // Primitives only. See the note on `clip` being memoised.
  }, [active, clip, start, end])

  // ── Nothing to show ──────────────────────────────────────────────────────
  // Two different absences, and they are not the same claim. `none` has no
  // physical foil at all; a pattern with a citation but no recorded range has a
  // video somewhere and nobody wrote down which seconds. Saying so is the point
  // — an empty pane that does not explain itself reads as a broken one.
  if (clip === null) {
    return (
      <Shell>
        <p className="py-[14px] text-center text-[12px] text-text-muted">
          No physical reference — “none” is the plain-card baseline, and there is nothing to film.
        </p>
      </Shell>
    )
  }

  if (!hasRange) {
    return (
      <Shell>
        <p className="py-[10px] text-center text-[12px] text-text-muted">
          No reference clip recorded for <code>{clip.slug}</code>.
          {clip.chapter !== null && <> The chapter is cited; the seconds were never written down.</>}
        </p>
        <div className="flex justify-center">
          <a
            href={watchUrl(clip)}
            target="_blank"
            rel="noreferrer noopener"
            className="rounded-full border border-border-default bg-surface-tertiary px-[10px] py-[4px] text-[12px] text-text-muted hover:border-action-primary hover:text-text-primary"
          >
            Open the source video ↗
          </a>
        </div>
        <Credit clip={clip} />
      </Shell>
    )
  }

  const bounds = `${stamp(start)}–${stamp(end)} (${(end - start).toFixed(1)}s)`

  return (
    <Shell>
      <div className="relative mx-auto aspect-video w-full max-w-[440px] overflow-hidden rounded-md bg-[#101218]">
        {!active ? (
          // THE PLACEHOLDER IS LOCAL. The obvious one is the video's own
          // thumbnail from i.ytimg.com, and it would defeat the whole exercise:
          // that is a third-party request on page load wearing a different
          // hostname. This is our own markup and the datum's own text, and it
          // costs nobody a request until they ask for one.
          <button
            type="button"
            onClick={() => setActive(true)}
            data-testid="reference-activate"
            className="group flex h-full w-full flex-col items-center justify-center gap-[8px] px-[14px] text-center hover:bg-[#151824]"
          >
            <span className="flex h-[42px] w-[42px] items-center justify-center rounded-full border border-border-default bg-surface-secondary text-[15px] text-text-primary group-hover:border-action-primary group-hover:text-action-primary">
              ▶
            </span>
            <span className="text-[12px] font-semibold text-text-primary">Load the reference clip</span>
            <span className="text-[11px] leading-[15px] text-text-muted">
              {clip.source.title}
              {clip.chapter !== null && <> · {clip.chapter}</>}
              <br />
              loops {bounds}
            </span>
            <span className="text-[10px] leading-[14px] text-text-muted/80">
              Nothing is fetched from YouTube until you press this.
            </span>
          </button>
        ) : (
          <>
            <iframe
              ref={frameRef}
              key={`${clip.slug}:${start}`}
              title={`${clip.source.title} — ${clip.slug} reference clip`}
              src={embedUrl({ videoId: clip.source.videoId, start, origin: window.location.origin })}
              allow="autoplay; encrypted-media; picture-in-picture"
              referrerPolicy="strict-origin-when-cross-origin"
              className="h-full w-full border-0"
            />
            {phase === 'loading' && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#101218]/80 text-[12px] text-text-muted">
                loading the player…
              </div>
            )}
            {phase === 'failed' && (
              // The link and the bounds are what is left when the API does not
              // load — offline, blocked, or the video withdrawn. They are enough
              // to do the work by hand, which is the difference between a
              // degraded pane and a dead one.
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-[6px] bg-[#101218] px-[14px] text-center">
                <span className="text-[12px] text-amber-500/90">The embedded player is unavailable.</span>
                {error !== null && (
                  <span className="text-[11px] leading-[15px] text-text-muted">{error}.</span>
                )}
                <span className="text-[11px] leading-[15px] text-text-muted">
                  Watch {bounds} of the source directly:
                </span>
                <a
                  href={watchUrl(clip)}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="rounded-full border border-border-default bg-surface-tertiary px-[10px] py-[4px] text-[12px] text-text-primary hover:border-action-primary"
                >
                  Open at {stamp(start)} ↗
                </a>
              </div>
            )}
          </>
        )}
      </div>

      {/* A scrub-free control surface. There is no seek bar and no timeline on
          purpose: the clip is 3.5 seconds of one tilt sweep, and every control
          a person could want is "start it again" or "put it away". Scrubbing
          would only ever take them out of the range the notes cite. */}
      <div className="mt-[8px] flex flex-wrap items-center justify-center gap-[6px]">
        <span className="text-[11px] text-text-muted">loops {bounds}</span>
        {phase === 'playing' && (
          <Chip
            active={false}
            onClick={() => {
              try {
                playerRef.current?.seekTo(start, true)
              } catch {
                /* the loop will bring it back on its own */
              }
            }}
          >
            ↻ restart
          </Chip>
        )}
        {active && (
          <Chip
            active={false}
            onClick={() => {
              // `active` false is what runs the effect cleanup — the loop stops
              // and the player is destroyed, rather than being left polling an
              // iframe nobody is looking at.
              setActive(false)
              setPhase('idle')
              setError(null)
            }}
          >
            stop
          </Chip>
        )}
        <a
          href={watchUrl(clip)}
          target="_blank"
          rel="noreferrer noopener"
          className="shrink-0 rounded-full border border-border-default bg-surface-tertiary px-[10px] py-[4px] text-[12px] text-text-muted hover:border-action-primary hover:text-text-primary"
        >
          watch on YouTube ↗
        </a>
      </div>

      <Credit clip={clip} />
    </Shell>
  )
}

/** The pane's box, shared by every state so the layout does not jump. */
function Shell({ children }: { children: React.ReactNode }) {
  return <div data-testid="reference-pane">{children}</div>
}
