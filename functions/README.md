<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 Chey Rasmussen -->

# `functions/` — the hosted editor's serverless functions

`foilkit.deckpal.app` is a static SPA with a few Vercel Node functions behind
it. This directory is those functions. There is no server, no database and no
session store — each file here is one request in, one response out.

```
image.ts          GET  /api/image           card scans, by reference, through a proxy
me.ts             GET  /api/me              who is looking, and may they write
auth/start.ts     GET  /api/auth/start      into GitHub's OAuth web flow
auth/callback.ts  GET  /api/auth/callback   out of it, into a signed cookie
auth/signout.ts   GET  /api/auth/signout    drop the cookie
mask.ts           PUT  /api/mask            the direct write — writeMaskRecord, then a commit
window.ts         PUT  /api/window          adjusted window geometry
canon.ts          PUT  /api/canon           a pattern's uniform snapshot

_lib/http.ts      request/response shapes, body reading, the shared JSON error body
_lib/config.ts    what this deployment is configured to do, checked before it tries
_lib/session.ts   the signed cookie, and the safe-return-path rule
_lib/writers.ts   the writer capability list — the check that matters
_lib/github.ts    blobs, trees, commits, and a fast-forward that refuses to clobber
_lib/corpus.ts    materialising the corpus into /tmp so forge can run against it
_lib/upstream.ts  the URL algebra, politeness gate, fetch and warm LRU
```

## Why this directory is not called `api/`

Because a root-level `api/` is what Vercel's zero-config function detection
looks for, and that detection is exactly what must not happen here.

`@vercel/node` transpiles each `.ts` file in place and does **not** rewrite
import specifiers, so `from './_lib/http.ts'` survives into the emitted
`image.js` while the file beside it is `_lib/http.js`. Every function
boot-crashed on the first deploy for that reason, and the extension cannot
simply change: Node's native TypeScript support is strip-only, so a relative
import from a `.ts` file must end in `.ts` or `pnpm test` cannot load it.
Workspace packages did not resolve either — `packages/forge/dist` was copied
into the bundle with nothing mapping `@foilkit/forge` to it.

`tools/build-functions.mts` bundles each file here into one self-contained
`.func` and emits the whole deployment through the Build Output API, so there
are no specifiers left to resolve. With the sources still in `api/`, BOTH
builders ran and wrote into the same directory; moving them one directory over
is what makes the bundler the only thing that builds a function.

**Consequence:** `vercel.json` is reduced to an install and a build command.
Its `rewrites`, `headers` and `functions` keys would be ignored, so they are
gone rather than misleading; the routing table lives in
`tools/build-functions.mts`.

## Verified as the artifact, not as source

`tools/verify-functions.mts` boots every built `.func` with an EMPTY
environment and exercises it. That check exists because the first deploy failed
while every unit test passed: the code was right and the packaging was not, and
nothing that imports the TypeScript source can see that.

## No npm dependencies

Not "few" — none. foilkit's packages and tools run on `node --test` with no
build step and no dependencies (`AGENTS.md`), and `functions/` is held to the same
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

`node --test` over `functions/**/*.test.ts`, wired into the root `pnpm test`. No
network: every upstream response is injected. Typechecking reaches `functions/`
through `tsconfig.tools.json`'s `include`.
