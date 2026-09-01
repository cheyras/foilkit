// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The upstream half of `/api/image`: URL algebra, a politeness gate, a polite
// fetch, and a warm-instance LRU. No HTTP handler, no runtime types, nothing
// Vercel-shaped — this file is what the tests exercise directly.
//
// ---------------------------------------------------------------------------
// WHY A PROXY EXISTS AT ALL
//
// Not for CORS. Measured 2026-09-01: `assets.tcgdex.net` DOES send
// `Access-Control-Allow-Origin: *` on asset GETs, with or without an `Origin`
// request header, and answers a preflight with `204` and
// `Access-Control-Allow-Methods: GET, OPTIONS`. A cross-origin
// `<img crossOrigin="anonymous">` therefore uploads as a WebGL texture without
// tainting the canvas. That question is settled; do not re-litigate it.
//
// The proxy ships anyway, for three reasons that hold whichever way that check
// had landed:
//
//   1. Not hammering a volunteer-run CDN every time a contributor scrubs
//      through a set. The gate below is that reason made mechanical.
//   2. Images keep working through an upstream outage or a URL-structure
//      change: one file changes here, not every recorded URL in the corpus.
//   3. Subtask 4's frame registry keys a card's framing on **source URL +
//      raster dimensions**. A proxy under our control is what keeps that key
//      stable when upstream re-encodes something — which is also why the
//      response carries `x-foilkit-upstream`, so the key is observable from
//      the response rather than inferred.
//
// ---------------------------------------------------------------------------
// NO TRANSCODE STAGE, EVER
//
// Bytes in, bytes out. This is a standing decision, not an omission and not a
// TODO. Two reasons. First, F3: the frame registry's key is the raster as
// upstream shipped it, and a re-encode silently changes the artifact the
// measurement was taken against. Second, a transcode makes this proxy a
// derivative-works machine over card scans we do not own (F2) — a cache that
// passes bytes through is a cache; one that re-renders them is a publisher.
// If a future need for a resized variant appears, it is a different endpoint
// with its own answer to both of those, not a flag on this one.

/** Upstream asset origin. The ONLY origin this module will ever construct. */
export const ASSETS_ORIGIN = 'https://assets.tcgdex.net';

/** Politeness budget, ported verbatim from DeckPal's `apps/images`. */
export const RATE_PER_SEC = 5;
export const MAX_CONCURRENCY = 2;

/**
 * Names the project and gives a human a place to complain. A volunteer CDN
 * operator who wants to rate-limit or block us should not have to guess who we
 * are — that courtesy is the same courtesy the token bucket is.
 */
export const USER_AGENT = 'foilkit/0.1 (+https://github.com/cheyras/foilkit)';

/**
 * These assets are immutable: the upstream URL contains the set, the card and
 * the quality, and a given URL's bytes do not change meaning. A year of
 * `immutable` is what makes the CDN in front of this function the real cache
 * (see `AssetCache` below).
 */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

// ---------------------------------------------------------------------------
// URL algebra + SSRF
// ---------------------------------------------------------------------------

/**
 * The upstream asset URL is
 *   `https://assets.tcgdex.net/{lang}/{serie}/{set}/{localId}/{quality}.webp`
 * (DeckPal `apps/images/src/layout.ts`). Five segments, no more, no fewer.
 *
 * The character class deliberately excludes `/`, `%`, `:` and everything else —
 * which is most of what an SSRF payload needs — so a segment that matches this
 * cannot carry a path separator or an encoded one.
 */
const UPSTREAM_PATH_RE =
  /^[A-Za-z]{2}\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/(?:low|high)\.webp$/;

const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const LANG_RE = /^[A-Za-z]{2}$/;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export type ResolveResult =
  | { ok: true; url: string; path: string }
  | { ok: false; reason: string };

/**
 * Resolve a caller's query into an upstream URL, or refuse.
 *
 * **SSRF is closed by construction, not by an allow-list check bolted on
 * afterwards.** This function has exactly one place where a URL comes into
 * existence — the `${ASSETS_ORIGIN}/${path}` template at the bottom — and
 * `path` reaches it only after matching `UPSTREAM_PATH_RE`. A caller-supplied
 * origin is never forwarded, never rewritten, never trusted. That is the whole
 * defence, and it is one line long on purpose: an allow-list you can only
 * verify by reading five branches is an allow-list somebody will eventually
 * add a sixth branch to.
 *
 * Two accepted input forms:
 *   `p`   — the path alone, e.g. `en/base/base1/4/high.webp`
 *   `src` — a full URL, accepted ONLY if it parses, its origin is exactly
 *           ASSETS_ORIGIN, and its pathname reduces to a `path` that passes the
 *           same regex. This form exists so the editor can pass through the
 *           source URL it recorded, which is what keeps the frame registry's
 *           key (source URL + raster dimensions) the same string on both sides.
 *
 * Rejection reasons are written by this function and never contain a byte the
 * caller supplied, so a handler can put one straight into a response body
 * without an escaping question.
 */
export function resolveUpstream(query: { p?: string; src?: string }): ResolveResult {
  const p = typeof query.p === 'string' && query.p.length > 0 ? query.p : undefined;
  const src = typeof query.src === 'string' && query.src.length > 0 ? query.src : undefined;

  if (p !== undefined && src !== undefined) {
    return { ok: false, reason: "pass exactly one of 'p' or 'src', not both" };
  }

  let path: string;

  if (p !== undefined) {
    // A path parameter that looks like a URL is either a mistake or a probe.
    // Refusing it outright beats letting it fall through to the regex, because
    // the reason a human reads should name what they actually did.
    if (SCHEME_RE.test(p) || p.startsWith('//')) {
      return { ok: false, reason: "'p' must be an upstream path, not a URL — use 'src' for a URL" };
    }
    path = stripLeadingSlashes(p);
  } else if (src !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(src);
    } catch {
      return { ok: false, reason: "'src' is not a parseable absolute URL" };
    }
    // `URL.origin` folds scheme, host, port and default-port normalisation into
    // one comparison, so `http://`, a userinfo host, a port, an IP literal and
    // a look-alike hostname all fail here rather than needing four checks.
    if (parsed.origin !== ASSETS_ORIGIN) {
      return { ok: false, reason: `'src' origin is not ${ASSETS_ORIGIN}` };
    }
    if (parsed.username !== '' || parsed.password !== '') {
      return { ok: false, reason: "'src' must not carry userinfo credentials" };
    }
    path = stripLeadingSlashes(parsed.pathname);
  } else {
    return { ok: false, reason: "missing required query parameter: 'p' or 'src'" };
  }

  const segments = path.split('/');
  if (segments.length !== 5) {
    return {
      ok: false,
      reason: `expected 5 path segments (lang/serie/set/localId/quality.webp), got ${segments.length}`,
    };
  }

  for (const segment of segments) {
    if (segment === '') return { ok: false, reason: 'path contains an empty segment' };
    // `.` and `..` match SEGMENT_RE (dot is a legal character in a set id like
    // `sv03.5`), so traversal has to be refused by name, not by character class.
    if (segment === '.' || segment === '..') {
      return { ok: false, reason: "path contains a '.' or '..' traversal segment" };
    }
    // A `%` can only be an encoded something — and the one thing worth encoding
    // here is a separator or a dot-segment. There is no legitimate percent in
    // an upstream asset path.
    if (segment.includes('%')) {
      return { ok: false, reason: 'path contains a percent-encoded character' };
    }
    if (!SEGMENT_RE.test(segment)) {
      return { ok: false, reason: 'path segment contains a character outside [A-Za-z0-9._-]' };
    }
  }

  if (!LANG_RE.test(segments[0]!)) {
    return { ok: false, reason: 'first segment must be a two-letter language code' };
  }
  if (segments[4] !== 'low.webp' && segments[4] !== 'high.webp') {
    return { ok: false, reason: "last segment must be 'low.webp' or 'high.webp'" };
  }

  // Belt and braces. Everything above produces a specific reason for a human;
  // THIS is the gate. Nothing reaches the template without passing it.
  if (!UPSTREAM_PATH_RE.test(path)) {
    return { ok: false, reason: 'path does not match the upstream asset shape' };
  }

  return { ok: true, url: `${ASSETS_ORIGIN}/${path}`, path };
}

function stripLeadingSlashes(text: string): string {
  let i = 0;
  while (i < text.length && text[i] === '/') i++;
  return text.slice(i);
}

// ---------------------------------------------------------------------------
// Politeness gate
// ---------------------------------------------------------------------------

/**
 * The gate's view of time. Injectable so a test can drive the rate limiter on a
 * virtual clock — a rate limiter verified by sleeping for real seconds is a
 * rate limiter nobody runs in CI, and one nobody runs is one that rots.
 */
export interface Clock {
  now(): number;
  schedule(fn: () => void, ms: number): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  schedule: (fn, ms) => {
    const handle: unknown = setTimeout(fn, ms);
    // Do not hold a serverless instance open on a re-check timer. Any request
    // actually waiting on the gate is already holding the loop through its own
    // promise, so unref'ing this costs nothing.
    if (handle !== null && typeof handle === 'object' && 'unref' in handle) {
      (handle as { unref(): void }).unref();
    }
  },
};

/**
 * Token-bucket-ish gate, ported from DeckPal `apps/images/src/fetch.ts`: at
 * most `ratePerSec` starts per rolling second and at most `maxConcurrency` in
 * flight. Made a class rather than module state so a test gets a fresh one and
 * so a future second upstream can have its own budget.
 */
export class PolitenessGate {
  readonly #clock: Clock;
  readonly #ratePerSec: number;
  readonly #maxConcurrency: number;
  #inFlight = 0;
  #recentStarts: number[] = [];
  #waiters: Array<() => void> = [];
  #pumpScheduled = false;

  constructor(
    options: { clock?: Clock; ratePerSec?: number; maxConcurrency?: number } = {},
  ) {
    this.#clock = options.clock ?? realClock;
    this.#ratePerSec = options.ratePerSec ?? RATE_PER_SEC;
    this.#maxConcurrency = options.maxConcurrency ?? MAX_CONCURRENCY;
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  get waiting(): number {
    return this.#waiters.length;
  }

  acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
      this.#pump();
    });
  }

  release(): void {
    this.#inFlight--;
    this.#pump();
  }

  #pump(): void {
    while (this.#waiters.length > 0) {
      const now = this.#clock.now();
      this.#recentStarts = this.#recentStarts.filter((t) => now - t < 1000);
      if (this.#inFlight < this.#maxConcurrency && this.#recentStarts.length < this.#ratePerSec) {
        this.#inFlight++;
        this.#recentStarts.push(now);
        // Resolving a promise queues a microtask; it never re-enters this loop
        // synchronously, so the counters above stay consistent.
        this.#waiters.shift()!();
        continue;
      }
      // Blocked. Re-check when the oldest start ages out of the window (rate
      // bound) or shortly (concurrency bound, which only a release can clear).
      if (this.#pumpScheduled) return;
      const wait =
        this.#recentStarts.length >= this.#ratePerSec
          ? 1000 - (now - this.#recentStarts[0]!) + 5
          : 25;
      this.#pumpScheduled = true;
      this.#clock.schedule(() => {
        this.#pumpScheduled = false;
        this.#pump();
      }, Math.max(5, wait));
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Warm-instance LRU
// ---------------------------------------------------------------------------

export interface CachedAsset {
  body: Uint8Array;
  contentType: string;
  etag: string | null;
}

export const MAX_ENTRIES = 64;
export const MAX_BYTES = 16 * 1024 * 1024;

/**
 * A per-instance in-memory LRU keyed by the resolved upstream URL.
 *
 * BE HONEST ABOUT WHAT THIS IS. It is not DeckPal's on-disk store. A Vercel
 * function has no persistent disk and no shared memory: this map lives inside
 * one warm instance, dies with it, and is not shared with the instance next to
 * it. **The real cache is the Vercel CDN in front of the function** — that is
 * what `Cache-Control: public, max-age=31536000, immutable` buys, and it is
 * what keeps the volunteer CDN unhammered at scale. This map only helps when
 * one warm instance serves the same card twice before the CDN has the answer.
 *
 * Sized accordingly: 64 entries / 16 MB is a scrub through one set's worth of
 * high-quality scans, not a corpus.
 */
export class AssetCache {
  readonly #entries = new Map<string, CachedAsset>();
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  #bytes = 0;

  constructor(options: { maxEntries?: number; maxBytes?: number } = {}) {
    this.#maxEntries = options.maxEntries ?? MAX_ENTRIES;
    this.#maxBytes = options.maxBytes ?? MAX_BYTES;
  }

  get size(): number {
    return this.#entries.size;
  }

  get bytes(): number {
    return this.#bytes;
  }

  has(url: string): boolean {
    return this.#entries.has(url);
  }

  get(url: string): CachedAsset | undefined {
    const found = this.#entries.get(url);
    if (found === undefined) return undefined;
    // Map iterates in insertion order, so delete + re-set IS the recency bump.
    this.#entries.delete(url);
    this.#entries.set(url, found);
    return found;
  }

  set(url: string, entry: CachedAsset): void {
    // An entry that cannot fit is not cached at all, rather than cached after
    // evicting everything else to make room it still does not have.
    if (entry.body.byteLength > this.#maxBytes) return;

    const existing = this.#entries.get(url);
    if (existing !== undefined) {
      this.#bytes -= existing.body.byteLength;
      this.#entries.delete(url);
    }
    this.#entries.set(url, entry);
    this.#bytes += entry.body.byteLength;

    while (this.#entries.size > this.#maxEntries || this.#bytes > this.#maxBytes) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      // Never evict the entry we just admitted; the guard above means we do not
      // have to.
      if (oldest.value === url) break;
      const victim = this.#entries.get(oldest.value)!;
      this.#bytes -= victim.body.byteLength;
      this.#entries.delete(oldest.value);
    }
  }

  delete(url: string): void {
    const existing = this.#entries.get(url);
    if (existing === undefined) return;
    this.#bytes -= existing.body.byteLength;
    this.#entries.delete(url);
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }
}

// ---------------------------------------------------------------------------
// The polite fetch
// ---------------------------------------------------------------------------

/** Only the parts of a `Response` this module reads. */
export interface UpstreamResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<UpstreamResponse>;

const realFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

export type FetchResult =
  | { status: 'ok'; body: Uint8Array; contentType: string; etag: string | null; fromCache: boolean }
  | { status: 'not-modified' }
  | { status: 'rejected'; reason: string; httpStatus: number; contentType: string | null }
  | { status: 'error'; reason: string; httpStatus: number };

export interface FetchAssetOptions {
  /** The caller's `if-none-match`, passed straight through to upstream. */
  etag?: string | null;
  fetchImpl?: FetchLike;
  gate?: PolitenessGate;
  /** `null` opts out of the warm-instance cache entirely (used by tests). */
  cache?: AssetCache | null;
  timeoutMs?: number;
  expectedType?: string;
}

/** The process-wide defaults, shared by every request a warm instance serves. */
export const defaultGate = new PolitenessGate();
export const defaultCache = new AssetCache();

/**
 * Fetch one upstream asset politely, and refuse anything that is not actually a
 * WebP.
 *
 * The two refusals are the whole reason this is a ported function rather than a
 * one-line `fetch`:
 *
 *   THE SOFT-404 TRAP. The origin answers an unsupported extension with HTTP
 *   **200** and a ~299-byte `text/html` error page. Trusting the status code
 *   alone caches garbage and — here — would hand the editor an HTML document to
 *   upload as a WebGL texture. A body whose `content-type` is not `image/webp`
 *   is REJECTED, and a rejection is never admitted to the cache.
 *
 *   THE MAGIC BYTES. Defence in depth against a correct-looking header over a
 *   wrong body: a WebP is a RIFF container, `RIFF` at offset 0 and `WEBP` at
 *   offset 8. Anything else is rejected on the same terms.
 *
 * A rejection is deliberately NOT a 404 at the HTTP layer (see `functions/image.ts`):
 * "this card has no scan" and "upstream handed us something wrong" are
 * different facts and a contributor triaging a blank editor needs to tell them
 * apart.
 */
export async function fetchAsset(
  url: string,
  options: FetchAssetOptions = {},
): Promise<FetchResult> {
  const {
    etag = null,
    fetchImpl = realFetch,
    gate = defaultGate,
    cache = defaultCache,
    timeoutMs = 20_000,
    expectedType = 'image/webp',
  } = options;

  if (cache !== null) {
    const hit = cache.get(url);
    if (hit !== undefined) {
      // These assets are immutable, so a warm hit IS the current answer. If the
      // caller's validator already matches it, say so and send no bytes.
      if (etag !== null && hit.etag !== null && etag === hit.etag) {
        return { status: 'not-modified' };
      }
      return {
        status: 'ok',
        body: hit.body,
        contentType: hit.contentType,
        etag: hit.etag,
        fromCache: true,
      };
    }
  }

  await gate.acquire();
  try {
    const headers: Record<string, string> = { 'user-agent': USER_AGENT };
    if (etag !== null) headers['if-none-match'] = etag;

    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const contentType = response.headers.get('content-type');

    if (response.status === 304) return { status: 'not-modified' };

    if (!response.ok) {
      // Drain so the socket goes back to the pool rather than being torn down.
      await response.arrayBuffer().catch(() => undefined);
      return {
        status: 'error',
        reason: `upstream returned HTTP ${response.status}`,
        httpStatus: response.status,
      };
    }

    if (contentType === null || !contentType.toLowerCase().startsWith(expectedType)) {
      await response.arrayBuffer().catch(() => undefined);
      return {
        status: 'rejected',
        reason: `upstream content-type '${contentType ?? '(none)'}' is not ${expectedType} (soft-404 trap)`,
        httpStatus: response.status,
        contentType,
      };
    }

    const body = new Uint8Array(await response.arrayBuffer());
    if (!isRiffWebp(body)) {
      return {
        status: 'rejected',
        reason: `upstream body is not a RIFF/WEBP container (${body.byteLength} bytes)`,
        httpStatus: response.status,
        contentType,
      };
    }

    const responseEtag = response.headers.get('etag');
    // Only a body that survived BOTH refusals is ever admitted.
    if (cache !== null) {
      cache.set(url, { body, contentType, etag: responseEtag });
    }
    return { status: 'ok', body, contentType, etag: responseEtag, fromCache: false };
  } catch (error) {
    return {
      status: 'error',
      reason: error instanceof Error ? error.message : 'upstream fetch failed',
      httpStatus: 0,
    };
  } finally {
    gate.release();
  }
}

/** `RIFF` at offset 0, `WEBP` at offset 8 — the WebP container signature. */
export function isRiffWebp(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false;
  return (
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  );
}
