// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// Loading YouTube's IFrame Player API — once, on demand, never on page load.
//
// ── THE PRIVACY SHAPE, AND WHY IT IS THIS ONE ──────────────────────────────
//
// Nothing in this module runs until somebody clicks the reference pane. Until
// then the pane is a local placeholder — our own markup, our own colours, the
// video title and chapter as text — and the browser has made ZERO requests to
// any Google host. That is deliberate and it is the whole design:
//
//   * No auto-embed. An iframe in the markup fetches YouTube on page load for
//     every visitor of every pattern, including the ones who never look at the
//     reference. Click-to-activate makes the third-party request a thing a
//     person chose.
//   * No thumbnail either. The obvious placeholder is the video's own poster
//     from `i.ytimg.com`, and it would undo the whole point — that is a
//     third-party fetch on page load wearing a different hostname. The
//     placeholder is drawn locally instead, from the datum's own title and
//     chapter text, and it costs one request fewer than the thumbnail would.
//   * `youtube-nocookie.com` for the player itself (see `embedUrl`).
//
// ── WHY THE API SCRIPT STILL COMES FROM youtube.com ────────────────────────
//
// There is no nocookie copy of `iframe_api`. The script is served from
// `www.youtube.com` and that is the only place it exists, so activating the
// pane does contact youtube.com once, for the script, in addition to the
// nocookie host for the player. That is a real thing to know rather than a
// detail to bury: the nocookie domain narrows what the PLAYER stores, and it
// does not make the API script disappear. After a click, both are contacted;
// before one, neither is.

/** The tiny slice of the global the pane uses. The real API is far larger. */
export interface YtNamespace {
  Player: new (
    element: HTMLElement | string,
    config: {
      events?: {
        onReady?: (event: { target: YtPlayerHandle }) => void
        onError?: (event: { data: number }) => void
      }
    },
  ) => YtPlayerHandle
}

export interface YtPlayerHandle {
  getCurrentTime(): number
  seekTo(seconds: number, allowSeekAhead: boolean): void
  playVideo?(): void
  mute?(): void
  destroy?(): void
}

declare global {
  interface Window {
    YT?: YtNamespace
    onYouTubeIframeAPIReady?: () => void
  }
}

const API_SRC = 'https://www.youtube.com/iframe_api'

/**
 * How long to wait for the script before calling it unavailable.
 *
 * A blocked request does not always fail: a content blocker, a captive portal
 * or an offline tab can leave the fetch pending forever, and a promise that
 * never settles is a spinner that never stops. The pane needs an ANSWER so it
 * can fall back to the link-and-bounds text, so a timeout is the answer when
 * nothing else is.
 */
const LOAD_TIMEOUT_MS = 10_000

let pending: Promise<YtNamespace> | null = null

/**
 * Resolve with `window.YT` once the IFrame API is usable, or reject.
 *
 * Memoised: the API is a global and loading its script twice would clobber the
 * `onYouTubeIframeAPIReady` callback of whichever load was still in flight.
 * A REJECTION is not memoised — a contributor who was offline when they first
 * clicked should get a real attempt when they click again.
 */
export function loadYtApi(timeoutMs: number = LOAD_TIMEOUT_MS): Promise<YtNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT)
  if (pending !== null) return pending

  pending = new Promise<YtNamespace>((resolve, reject) => {
    const timer = setTimeout(() => {
      fail(new Error(`the YouTube IFrame API did not load within ${timeoutMs}ms`))
    }, timeoutMs)

    const done = (): void => {
      clearTimeout(timer)
    }
    const fail = (err: Error): void => {
      done()
      // Not memoised — see above.
      pending = null
      reject(err)
    }

    // The API announces itself by CALLING this global. Chain rather than
    // overwrite: nothing else on this page defines it today, and a future
    // second embed that does must not be silently disconnected by us.
    const previous = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      previous?.()
      done()
      if (window.YT?.Player) resolve(window.YT)
      else fail(new Error('the YouTube IFrame API loaded without a Player constructor'))
    }

    // A script tag already present means another load is in flight; wait on the
    // callback above rather than adding a second tag.
    if (document.querySelector(`script[src="${API_SRC}"]`) === null) {
      const script = document.createElement('script')
      script.src = API_SRC
      script.async = true
      script.onerror = () => fail(new Error('the YouTube IFrame API script could not be fetched'))
      document.head.appendChild(script)
    }
  })

  return pending
}

/** Test seam: forget any memoised load. Not used in the app. */
export function resetYtApiForTests(): void {
  pending = null
}

export interface EmbedUrlOptions {
  videoId: string
  /** Integer seconds. The iframe params take nothing else — see clipLoop.ts. */
  start: number
  /** The page origin, for the API's postMessage handshake. */
  origin: string
}

/**
 * The player url.
 *
 * `youtube-nocookie.com` rather than `youtube.com`: it is the domain Google
 * documents as not setting personalisation cookies until playback, and it is a
 * free improvement for a pane whose entire job is to show four seconds of
 * footage to one person tuning a shader.
 *
 * IT WORKS WITH THE JS API, and the way it is wired here is why. The IFrame API
 * offers a `host` option on `new YT.Player(...)` for exactly this, but that path
 * has the API build the url and leaves the domain to a parameter somebody can
 * drop. Instead the pane renders its OWN iframe at this url and hands the
 * already-loaded element to `new YT.Player(element)`, which adopts it and reads
 * the origin to talk to off the element's `src`. The nocookie domain is then a
 * property of markup this repository controls rather than of a config key.
 *
 * `enablejsapi=1` is what makes the element adoptable at all; without it the
 * player never answers `getCurrentTime` and the loop polls a corpse.
 * `mute=1` because a browser will not autoplay audible video — an unmuted
 * embed simply does not start. `playsinline=1` because review happens on
 * phones, and iOS otherwise takes the video fullscreen the moment it plays.
 *
 * `modestbranding` is NOT here. It is deprecated and does nothing; passing it
 * would only tell the next reader that somebody believed it worked. The pane
 * looks like a YouTube player, which is honest — it is one.
 */
export function embedUrl({ videoId, start, origin }: EmbedUrlOptions): string {
  const params = new URLSearchParams({
    enablejsapi: '1',
    origin,
    autoplay: '1',
    mute: '1',
    playsinline: '1',
    controls: '0',
    rel: '0',
    disablekb: '1',
    fs: '0',
    start: String(Math.max(0, Math.floor(start))),
  })
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?${params.toString()}`
}
