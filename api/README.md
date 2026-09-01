<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 Chey Rasmussen -->

# `api/` — the hosted editor's serverless functions

`foilkit.deckpal.app` is a static SPA with a few Vercel Node functions behind
it. This directory is those functions. There is no server, no database and no
session store — each file here is one request in, one response out.

```
api/image.ts          GET /api/image  — card scans, by reference, through a proxy
api/_lib/upstream.ts  the URL algebra, politeness gate, fetch and warm LRU
api/_lib/http.ts      the request/response shapes and the shared JSON error body
```

Other functions (`mask`, `auth`) are landing alongside these from a different
piece of the same work. They follow the conventions below; this file is where
those conventions are written down once rather than five times.

## No npm dependencies

Not "few" — none. foilkit's packages and tools run on `node --test` with no
build step and no dependencies (`AGENTS.md`), and `api/` is held to the same
bar. In particular **`@vercel/node` is not installed and must not be added**:
the runtime hands a handler a Node `IncomingMessage`/`ServerResponse` pair, and
`_lib/http.ts` declares the two structural interfaces that describe the parts we
touch. TypeScript's structural typing is enough; a package for two interfaces is
not a dependency worth having.

A function that genuinely needs a library needs a decision in `DECISIONS.md`
first, not an `npm install`.

## No transcode, ever

Bytes in, bytes out. `/api/image` never resizes, re-encodes, re-compresses or
converts an image, and neither will anything added next to it. This is a
standing decision, not a gap:

- **F3.** Subtask 4's frame registry keys a card's framing on **source URL +
  raster dimensions**. A re-encode silently changes the artifact a measurement
  was taken against, which is the same class of error as asserting provenance
  rather than deriving it.
- **F2.** A cache that passes bytes through is a cache. One that re-renders them
  is a publisher, and these are card scans we do not own.

If a resized variant is ever genuinely needed it is a *different endpoint* with
its own answers to both of those, not a flag on this one.

## SSRF is closed by construction

Any function that fetches something on a caller's behalf **constructs** the
upstream URL from a validated path; it never forwards a caller-supplied origin.
In `_lib/upstream.ts` there is exactly one place a URL comes into existence —
`` `${ASSETS_ORIGIN}/${path}` `` — and `path` reaches it only after matching a
strict five-segment regex.

The `src=` parameter looks like an exception and is not: a full URL is parsed,
its `origin` is compared against `ASSETS_ORIGIN`, and then **only its pathname
survives** to go through the same regex as `p=`. The caller's string never
becomes the request.

This is deliberately structural rather than an allow-list check bolted on
afterwards. An allow-list you can only verify by reading five branches is one
somebody eventually adds a sixth branch to.

## The real cache is the CDN

A Vercel function has no persistent disk and no memory shared with the instance
next to it. `AssetCache` in `_lib/upstream.ts` is a small per-instance LRU (64
entries / 16 MB) that helps only when one warm instance serves the same card
twice.

**The cache that matters is the Vercel CDN in front of the function.** That is
what `Cache-Control: public, max-age=31536000, immutable` buys, and it is what
actually keeps a volunteer-run CDN from being hammered every time a contributor
scrubs through a set. Do not size, tune or reason about the in-memory map as
though it were DeckPal's on-disk store — it is not, and a comment claiming
otherwise would be worse than no comment.

## Why the proxy exists (it is not CORS)

Measured 2026-09-01: `assets.tcgdex.net` **does** send
`Access-Control-Allow-Origin: *` on asset GETs, with or without an `Origin`
header, and answers a preflight `204` with
`Access-Control-Allow-Methods: GET, OPTIONS`. Settled; do not re-litigate.

The proxy ships anyway, for three reasons that hold either way:

1. Not hammering a volunteer-run CDN every time somebody scrubs a set.
2. Images keep working through an upstream outage or a URL-structure change.
3. The frame registry's key stays stable when upstream re-encodes something —
   which is also why every response carries `x-foilkit-upstream`.

## `/api/image` — the query contract

```
GET|HEAD /api/image?p=<lang>/<serie>/<set>/<localId>/<low|high>.webp
GET|HEAD /api/image?src=https://assets.tcgdex.net/<same path>
```

Exactly one of `p` or `src`. `p` is the form the editor should normally use;
`src` exists so a recorded source URL can be passed through unchanged, which is
what keeps the frame registry's key identical on both sides.

Worked example — Base Set Charizard (`base1-4`), high quality:

```
/api/image?p=en/base/base1/4/high.webp
```

### Responses

| Status | When | Body |
|---|---|---|
| `200` | the asset resolved and is a real WebP | the bytes, `content-type: image/webp` |
| `304` | the caller's `if-none-match` still matches | empty |
| `400` | no parameter, or one that does not resolve to an upstream asset | `{ "error": { "code", "message" } }` |
| `404` | upstream says this card has no scan | JSON error |
| `405` | any method other than `GET` or `HEAD` | JSON error |
| `502` | upstream answered, and answered wrongly | JSON error |

**`502`, not `404`, on a bad body.** The difference is the whole point: a `404`
means "this card has no scan" and a `502` means "upstream handed us something
wrong" — the soft-404 trap (HTTP `200` plus a `text/html` error page) or a body
that is not a RIFF/WEBP container. A contributor staring at a blank editor needs
to tell those apart, and collapsing them into one status is how a CDN incident
gets misfiled as missing data for a week.

### Success headers

```
content-type: image/webp
cache-control: public, max-age=31536000, immutable
access-control-allow-origin: *
etag: <upstream's, passed through>
x-foilkit-upstream: https://assets.tcgdex.net/en/base/base1/4/high.webp
```

`x-foilkit-upstream` is on every response that resolved an upstream, success or
failure, so the frame registry's key is **observable** rather than something the
client reconstructs and hopes matches.

## Politeness

`/api/image` carries DeckPal `apps/images`' budget verbatim: **≤5 requests per
second, ≤2 concurrent**, a `user-agent` that names the project and a contact
URL, `if-none-match` passed through, plus the two refusals above. The gate's
clock and its `fetch` are injectable so `_lib/upstream.test.ts` drives the rate
limiter on a virtual clock — a rate limiter whose test sleeps for real seconds
is one CI stops running, and one nobody runs is one that rots.

## Tests

`node --test` over `api/**/*.test.ts`, wired into the root `pnpm test`. No
network: every upstream response is injected. Typechecking reaches `api/`
through `tsconfig.tools.json`'s `include`.
