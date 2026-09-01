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

**The first pairs have landed.** Four were photographed from the binder and
measured on 2026-08-31 — see **`THRESHOLDS.md`**, which carries the numbers, the
corpus size and the reasoning. No photograph is committed anywhere in this repo;
the numbers are the whole record. Headlines:

- **The thresholds were deliberately NOT refitted.** `CHANGED_PIXEL_DELTA` is
  measuring the wrong quantity on photographs rather than the right one badly:
  exposure, angle-dependent foil optics and the reverse's printed foil
  micro-texture all move it, and none of them is ink. The fitted per-channel
  gain between a reverse printing and its normal ran 0.38-0.56 on three of the
  four pairs. On the one pair that registered cleanly — difference image
  visually near-black — the threshold still marks 40.8% of the art window
  changed and the classifier returns `full`. The fix is a photometrically
  invariant statistic, not a recalibrated ceiling.
- **No real pair has yet produced a `null` or a `frame` classification.** All
  four returned `full`, for that metric reason. The three-way behaviour is still
  exercised only by the synthetic suite.
- **The alignment guard can pass a badly misregistered pair.** It correlates raw
  luma, which for a normal against a reverse-holo is dominated by the very
  difference being measured, so the objective goes nearly flat and its argmin is
  noise. It returned `aligned: true` for all four pairs while three were badly
  misregistered. `AlignmentReport.peakContrast` now reports how far the winning
  shift stands out from the field; a small shift alone is not evidence.
- **The die-cut edge is not a sufficient registration datum.** Sleeves and
  print-centring variance leave two copies of one card with their ink in
  different places — one pair carries a stable 2 mm horizontal offset after both
  halves were correctly rectified to their own outlines. A capture pipeline has
  to register on printed content, not only rectify to the cut. That is task 14's
  problem and it is the most useful thing this run measured.

What the run did establish, independently of the classifier: direct inspection
of the rectified lower-left tag block shows a frame-confined structural ink
difference on 3 of 3 pairs from the one 2026 set sampled — the set-code badge
inverts between printings and the collector number, illustrator credit, rarity
pip and flavour text all gain a white knockout keyline on the reverse. On the
holo-against-reverse pair that treatment tracked the reverse printing rather
than the presence of foil.

Still genuinely unmeasured:

- **`PLACEHOLDER_ART_WINDOW` is not a measurement.** The real windows are
  per-era and live in `era-layouts.json`. Pass the right one; a result computed
  against the placeholder should say so.
- **The EX-era cases are untested.** EX Deoxys running the pattern across image
  and text, FireRed & LeafGreen's centre-card Poke Ball, Hidden Legends' large
  background type symbol — 3b requires each to be tested explicitly rather than
  assumed, and each needs a photographed pair. The binder sample contained none.
- **The WOTC era is untested**, so the `wotc` rect has still never met a
  photograph, and the Base Set holo-against-normal question has no measurement.
- **Full-face rarities are untested.** No illustration rare, special
  illustration rare or full-art pair.

Every claim carries its corpus size on the front (AGENTS.md F5), and the
exception rate is stated as a fraction of pairs tested — which at n = 4 across
one era is not yet a rate at all.

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
