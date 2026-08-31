<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 Chey Rasmussen -->

# rectifier

**Four detected corners in, one canonical card raster out.**

A card detector answers *where is the card*. This answers *what does the card
look like flat*. It takes a quad — the corner list a detector returns — plus the
image it was found in, and produces a 504 × 704 raster in canonical card space
along with the 3 × 3 homography that got there.

Zero dependencies. Pure TypeScript over `node:zlib` for PNG and nothing else: no
OpenCV, no sharp, no npm packages at all.

---

## Canonical space

Canonical space is the **physical card**, never a raster size:

| | |
|---|---|
| Footprint | 63 × 88 mm |
| Corner radius | 3 mm (triangulated, not official — see below) |
| Sampling density | 8 px/mm |
| **Canonical raster** | **504 × 704**, exactly 63 : 88 with no rounding |

Every one of those numbers except the four inputs is *computed* in
`constants.ts`, and `constants.test.ts` reads the source back and fails if a
derived value is ever typed in as a literal. The 63 × 88 mm footprint is well
attested; the 3 mm corner is **triangulated rather than official** (credible
range 2.5–3.0 mm, no TPCi die specification published). The provenance comment
carries that honesty and is not to be trimmed to just the number.

For context on why this exists: the corpus was measured against TCGdex's
600 × 825 and 245 × 337 rasters, both of which are ~1.55% too wide for a
63 × 88 mm card. `aspectError()` in `rectify.ts` reports it — 11/693 for
600 × 825, 329/21231 for 245 × 337. Those are close enough to quote as one
figure in prose and far enough apart that a shared constant would be wrong.

## The modules

| File | What it is |
|---|---|
| `constants.ts` | The millimetre constants and everything derived from them. No imports, on purpose — it moves into `@foilkit/core` at extraction |
| `homography.ts` | Normalised DLT, matrix inverse/product, orientation resolution, bilinear warp |
| `rectify.ts` | The public API — `rectify()`, plus the frame-record helpers |
| `diff.ts` | Pair diff, alignment guard, and the three-way `null` / `frame` / `full` classifier |
| `png.ts` | PNG decode/encode over `node:zlib` |
| `synthetic.ts` | Known-homography test imagery, so the geometry can be validated with no photograph |
| `smoke-scans.ts` / `fetch-smoke-scans.ts` | The citation and the fetcher for the two real catalog scans |

### Using it

```ts
import { rectify } from './rectify.ts';
import { diffPair, classifyDelta } from './diff.ts';

// corners: the detector's [[x,y],[x,y],[x,y],[x,y]], either winding, any rotation
const normal  = rectify(normalPhoto,  normalCorners);
const reverse = rectify(reversePhoto, reverseCorners);

const d = diffPair(normal.image, reverse.image, { artWindow: eraWindowFor(card) });
const c = classifyDelta(d);   // → 'null' | 'frame' | 'full', with the number that decided it
```

`rectify()` also returns `toCanonical` — source pixels → canonical pixels — which
is exactly the 3 × 3 row-major homography task 4b's `data/frames.json` stores per
image source. `serializeHomography()` produces the nested-row JSON form and
`deserializeHomography()` reads it back.

### Orientation

By default the corner list is read with `orientation: 'auto'`: winding is
normalised to clockwise, then the top-left corner is chosen by two terms that do
different jobs.

- The **aspect** term separates upright from sideways. 63/88 = 0.716 against
  88/63 = 1.397 is a wide gap, so it is decisive whenever the detection is a
  card at all.
- The **upright** term separates a card from the same card turned 180°, which
  the aspect term cannot see. It asks that the top-edge-to-bottom-edge vector
  point down the image.

`'as-given'` trusts the input order verbatim; `'rotate90' | 'rotate180' |
'rotate270'` are `as-given` plus a cyclic shift, for a card photographed on its
side where the upright assumption is the wrong assumption.

## The 3b flow

```
  shoot the pair              ← HUMAN. Normal and reverse printings of one card
        ↓
  detect the corners          ← DeckPal dev/scan-harness, or any quad detector
        ↓
  rectify(photo, corners)     ← here. Both sides, same code path, never hand-aligned
        ↓
  diffPair(a, b, artWindow)   ← here. Alignment guard, then per-pixel delta,
        ↓                        split inside/outside the art window
  classifyDelta(diff)         ← here. null / frame / full
        ↓
  pairRecord(...)             ← the row that carries the class, the evidence and n
```

The classes are 3b's question restated as an output:

- **null** — the scans are equivalent; only the pattern assignment differs. A
  Rare reprinted as a Rare Holo carries a different foil with no ink change.
- **frame** — differences confined outside the art window: reverse-holo body
  design, the white keyline round the lower-left tag block, set stamps. Expected
  for everything modern.
- **full** — the design crosses the art window. Expected to dominate the EX era
  (2003–2007) and every full-face rarity, where the window *is* the card.

## Verification, and what the numbers actually are

Run everything:

```bash
node --test "tools/rectifier/*.test.ts"
```

Node 22.18+ / 24 strips TypeScript natively, so there is no build step, no
loader and no dev dependency. 66 tests as of 2026-08-31.

The round-trip measurement is the load-bearing one: a known canonical raster is
rendered into a synthetic photograph through a **known** homography, and the
rectifier — handed nothing but the photo and four corners — has to give the
raster back.

| Case | mean | max | n |
|---|---|---|---|
| Synthetic smooth pattern, 1500 × 1550 photo, keystoned quad | **0.0019/255** | **1/255** | 345,216 px |
| Identity quad on an already-canonical raster | 0.0000/255 | 0/255 | 354,816 px |
| 600 × 825 catalog framing → canonical | 0.0826/255 | 1/255 | 345,216 px |
| **Real card** (Base Set 4) through the same synthetic photo path | **2.28/255** | **54/255** | 345,216 px, n = 1 card |

The tolerance the test asserts is mean < 2/255 and max < 12/255, measured 4 px
in from the raster edge — the outermost pixels are a blend of card and
background wherever the corner estimate is off by a fraction of a pixel, and a
rounded corner puts background there by construction.

The real-card row is **an order of magnitude worse than the synthetic row, and
that is the honest result**: a real card is full of hard edges and 6 pt type,
and two bilinear resamples through a perspective transform cost real error at
every one of them. The synthetic tolerance is a floor on the *geometry*; it is
not a claim about what a photographed card survives. Anything downstream that
cares about a single pixel's value — a keyline detector, say — has to budget for
the real number, not the synthetic one. (Measured by rectifying the catalog scan
to canonical, rendering it through `tiltedQuad()`, and rectifying back; the
corner list was reversed to exercise the orientation resolver at the same time.)

### The real-scan smoke test

Two catalog scans, fetched not vendored:

```bash
node tools/rectifier/fetch-smoke-scans.ts
```

They land in `reference-media/rectifier-smoke/`, which is gitignored. **The
pixels never ship** — AGENTS.md F2, the standing ownership rule: reference
imagery is cited with a procedure that fetches it, and `smoke-scans.ts` is that
citation. With the files absent the smoke suite *skips* rather than fails, so a
fresh clone with no network still passes.

**WebP was declined.** The obvious URL is TCGdex's `high.webp`, and decoding
WebP without a dependency means writing a VP8 intra decoder — a real project,
and one with nothing to do with homographies. TCGdex serves the same asset as
`.png` from the same path. Nothing about the rectifier is format-aware; it takes
an RGBA buffer, and swapping in a WebP decoder later changes only the loader.

That smoke test immediately earned its place. TCGdex's `high.png` is **8-bit
palettised and Adam7-interlaced**, and the PNG codec ported from DeckPal
supported neither — it had only ever read `canvas.toDataURL` output. Both are
implemented here now. The synthetic suite would never have found it.

## What is still blocked

**The physical pair capture.** No bulk source ships variant-specific imagery:
TCGdex returns one image per card and that image is the normal printing;
`card_variant` has no image column. Both printings of the same card have to be
photographed from the binder. Until that happens:

- **No delta class has been measured.** Every class in the test suite is
  synthetic, constructed to have a known answer. Zero real pairs, n = 0.
- **Every threshold in `diff.ts` is provisional.** `CHANGED_PIXEL_DELTA`,
  `NULL_MAX_CHANGED_FRACTION`, `FRAME_MAX_INSIDE_CHANGED_FRACTION`,
  `EDGE_MARGIN_PX`, `MAX_RESIDUAL_SHIFT_PX` — all set to separate the synthetic
  cases with room to spare, none refitted against a photograph. Expect the null
  ceiling in particular to rise: a real pair carries registration slop and
  per-scan colour drift that a synthetic pair does not.
- **`PLACEHOLDER_ART_WINDOW` is not a measurement.** The real windows are
  per-era and live in `era-layouts.json`. Pass the right one; a result computed
  against the placeholder should say so.
- **The EX-era cases are untested.** EX Deoxys running the pattern across image
  and text, FireRed & LeafGreen's centre-card Poké Ball, Hidden Legends' large
  background type symbol — 3b requires each to be tested explicitly rather than
  assumed, and each needs a photographed pair.

When the pairs land: refit the thresholds against them, record the corpus size
on the front of every claim (AGENTS.md F5), and state the exception rate as a
fraction of pairs tested.

## Handoffs

**→ task 4 (canonical space).** `constants.ts` is the constants module 4b
specifies. `rectify()`'s `toCanonical` and `resampleFrame()` emit the frame
registry's 3 × 3 row-major form, so a rectified photo and a resampled catalog
raster are the same kind of record with different numbers in it.

**→ task 13 (the ink layer).** The delta classes and the per-pair evidence are
what the reverse-holo keying gets built against.

**→ task 14 (community capture).** The capture pipeline calls `rectify()`
directly. It is the front end, and promoting a community scan to canonical is
adding a frame record with an identity transform.

## Provenance

The quad convention and the aspect constraint are adapted from DeckPal's
detector at `apps/web/src/routes/dev/scan-harness.html` (branch
`dev/scan-harness`); the PNG codec is ported from
`apps/api/src/foil/png.ts` (branch `foil/main`); the millimetre constants and
their provenance note are carried from `apps/web/src/lib/cardGeometry.ts`. All
three are the same sole author, so the relicensing to MIT is clean — see
`RELICENSE.md`.
