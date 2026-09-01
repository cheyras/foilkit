// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Chey Rasmussen
//
// The upstream half of `/api/image`, exercised without a network and without a
// clock. Every fetch here is injected and every millisecond is virtual: the
// politeness gate is the one piece of this module whose bug only shows up under
// load, so the test that proves it has to be one CI will actually run.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ASSETS_ORIGIN,
  AssetCache,
  MAX_CONCURRENCY,
  PolitenessGate,
  RATE_PER_SEC,
  fetchAsset,
  isRiffWebp,
  resolveUpstream,
  type CachedAsset,
  type Clock,
  type FetchAssetOptions,
  type FetchLike,
  type FetchResult,
  type UpstreamResponse,
} from './upstream.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GOOD_PATH = 'en/base/base1/4/high.webp';
const GOOD_URL = `${ASSETS_ORIGIN}/${GOOD_PATH}`;

/** A minimal RIFF/WEBP container: `RIFF` … `WEBP` plus filler. */
function webpBytes(byteLength = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(12, byteLength));
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  return bytes;
}

function response(init: {
  status?: number;
  contentType?: string | null;
  etag?: string | null;
  body?: Uint8Array | string;
}): UpstreamResponse {
  const status = init.status ?? 200;
  const headers = new Map<string, string>();
  if (init.contentType != null) headers.set('content-type', init.contentType);
  if (init.etag != null) headers.set('etag', init.etag);
  const body =
    typeof init.body === 'string' ? new TextEncoder().encode(init.body) : (init.body ?? webpBytes());
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  };
}

/** Records every call, answers from a queue or a constant. */
function recordingFetch(make: (url: string, n: number) => UpstreamResponse): {
  impl: FetchLike;
  calls: Array<{ url: string; headers: Record<string, string> }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, headers: { ...init.headers } });
    return make(url, calls.length);
  };
  return { impl, calls };
}

/**
 * A virtual clock. `advance` fires every timer that comes due, moving `now` to
 * each timer's own deadline as it goes, so a timer that schedules another timer
 * inside the same advance still sees a consistent `now`.
 */
function virtualClock(): {
  clock: Clock;
  advance(ms: number): void;
  now(): number;
  pending(): number;
} {
  let t = 0;
  let timers: Array<{ at: number; fn: () => void }> = [];
  return {
    clock: {
      now: () => t,
      schedule: (fn, ms) => {
        timers.push({ at: t + ms, fn });
      },
    },
    now: () => t,
    pending: () => timers.length,
    advance(ms) {
      const target = t + ms;
      for (let guard = 0; guard < 10_000; guard++) {
        const due = timers.filter((timer) => timer.at <= target);
        if (due.length === 0) break;
        due.sort((a, b) => a.at - b.at);
        const next = due[0]!;
        timers = timers.filter((timer) => timer !== next);
        t = Math.max(t, next.at);
        next.fn();
      }
      t = target;
    },
  };
}

/** Let every already-resolved promise settle, without advancing virtual time. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * `fetchAsset` with a gate that cannot block. The tests below are about the two
 * refusals and the cache, not about the budget — and sharing the module's
 * `defaultGate` would make them wait out a real rolling second for no reason.
 * The budget gets its own suite, on a virtual clock, further down.
 */
function probe(url: string, options: FetchAssetOptions = {}): Promise<FetchResult> {
  return fetchAsset(url, {
    gate: new PolitenessGate({
      ratePerSec: Number.POSITIVE_INFINITY,
      maxConcurrency: Number.POSITIVE_INFINITY,
    }),
    ...options,
  });
}

// ---------------------------------------------------------------------------
// resolveUpstream — SSRF is the risk, and it is closed by construction
// ---------------------------------------------------------------------------

describe('resolveUpstream', () => {
  it('accepts a well-formed path and constructs the upstream URL itself', () => {
    const result = resolveUpstream({ p: GOOD_PATH });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.url, GOOD_URL);
    assert.equal(result.ok && result.path, GOOD_PATH);
  });

  it('accepts a leading slash on p, and a low-quality path', () => {
    assert.equal(resolveUpstream({ p: `/${GOOD_PATH}` }).ok, true);
    const low = resolveUpstream({ p: 'en/base/base1/4/low.webp' });
    assert.equal(low.ok && low.url, `${ASSETS_ORIGIN}/en/base/base1/4/low.webp`);
  });

  it('accepts a set id containing a dot, which is why "." cannot be a character check', () => {
    const result = resolveUpstream({ p: 'en/sv/sv03.5/12/high.webp' });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.url, `${ASSETS_ORIGIN}/en/sv/sv03.5/12/high.webp`);
  });

  it('accepts a full src URL on the asset origin', () => {
    const result = resolveUpstream({ src: GOOD_URL });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.url, GOOD_URL);
    assert.equal(result.ok && result.path, GOOD_PATH);
  });

  it('rejects a src on a different origin', () => {
    for (const src of [
      'https://evil.example.com/en/base/base1/4/high.webp',
      'http://assets.tcgdex.net/en/base/base1/4/high.webp', // scheme downgrade
      'https://assets.tcgdex.net.evil.example/en/base/base1/4/high.webp',
      'https://assets.tcgdex.net:8443/en/base/base1/4/high.webp',
      'https://user:pass@evil.example/en/base/base1/4/high.webp',
      'file:///etc/passwd',
      'http://169.254.169.254/latest/meta-data/',
    ]) {
      const result = resolveUpstream({ src });
      assert.equal(result.ok, false, `expected rejection for ${src}`);
    }
  });

  it('rejects a src that does not parse', () => {
    const result = resolveUpstream({ src: 'not a url at all' });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /parseable/);
  });

  it('rejects a ".." traversal segment', () => {
    const result = resolveUpstream({ p: 'en/base/../../../etc/passwd' });
    assert.equal(result.ok, false);
  });

  it('rejects a ".." traversal that stays five segments long', () => {
    const result = resolveUpstream({ p: 'en/base/../4/high.webp' });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /traversal|segments/);
  });

  it('rejects a %2e%2e encoded traversal in p', () => {
    const result = resolveUpstream({ p: 'en/base/%2e%2e/4/high.webp' });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /percent-encoded/);
  });

  it('rejects a %2e%2e encoded traversal in src', () => {
    // WHATWG URL treats `%2e%2e` as a double-dot path segment and collapses it,
    // so this one is refused by segment count rather than by the `%` check.
    // Either way it never reaches the template — assert the OUTCOME, not the route.
    const result = resolveUpstream({
      src: `${ASSETS_ORIGIN}/en/base/%2e%2e/%2e%2e/etc/passwd/high.webp`,
    });
    assert.equal(result.ok, false);
  });

  it('rejects an encoded slash, which would otherwise smuggle a segment', () => {
    const result = resolveUpstream({ p: 'en/base/base1%2f..%2f4/x/high.webp' });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /percent-encoded/);
  });

  it('rejects an absolute URL smuggled into p', () => {
    for (const p of [
      'https://evil.example.com/en/base/base1/4/high.webp',
      'http://evil.example.com/a/b/c/high.webp',
      '//evil.example.com/en/base/base1/4/high.webp',
      'file:///etc/passwd',
    ]) {
      const result = resolveUpstream({ p });
      assert.equal(result.ok, false, `expected rejection for ${p}`);
    }
  });

  it('rejects a missing quality segment (four segments)', () => {
    const result = resolveUpstream({ p: 'en/base/base1/4' });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /5 path segments.*got 4/);
  });

  it('rejects six segments', () => {
    const result = resolveUpstream({ p: 'en/base/base1/4/extra/high.webp' });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /5 path segments.*got 6/);
  });

  it('rejects an unexpected extension', () => {
    for (const p of [
      'en/base/base1/4/high.png',
      'en/base/base1/4/high.avif',
      'en/base/base1/4/high.jpg',
      'en/base/base1/4/high.webp.png',
      'en/base/base1/4/medium.webp',
      'en/base/base1/4/high',
    ]) {
      const result = resolveUpstream({ p });
      assert.equal(result.ok, false, `expected rejection for ${p}`);
    }
  });

  it('rejects a non-two-letter language segment', () => {
    assert.equal(resolveUpstream({ p: 'eng/base/base1/4/high.webp' }).ok, false);
    assert.equal(resolveUpstream({ p: '1n/base/base1/4/high.webp' }).ok, false);
  });

  it('rejects an empty segment', () => {
    const result = resolveUpstream({ p: 'en//base1/4/high.webp' });
    assert.equal(result.ok, false);
  });

  it('rejects nothing at all, and rejects both at once', () => {
    assert.match(resolveUpstream({}).ok ? '' : (resolveUpstream({}) as { reason: string }).reason, /missing required/);
    const both = resolveUpstream({ p: GOOD_PATH, src: GOOD_URL });
    assert.equal(both.ok, false);
    assert.match(both.ok ? '' : both.reason, /exactly one/);
  });

  it('never puts caller bytes into a rejection reason', () => {
    const marker = 'CALLER-SUPPLIED-MARKER';
    const result = resolveUpstream({ p: `en/base/${marker}/4/high.png` });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? true : result.reason.includes(marker), false);
  });
});

// ---------------------------------------------------------------------------
// fetchAsset — the two refusals that are the reason this is a ported function
// ---------------------------------------------------------------------------

describe('fetchAsset refusals', () => {
  it('rejects the soft-404: HTTP 200 with a text/html error page', async () => {
    const cache = new AssetCache();
    const { impl, calls } = recordingFetch(() =>
      response({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<html><body>Unsupported extension</body></html>',
      }),
    );

    const result = await probe(GOOD_URL, { fetchImpl: impl, cache });

    assert.equal(result.status, 'rejected');
    assert.equal(result.status === 'rejected' && result.httpStatus, 200);
    assert.match(result.status === 'rejected' ? result.reason : '', /soft-404/);
    assert.equal(calls.length, 1);
    // The whole point: a 200 that is not a WebP must not be admitted.
    assert.equal(cache.has(GOOD_URL), false);
    assert.equal(cache.size, 0);
    assert.equal(cache.bytes, 0);
  });

  it('rejects a 200 with no content-type at all', async () => {
    const cache = new AssetCache();
    const { impl } = recordingFetch(() => response({ status: 200, contentType: null }));
    const result = await probe(GOOD_URL, { fetchImpl: impl, cache });
    assert.equal(result.status, 'rejected');
    assert.equal(cache.size, 0);
  });

  it('rejects image/webp bytes that are not a RIFF container', async () => {
    const cache = new AssetCache();
    const { impl } = recordingFetch(() =>
      response({
        status: 200,
        contentType: 'image/webp',
        body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]), // PNG
      }),
    );

    const result = await probe(GOOD_URL, { fetchImpl: impl, cache });

    assert.equal(result.status, 'rejected');
    assert.match(result.status === 'rejected' ? result.reason : '', /RIFF\/WEBP/);
    assert.equal(cache.has(GOOD_URL), false);
  });

  it('rejects a body too short to carry the signature', async () => {
    const { impl } = recordingFetch(() =>
      response({ status: 200, contentType: 'image/webp', body: new Uint8Array([0x52, 0x49]) }),
    );
    const result = await probe(GOOD_URL, { fetchImpl: impl, cache: null });
    assert.equal(result.status, 'rejected');
  });

  it('reports an upstream 404 as an error carrying the status', async () => {
    const cache = new AssetCache();
    const { impl } = recordingFetch(() =>
      response({ status: 404, contentType: 'text/plain', body: 'not found' }),
    );
    const result = await probe(GOOD_URL, { fetchImpl: impl, cache });
    assert.equal(result.status, 'error');
    assert.equal(result.status === 'error' && result.httpStatus, 404);
    assert.equal(cache.size, 0);
  });

  it('reports a thrown fetch as an error with status 0', async () => {
    const impl: FetchLike = async () => {
      throw new Error('ECONNRESET');
    };
    const result = await probe(GOOD_URL, { fetchImpl: impl, cache: null });
    assert.equal(result.status, 'error');
    assert.equal(result.status === 'error' && result.httpStatus, 0);
    assert.equal(result.status === 'error' && result.reason, 'ECONNRESET');
  });

  it('isRiffWebp accepts a real container and refuses near-misses', () => {
    assert.equal(isRiffWebp(webpBytes()), true);
    assert.equal(isRiffWebp(new Uint8Array(11)), false);
    const riffButNotWebp = webpBytes();
    riffButNotWebp[8] = 0x41; // 'A' — RIFF, but an AVI rather than a WEBP
    assert.equal(isRiffWebp(riffButNotWebp), false);
  });
});

// ---------------------------------------------------------------------------
// fetchAsset — success, cache and validators
// ---------------------------------------------------------------------------

describe('fetchAsset success path', () => {
  it('accepts a well-formed WebP, retains it, and does not re-fetch it', async () => {
    const cache = new AssetCache();
    const { impl, calls } = recordingFetch(() =>
      response({ status: 200, contentType: 'image/webp', etag: '"abc"', body: webpBytes(128) }),
    );

    const first = await probe(GOOD_URL, { fetchImpl: impl, cache });
    assert.equal(first.status, 'ok');
    assert.equal(first.status === 'ok' && first.fromCache, false);
    assert.equal(first.status === 'ok' && first.etag, '"abc"');
    assert.equal(first.status === 'ok' && first.body.byteLength, 128);
    assert.equal(cache.has(GOOD_URL), true);
    assert.equal(cache.bytes, 128);

    const second = await probe(GOOD_URL, { fetchImpl: impl, cache });
    assert.equal(second.status, 'ok');
    assert.equal(second.status === 'ok' && second.fromCache, true);
    // The assertion that matters: the warm instance did NOT touch upstream again.
    assert.equal(calls.length, 1);
  });

  it('sends if-none-match upstream and passes a 304 straight back', async () => {
    const { impl, calls } = recordingFetch(() => response({ status: 304, contentType: null }));

    const result = await probe(GOOD_URL, {
      fetchImpl: impl,
      cache: null,
      etag: '"xyz"',
    });

    assert.equal(result.status, 'not-modified');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.headers['if-none-match'], '"xyz"');
    assert.match(calls[0]!.headers['user-agent'] ?? '', /^foilkit\//);
  });

  it('omits if-none-match when the caller sent none', async () => {
    const { impl, calls } = recordingFetch(() =>
      response({ status: 200, contentType: 'image/webp' }),
    );
    await probe(GOOD_URL, { fetchImpl: impl, cache: null });
    assert.equal('if-none-match' in calls[0]!.headers, false);
  });

  it('answers 304 from the warm cache when the validator matches', async () => {
    const cache = new AssetCache();
    const { impl, calls } = recordingFetch(() =>
      response({ status: 200, contentType: 'image/webp', etag: '"v1"' }),
    );

    await probe(GOOD_URL, { fetchImpl: impl, cache });
    const revalidated = await probe(GOOD_URL, { fetchImpl: impl, cache, etag: '"v1"' });

    assert.equal(revalidated.status, 'not-modified');
    assert.equal(calls.length, 1);
  });

  it('serves the cached body when the caller presents a stale validator', async () => {
    const cache = new AssetCache();
    const { impl, calls } = recordingFetch(() =>
      response({ status: 200, contentType: 'image/webp', etag: '"v2"' }),
    );

    await probe(GOOD_URL, { fetchImpl: impl, cache });
    const stale = await probe(GOOD_URL, { fetchImpl: impl, cache, etag: '"v1"' });

    assert.equal(stale.status, 'ok');
    assert.equal(stale.status === 'ok' && stale.fromCache, true);
    assert.equal(calls.length, 1);
  });

  it('keys the cache on the URL, so a different card is a different fetch', async () => {
    const cache = new AssetCache();
    const { impl, calls } = recordingFetch(() =>
      response({ status: 200, contentType: 'image/webp' }),
    );
    await probe(`${ASSETS_ORIGIN}/en/base/base1/4/high.webp`, { fetchImpl: impl, cache });
    await probe(`${ASSETS_ORIGIN}/en/base/base1/4/low.webp`, { fetchImpl: impl, cache });
    assert.equal(calls.length, 2);
    assert.equal(cache.size, 2);
  });
});

// ---------------------------------------------------------------------------
// The politeness gate — on a virtual clock, so CI actually runs it
// ---------------------------------------------------------------------------

describe('politeness gate', () => {
  it('never exceeds 2 in flight or 5 starts per rolling second, without sleeping', async () => {
    const wall = Date.now();
    const { clock, advance, now } = virtualClock();
    const gate = new PolitenessGate({ clock });
    const cache = new AssetCache();

    const starts: number[] = [];
    let pending: Array<() => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const impl: FetchLike = (url) => {
      starts.push(now());
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<UpstreamResponse>((resolve) => {
        pending.push(() => {
          inFlight--;
          resolve(response({ status: 200, contentType: 'image/webp' }));
        });
      });
    };

    const REQUESTS = 12;
    const settled: string[] = [];
    for (let i = 0; i < REQUESTS; i++) {
      // Distinct URLs, so the LRU never short-circuits the gate.
      void fetchAsset(`${ASSETS_ORIGIN}/en/base/base1/${i}/high.webp`, {
        fetchImpl: impl,
        gate,
        cache,
      }).then((r) => settled.push(r.status));
    }

    for (let guard = 0; guard < 200 && settled.length < REQUESTS; guard++) {
      await flush();
      assert.ok(inFlight <= MAX_CONCURRENCY, `in flight ${inFlight} exceeded ${MAX_CONCURRENCY}`);
      if (pending.length === 0) {
        advance(200);
        continue;
      }
      const batch = pending;
      pending = [];
      for (const resolveOne of batch) resolveOne();
    }
    await flush();

    assert.equal(settled.length, REQUESTS, 'every request settled');
    assert.equal(
      settled.every((s) => s === 'ok'),
      true,
    );
    assert.equal(starts.length, REQUESTS);
    assert.ok(maxInFlight <= MAX_CONCURRENCY, `peak concurrency was ${maxInFlight}`);

    // The gate's own invariant: at the moment of any start, at most RATE_PER_SEC
    // starts (including this one) lie in the preceding rolling second.
    for (const at of starts) {
      const window = starts.filter((s) => s > at - 1000 && s <= at);
      assert.ok(
        window.length <= RATE_PER_SEC,
        `${window.length} starts in the second ending at ${at}`,
      );
    }

    // 12 requests at 5/s cannot finish inside one virtual second — proof the
    // rate limiter actually bound, rather than the test being trivially green.
    assert.ok(now() >= 1000, `virtual time only reached ${now()}ms`);
    // …and none of that was real time.
    assert.ok(Date.now() - wall < 2000, 'the test slept for real');
  });

  it('releases waiters as capacity frees up rather than deadlocking', async () => {
    const { clock, advance } = virtualClock();
    const gate = new PolitenessGate({ clock, ratePerSec: 100, maxConcurrency: 1 });

    let secondAcquired = false;
    await gate.acquire();
    void gate.acquire().then(() => {
      secondAcquired = true;
    });

    await flush();
    assert.equal(secondAcquired, false, 'the second waiter must not jump the concurrency cap');

    gate.release();
    await flush();
    assert.equal(secondAcquired, true);
    advance(100);
  });
});

// ---------------------------------------------------------------------------
// The warm-instance LRU
// ---------------------------------------------------------------------------

describe('AssetCache', () => {
  const entry = (bytes: number): CachedAsset => ({
    body: webpBytes(bytes),
    contentType: 'image/webp',
    etag: null,
  });

  it('evicts by entry count, oldest first', () => {
    const cache = new AssetCache({ maxEntries: 3, maxBytes: 1_000_000 });
    for (const key of ['a', 'b', 'c', 'd']) cache.set(key, entry(16));

    assert.equal(cache.size, 3);
    assert.equal(cache.has('a'), false, 'the oldest entry is the one that leaves');
    assert.equal(cache.has('d'), true);
  });

  it('counts a read as a use, so recency is not insertion order', () => {
    const cache = new AssetCache({ maxEntries: 3, maxBytes: 1_000_000 });
    cache.set('a', entry(16));
    cache.set('b', entry(16));
    cache.set('c', entry(16));
    cache.get('a'); // 'a' is now the most recently used
    cache.set('d', entry(16));

    assert.equal(cache.has('a'), true);
    assert.equal(cache.has('b'), false);
  });

  it('evicts by byte budget, and tracks bytes across overwrite and delete', () => {
    const cache = new AssetCache({ maxEntries: 100, maxBytes: 100 });

    cache.set('a', entry(40));
    cache.set('b', entry(40));
    assert.equal(cache.bytes, 80);
    assert.equal(cache.size, 2);

    cache.set('c', entry(40)); // 120 > 100 — 'a' has to go
    assert.equal(cache.size, 2);
    assert.equal(cache.bytes, 80);
    assert.equal(cache.has('a'), false);

    cache.set('c', entry(20)); // overwrite: bytes must not double-count
    assert.equal(cache.bytes, 60);
    assert.equal(cache.size, 2);

    cache.delete('b');
    assert.equal(cache.bytes, 20);
    assert.equal(cache.size, 1);
  });

  it('refuses an entry larger than the whole budget instead of emptying itself', () => {
    const cache = new AssetCache({ maxEntries: 10, maxBytes: 100 });
    cache.set('a', entry(50));
    cache.set('huge', entry(500));

    assert.equal(cache.has('huge'), false);
    assert.equal(cache.has('a'), true, 'an unfittable entry must not evict the fitting ones');
    assert.equal(cache.bytes, 50);
  });

  it('clears', () => {
    const cache = new AssetCache();
    cache.set('a', entry(16));
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.bytes, 0);
  });
});
