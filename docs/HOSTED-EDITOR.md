<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 Chey Rasmussen -->

# The hosted editor — artifact contract

`foilkit.deckpal.app` is a static SPA plus a handful of Vercel functions. It has
**no database at runtime**. Everything the read path needs is a file, and this
document is the contract those files are written and read against.

Four producers, one consumer:

| Producer | Needs Postgres | Runs | Writes |
|---|---|---|---|
| `tools/bake-catalog.mts` | **yes**, one connection | manually, by the maintainer | `data/catalog/**`, `data/search/**`, `data/foil-pattern-cards.json`, `data/foil-verification-map.json` |
| `tools/build-corpus-manifest.mts` | no | **every build** | `data/corpus-manifest.json` |
| `tools/build-task-queue.mts` | no | **every build** | `<bake>/task-queue.json` — §4a |
| `tools/bake-fixture.mts` | no | on demand / in CI | a synthetic bake under a target dir |

The consumer is `apps/editor`. Its build copies `data/catalog`, `data/search`,
`data/corpus-manifest.json`, `data/foil-verification-map.json`,
`data/foil-pattern-cards.json` and `task-queue.json` into `dist/` so the CDN
serves them beside the bundle. The editor never reaches for a database and never reaches for DeckPal.

## Staleness is visible, never silent

Every artifact carries `generatedAt`, `resolverVersion` and its row counts, and
the editor renders them. A bake older than the resolver the site was built with
is a **banner**, not a quiet wrong answer.

Fixture-built artifacts stamp `source: "fixture:<name>"`. A fixture never claims
to be the real catalog, and the editor badges it as a fixture in the UI.

---

## 1. Catalog shards — `data/catalog/`

The tier structure mirrors the walk `apps/editor/src/api.ts` already does:
series list → sets in a series → paged set cards → card detail. **Card detail is
served out of the set shard**, because a set shard already carries every field
a detail view needs and 20k single-card files is a bad thing to put in git.

**Nothing user-scoped may appear in any of these files.** No ownership, no
quantities, no progress, no internal database ids other than the `card_variant`
id the mask corpus is keyed by. These are public files on a CDN.

### `data/catalog/index.json`

```jsonc
{
  "version": 1,
  "generatedAt": "2026-09-01T00:00:00.000Z",
  "source": "catalog",              // or "fixture:<name>"
  "resolverVersion": 5,
  "counts": { "series": 12, "sets": 184, "cards": 20500, "printings": 41471 },
  "series": [
    { "slug": "scarlet-violet", "name": "Scarlet & Violet",
      "tcgdexId": "sv", "setCount": 12, "cardCount": 2400 }
  ]
}
```

### `data/catalog/series/<slug>.json`

```jsonc
{
  "seriesSlug": "scarlet-violet",
  "sets": [
    { "setId": "sv01", "name": "Scarlet & Violet",
      "releasedOn": "2023-03-31", "cardCountTotal": 258 }
  ]
}
```

### `data/catalog/sets/<setId>.json` (page 1) and `<setId>.p<N>.json` (N ≥ 2)

`pageSize` is 250 — the api's old maximum, and it covers every set but the big
promo sets in one page.

```jsonc
{
  "setId": "sv01",
  "set": { "setId": "sv01", "name": "Scarlet & Violet",
           "slug": "scarlet-violet", "seriesName": "Scarlet & Violet",
           "seriesTcgdexId": "sv", "releasedOn": "2023-03-31" },
  "page": 1, "pageCount": 2, "total": 258, "pageSize": 250,
  "cards": [
    { "cardId": "sv01-1", "number": "1", "name": "Pineco",
      "rarity": "Common",
      "images": { "low": "https://…/low.webp", "high": "https://…/high.webp" },
      "variants": [
        { "variantId": 91234, "kind": "normal",
          "displayName": "Normal", "tier": "standard" }
      ] }
  ]
}
```

`variantCount` is `variants.length`; the editor derives it rather than the bake
repeating itself. `images` are **absolute upstream URLs** — the editor rewrites
them through `/api/image` at view time (see §5).

A set shard's `<setId>` may contain `.` (`sv03.5`). It never contains `/` or
`\`; the bake rejects any set id that does, because a shard name is a path.

## 2. Search index — `data/search/`

`/search` was a Postgres full-text query. Static means a client-side index over
the whole English catalog: **name, number, set id**.

### `data/search/index.json`

```jsonc
{
  "version": 1,
  "generatedAt": "…", "source": "catalog", "resolverVersion": 5,
  "total": 20500,
  "buckets": ["a", "b", "…", "z", "0", "_"],   // normalized first letter
  "bytes": { "index": 812, "buckets": 691234 } // measured, for the staleness panel
}
```

### `data/search/b/<bucket>.json`

One file per bucket, loaded lazily on first keystroke that selects it. A row is
a two- or three-element tuple:

```jsonc
{ "bucket": "c", "rows": [ ["sv01-26","Charizard ex"], ["base1-4","Charizard","4"] ] }
```

- `rows[i][0]` — `cardId`
- `rows[i][1]` — `name`
- `rows[i][2]` — `number`, **present only when it is not recoverable** from the
  cardId by splitting on the last `-`. Omitting it is what keeps the index small.

`setId` is likewise the cardId before its last `-`. The reader
(`apps/editor/src/catalog/search.ts`) owns that derivation; the bake asserts it
round-trips for every row it writes and emits the explicit `number` when it does
not.

**Why partition.** Measured at catalog scale the whole index is ≈700 KB raw /
≈200 KB gzipped — small enough to ship whole. It is partitioned anyway because
the first keystroke should not pay for the twenty-five buckets it excluded, and
because a bucket file is the unit that grows when the catalog does. The bake
reports the measured total so the decision can be revisited against a number.

## 3. Corpus manifest — `data/corpus-manifest.json`

A local walk of `data/foil-masks`, `data/foil-canon` and `data/foil-windows`.
No database, no network, runs on every build. This is what the **contribution
filters** are answered from — has a mask / has a canon / uncanon'd pattern —
and it is three of the six inputs the contribution queue is generated from
(§4a): the canon-less list, the uncorrected machine masks, and the `agreement`
that ranks them.

```jsonc
{
  "version": 1,
  "generatedAt": "…",
  "counts": {
    "maskRecords": 20, "maskCards": 20, "maskUnits": 20,
    "windowFiles": 1, "windowCards": 1,
    "canonFiles": 32, "patterns": 45, "uncanonedPatterns": 12
  },
  "masks": {
    "base1-4": {
      "1": { "variantId": 1, "scope": "window", "eraId": "wotc",
             "method": "hand", "reviewStatus": "human-authored",
             "tier": "owner-verified", "author": "cheyras", "verifiedBy": null,
             "agreement": 0.8123, "savedAt": "…", "frame": "canonical",
             "width": 504, "height": 704, "sha256": "…" }
    }
  },
  "maskUnits": { "base1-4|window": 1 },   // (cardId, scope) → variantId that answers
  "windows": { "me05-001": [37184] },
  "canon": {
    "cosmos": { "exists": true, "contract": 4, "savedAt": "…", "uniforms": 20 }
  },
  "uncanoned": ["ace-spec", "acid-wash", "…"],   // absence is the point (#5)
  "patterns": ["cosmos", "…"]                     // every implemented recipe id
}
```

`agreement` is `sidecar.diff.agreement` when present and `null` otherwise. A
mask with no sidecar is a finding, not a row: the builder fails loudly.

`tier` is the **derived** provenance tier — `owner-verified` / `contributor` /
`unattributed` — and it is in the manifest because the hosted editor has no
server walking sidecars: the badge, the corpus panel and the promotion queue all
read this file. Only `owner-verified` carries exemplar weight, so a manifest
that carried the method but not the tier would show a contributor's `hand` mask
with the same "ground truth" badge the owner's gets. See
[`PROVENANCE.md`](PROVENANCE.md) § "Provenance tiers".

The canon-less patterns are recorded **as absence**. Do not manufacture a canon
entry from code defaults — that erases the signal #11 is built on.

**The number is 12, not 13, and the derived list is the truth.** Subtask 5
records 13, which is `45 implemented patterns − 32 canon files`. That
arithmetic counts `none`, the no-foil recipe, which has no canon by definition
and never will. The builder derives the list rather than trusting the count,
prints a `FINDING:` line whenever the two disagree, and does not fail the build
over it — a count is a claim and the corpus is the measurement.

One deliberate deviation from the shape above: `generatedAt` is **the newest
`savedAt` the corpus itself carries**, not a clock reading. A wall clock would
make the file differ on every run, which makes `--check` useless and a
byte-identical rebuild impossible. The corpus's own newest timestamp is stable
across clones (unlike an mtime), moves exactly when the data moves, and is the
more useful staleness signal for an artifact whose whole job is to describe
that data.

## 4. Verification map + pattern cards

`data/foil-verification-map.json` and `data/foil-pattern-cards.json` are
`tools/bake-catalog.mts`'s other two outputs, in the shapes 3a already fixed
(`version: 1` and `version: 3` respectively). The queue's **leverage section**
is the verification map sorted by leverage; the canon lab's card preview samples
`foil-pattern-cards.json` client-side rather than through a server route.

Both are committed. `.gitignore` carries a re-include for them.

## 4a. The contribution queue

`data/task-queue.json` — `tools/build-task-queue.mts`, every build, no
database. It is the editor's **landing page**, and it exists because the
leverage ranking answered exactly one question and could not be a list: five
other kinds of contribution were recorded in this repository and invisible from
the home screen.

Six inputs, seven kinds of card:

| Card type | Derived from |
|---|---|
| `approximation` | `PATTERNS[].implemented === false` + `approxVia` — the enforceable form of "approximated" |
| `canon` | `corpus-manifest.json` `uncanoned[]` — a pattern with no saved uniform snapshot |
| `verdict` | `data/verification-verdicts.json` `verdicts[]` where `standing && verdict === 'nay'` |
| `mask` | `corpus-manifest.json` mask units with `reviewStatus !== 'human-authored'`, ranked by `1 − diff.agreement` |
| `window-mask` | `foil-verification-map.json` groups where `scope === 'window' && exemplars === 0` |
| `residual` | `foil-card-assignments.json` `known_residuals[]` with no `resolved` field |
| `empty-pool` | `foil-pattern-cards.json` `diagnosis[]`, rendered verbatim, one contribution per cause |

Two of those inputs are bake outputs, so the queue is written into the **bake
directory** beside them and follows the `FOILKIT_BAKE` seam
`apps/editor/copy-data.mjs` and `vite.config.ts` already use. A missing bake is
tolerated and recorded in `bakedInputs`, never fatal; a missing committed input
is fatal, because that is a broken checkout rather than an unrun job.

`generatedAt` is the newest stamp the INPUTS carry, for the reason §3 gives.
`--check` is CI's proof that the committed queue matches them.

**Every card traces to its source**, and `task.source` names the file and the
field. Sorting is by `impact` — printings the resolver assigns to the rule the
card teaches — with unsizeable cards last rather than pretending to be zero,
and a `tieBreak` on divergence so the five Base Set holos (one rule group, one
impact number between them) lead with the one whose machine mask disagrees most
with the era rule.

### Two numbers this file deliberately does NOT use as impact

- **An outranked empty pool.** The diagnosis says 1,818 catalog printings are
  named by a cited row for `diagonal-sheen-left` and that a higher-ranked row
  wins each one. Both claims are true — cited rows routinely describe different
  physical layers of the same card — so closing it moves *nothing* unless a new
  source appears. Ranking the card by 1,818 would put "usually nothing to fix"
  above a mask that really does move 1,624 printings, and would read as an
  invitation to go and win them back. `impact` is `null`; the number stays on
  the card as detail, under the do-not-flip-a-winner guard.
- **`maskCoveredCards`.** Coverage is not evidence, per §3.

### The verdicts datum

`data/verification-verdicts.json` is the one input that could not be derived.
The judging verdicts live in `VERIFICATION.md` prose — a superseding header plus
one markdown table per wave, each overriding rows in the last — and the
machine-readable `verdict.json` files live outside the repository
(`VERIFICATION.md:31-34`). A build step that parsed six tables and replayed
their supersessions would be a prose parser pretending to be a data source, so
the extraction happens **once, by hand**, with the doc line numbers that justify
every row. Update it in the same commit as the wave; the builder fails the build
if a row names something that is not an implemented pattern id.

It carries the **still-frame blindness** flag, and that flag decides the card's
skill. `VERIFICATION.md:759-764`: *"Still-frame motion blindness now has FIVE
data points … Chey's live tilt remains the arbiter for motion claims."* Those
cards ask for a **live-tilt human verdict, not another GLSL round**, and say so
on the card — answering them with more shader work is the documented wrong move.

### Three doc counts that are currently stale

The builder checks itself against every count a document asserts and prints a
`FINDING:` line for each disagreement. A finding is **not** a failure: the
document is a claim, the corpus is the measurement, and failing the build on
every stale sentence would mean nobody could commit a measurement until they had
also rewritten the prose. As of 2026-09-06:

| Claim | Where | Measured |
|---|---|---|
| 5 approximated types, the R3 list | `SHADER-CONTRACT.md:290-295` | **1** — `big-glitter`. The other four shipped dedicated recipes in R3-MISC (`VERIFICATION.md:840-843`) |
| 13 canon-less patterns | §3 above, subtask 5 | **12** — the long-standing `none` correction |
| 4 standing nays | `VERIFICATION.md:61-73` | **5**, and only two of the original four are in it |

The nay list moved the most. R3-MOTION broke `starlight`
(`VERIFICATION.md:677`), R3-GLYPH broke `radiant-collection-dots` (`:754`), and
three new nays were recorded — `radiant` (`:680`), `ace-spec` (`:756`),
`prismatic-pokeball` (`:757`). `pokeball-hologram` was never re-judged after R2,
so its R2 verdict is the last one on record. `VERIFICATION.md` never restates a
consolidated post-R3 list; `verification-verdicts.json` is that restatement, and
its `$supersededClaim` block records the claim it replaces rather than deleting
it.

Note also that `VERIFICATION.md:840-843` asserts *"zero `approxVia` fallbacks
remain in the library"*, which the code refutes: `big-glitter` still carries one
(`packages/patterns/src/patterns.ts:2717-2728`).

## 5. Images — by reference, through the proxy

`assets.tcgdex.net` **does** send `Access-Control-Allow-Origin: *` (measured
2026-09-01, `curl -D -` with and without an `Origin` header, on
`/en/base/base1/4/high.webp`; the preflight answers `204` with
`Access-Control-Allow-Methods: GET, OPTIONS`). A cross-origin `<img
crossOrigin="anonymous">` therefore uploads as a WebGL texture without tainting
the canvas.

**The proxy ships anyway.** Three reasons that hold whichever way the check
landed, and only the first is about CORS:

1. Not hammering a volunteer-run CDN every time somebody scrubs a set.
2. Images keep working through an upstream outage or a URL-structure change.
3. #4's frame registry resolves a framing from **source URL + raster
   dimensions**. A proxy under our control keeps that key stable when upstream
   re-encodes something.

```
GET|HEAD /api/image?p=<lang>/<serie>/<set>/<localId>/<low|high>.webp
GET|HEAD /api/image?src=https://assets.tcgdex.net/<the same path>
```

e.g. `/api/image?p=en/base/base1/4/high.webp`. Exactly one of the two forms.
`src=` exists so a **recorded source URL passes through unchanged**, which is
what keeps #4's frame-registry key (source URL + raster dimensions) identical on
both sides of the proxy. Every response that resolved an upstream carries
`x-foilkit-upstream`, so that key is observable from the response rather than
inferred.

**SSRF is closed by construction, not by an allow-list check.** The function
only ever builds `${ASSETS_ORIGIN}/${path}` from a `path` that matched a strict
five-segment regex; a caller-supplied origin is never forwarded. `src=` is
accepted only when its origin is exactly the assets origin *and* its pathname
reduces to a path that passes the same regex.

It is a pure caching proxy — **no transcode, ever**. It carries `apps/images`'
politeness budget (≤5 req/s, ≤2 concurrent), its soft-404 trap (a `200` with
`content-type: text/html` is a rejection, not a cache write) and its RIFF/WEBP
magic-byte check. The real cache is the Vercel CDN in front of the function
(`cache-control: public, max-age=31536000, immutable`); the per-instance LRU
only helps a warm instance asked for the same card twice, and the code says so
rather than pretending to be DeckPal's on-disk store.

An upstream `404` answers `404` ("this card has no scan"); an upstream body that
fails the content-type or magic-byte check answers **502** ("upstream handed us
something wrong"). The difference matters to a caller and is not collapsed.

## 6. Never in an artifact

- ownership, quantities, progress, collection counts, user ids
- anything from a DeckPal table that is not catalog
- a secret, a token, or an internal hostname

The bake asserts this structurally: it selects the columns it emits, and a test
walks every emitted object for a key on the forbidden list.
