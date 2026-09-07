// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The clip loop — a segment of a YouTube video, played over and over.
//
// ── WHY THIS IS NOT `loop=1` ───────────────────────────────────────────────
//
// The IFrame player takes `start` and `end`, and it takes `loop=1`. Together
// they do not do what they read like they do. `loop=1` requires
// `playlist=<VIDEO_ID>` to work at all in an embed, YouTube's own documentation
// calls its support in IFrame embeds limited, and what it actually does with a
// `start`/`end` pair is restart the WHOLE VIDEO rather than the segment. A
// contributor comparing a shader against 1173s–1176.5s of a 26-minute video
// would get 3.5 seconds of reference footage followed by the video's intro,
// forever.
//
// `start` and `end` are also INTEGER-only, and the corpus does not have integer
// bounds: `radiant-collection-dots` is 1257.5s–1261.0s and `shiny-vault` is
// 1160s–1163.5s. Rounding a bound to satisfy a parameter would put a different
// four seconds in front of a person than the one the notes say they are looking
// at, which is the kind of quiet inaccuracy this corpus exists to not have.
//
// So the loop is DRIVEN, from here: poll `getCurrentTime()`, and `seekTo` the
// start when playback passes the end. `seekTo` takes a float, so the fractional
// bounds survive; the integer `start` param is still passed in the iframe url,
// but only as the landing point before the first poll, and this loop corrects
// it to the real start on the first pass.
//
// ── WHY IT TOLERATES THE PLAYER MISBEHAVING ────────────────────────────────
//
// Every method here is a postMessage across an origin this code does not
// control. `getCurrentTime()` throws while the player is still booting, returns
// nonsense across a seek, and stops answering entirely if the iframe is torn
// out from under it. None of that may take the page down or leave a timer
// running, so every call is guarded and the loop re-arms itself if a seek does
// not land.

/** The slice of `YT.Player` this loop needs. Deliberately tiny, so a test can be one. */
export interface YtPlayerLike {
  getCurrentTime(): number
  seekTo(seconds: number, allowSeekAhead: boolean): void
}

export interface ClipLoopOptions {
  /** Seconds from the start of the video. Fractional. */
  start: number
  end: number
  /**
   * How often to look. 250ms is four checks a second: fast enough that the
   * overshoot past `end` is not visible on a 3.5-second clip, slow enough that
   * it is not a busy loop of cross-origin messages.
   */
  intervalMs?: number
  /** Injectable for tests. Defaults to the real timers. */
  schedule?: (fn: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
}

/**
 * How far BEFORE `start` playback may drift before the loop pulls it back.
 *
 * Not zero. The iframe's integer `start` param can legitimately land up to a
 * second early (1173.0s asked for, 1172.x delivered after keyframe snapping),
 * and treating that as an escape would seek on the very first tick of every
 * session — a visible stutter, for nothing.
 */
const BEFORE_SLACK_S = 1

/**
 * Ticks to wait for a seek to land before assuming it did not and trying again.
 *
 * A seek that is dropped — the player was buffering, the message was lost —
 * leaves the loop disarmed with playback past the end, which is silent failure:
 * the clip stops looping and nothing says why. Eight ticks is two seconds at
 * the default interval, long enough that a slow seek is never re-issued and
 * short enough that a dropped one is not a dead pane.
 */
const REARM_AFTER_TICKS = 8

export interface ClipLoop {
  /** One poll. Exported so a test drives the real logic without a clock. */
  tick(): void
  /** Idempotent. Safe to call after the player is already gone. */
  stop(): void
  /** True while the loop is willing to issue a seek. Diagnostics only. */
  readonly armed: boolean
  /** How many times the clip has been sent back to its start. */
  readonly loops: number
}

/**
 * Start looping `[start, end)` on `player`.
 *
 * The caller owns the player and must call `stop()` when it goes away —
 * React's effect cleanup, in the one place this is used.
 */
export function createClipLoop(player: YtPlayerLike, options: ClipLoopOptions): ClipLoop {
  const { start, end } = options
  const intervalMs = options.intervalMs ?? 250
  const schedule = options.schedule ?? ((fn, ms) => setInterval(fn, ms))
  const cancel = options.cancel ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>))

  let armed = true
  let sinceSeek = 0
  let loops = 0
  let stopped = false

  const tick = (): void => {
    if (stopped) return

    let t: number
    try {
      t = player.getCurrentTime()
    } catch {
      // The player is booting, or gone. Either way there is nothing to decide
      // on this tick, and a thrown getCurrentTime is a normal thing for a
      // cross-origin embed to do rather than an error to report.
      return
    }
    if (typeof t !== 'number' || !Number.isFinite(t)) return

    if (!armed) {
      // A seek is in flight. Re-arm when playback is genuinely back inside the
      // window — or when it has been too long and the seek clearly did not land.
      if (t >= start && t < end) {
        armed = true
        sinceSeek = 0
      } else if (++sinceSeek >= REARM_AFTER_TICKS) {
        armed = true
        sinceSeek = 0
      }
      return
    }

    if (t < end && t >= start - BEFORE_SLACK_S) return

    try {
      player.seekTo(start, true)
      loops++
    } catch {
      // A refused seek is not fatal: the next tick tries again, because `armed`
      // is only cleared on a seek that was actually accepted.
      return
    }
    armed = false
    sinceSeek = 0
  }

  const handle = schedule(tick, intervalMs)

  return {
    tick,
    stop() {
      if (stopped) return
      stopped = true
      cancel(handle)
    },
    get armed() {
      return armed
    },
    get loops() {
      return loops
    },
  }
}
