# Canon recheck across the composite-contract bump

> **Where this came from.** Written inside DeckPal, where the foil work began, and
> carried here by the extraction with its paths updated and its measurements
> untouched. Where it describes an HTTP surface — `/foil-lab` routes, a dev api,
> a workbench page — that surface does not exist in foilkit: the hosted
> contribution editor replaces it, and the description is kept because the
> BEHAVIOUR it specifies is what the editor has to reproduce.

The instrument has changed since this was measured: DeckPal's `canon-harness.mjs`
drove its React canon lab, and `tools/parity/` is the general form of the same
thing — same rAF stub, same frozen clock, same 300-frame fixpoint, same clipped
screenshot. Re-running this recheck under a future contract bump is two runs of
`tools/parity/run.mjs`, one per law, through `tools/parity/compare.mjs`, ranked
on mean absolute error. The numbers below are unchanged.

---

**Date:** 2026-09-01 · **n:** 32 canons, 2 renders each, 1 tilt pose
**Contract:** 1 → 2 · **cardAspect:** `[245, 337]` → `[63, 88]` · **CARD_ASPECT:** 1.37551 → 1.39683

**This table names where a human should look. It retunes nothing.** The uniform
values in `data/foil-canon/*.json` are Chey's eye, and a machine may not adjust
them — every file still carries `tunedUnderContract: 1`, which is the honest
record that the ground moved and nobody has looked yet.

---

## What moved, and why it reaches everything

Canonical space is now the physical card, so `era-layouts.json`'s `cardAspect`
went from TCGdex's `[245, 337]` raster to `[63, 88]`. `shader.ts` derives
`CARD_ASPECT` straight from it, and that constant is the **isotropy denominator
for pattern geometry**: 51 uses in `patterns.ts` (47 of them the
`vec2(1.0, CARD_ASPECT)` idiom), plus `rectMask`, `cardAlpha`, and the R6
ink-estimate ring radii. Every pattern's vertical feature scale changed by
1.55%.

A canon file is a full uniform snapshot — "this is what the pattern looks like,
period" — and that claim is only meaningful relative to the law that turns
uniforms into pixels. The same file is now a different rendering. That is what
the contract number exists to make legible instead of silent.

## The instrument

`tools/parity/run.mjs` driving `tools/parity/run.mjs` —
the frame-stepped zero-delta harness described in
`docs/SHADER-CONTRACT.md` and, until now, existing only as prose
there.

- Blank base (`uScanBase 0`), where the classic composite runs unchanged.
- `requestAnimationFrame` stubbed and driven manually; `performance.now()`
  frozen so `uTime` is exactly 0; ~300 frames stepped to the tilt easing's
  float64 fixpoint. With real rAF a residual of 2e-5 tilt still flips hundreds
  of 1-LSB pixels along band edges and a same-settings control pair one second
  apart diffs 15k px.
- `page.screenshot({ clip })` only. Element screenshots wait on real animation
  frames for their stability check and hang against the stub.
- SwiftShader, `deviceScaleFactor: 1`, `colorScheme: dark`, tilt (0.35, −0.2).
- Canon truth is served from `data/foil-canon/*.json` by route interception.
  Without that the lab silently falls back to `patterns.ts` code defaults, and a
  render that quietly is not canon is worse than no render.

**Control pairs first.** Same tree, same aspect, same pattern, rendered twice:

| control | mean AE | px changed |
|---|---:|---:|
| before (245:337), cosmos | **0.0000** | 0 |
| after (63:88), cosmos | **0.0000** | 0 |

Bit-identical at both aspects. **The noise floor is exactly zero**, so every
number below is signal — which also means "above the noise floor" cannot be the
selection rule here. The ranking is.

## Reading the number

Diffs are taken on the **canvas clip**, which is a fixed rectangle. The card
clip is not: the harness sizes it from `CARD_ASPECT`, so the two renders would
not even be the same shape.

Two means are reported:

- **mean AE (interior)** — over a box inset 8 px inside the after-card rect,
  which lies strictly inside the card at *both* aspects. No card edge can fall
  in it, so this is the **pattern field alone**. **Rank on this.**
- **mean AE (card window)** — over a box containing the card at both aspects.
  Includes the card outline, which moved: `CardViewer` builds
  `PlaneGeometry(1, CARD_ASPECT)` and pulls the camera back with it, so the card
  is 1.55% narrower on screen after the bump. That term is roughly the same for
  all 32.

The two agree closely, which is itself informative: the outline is not what is
driving these numbers.

A `none`-pattern render would have isolated the geometry term outright, but the
canon lab's picker carries no `none` slug, so it could not be rendered. The
interior box does the same job by construction.

## The table

Ranked by mean AE inside the card, 0–255 per channel.

| # | canon | mean AE (interior) | mean AE (card window) | max AE | % px changed |
|---:|---|---:|---:|---:|---:|
| 1 | **confetti** | **47.804** | 47.507 | 234 | 40.88 |
| 2 | **fireworks** | **28.866** | 28.119 | 154 | 45.38 |
| 3 | **rainbow-glitter-sheen** | **16.861** | 17.126 | 241 | 43.55 |
| 4 | **gold-secret** | **15.567** | 15.656 | 224 | 50.33 |
| 5 | **cosmos-ii-pixel** | **13.326** | 13.246 | 240 | 32.08 |
| 6 | **rainbow-glitter** | **12.530** | 12.921 | 241 | 40.00 |
| 7 | **big-glitter** | **11.298** | 11.485 | 168 | 37.75 |
| 8 | cosmos-iii-smooth | 9.773 | 10.127 | 155 | 36.25 |
| 9 | striped-vertical-sheen | 9.725 | 9.687 | 144 | 28.53 |
| 10 | reverse-sheet | 9.566 | 10.216 | 184 | 32.41 |
| 11 | starlight | 9.217 | 9.524 | 228 | 42.78 |
| 12 | pokeball-hologram | 8.887 | 9.696 | 241 | 39.13 |
| 13 | starlight-ii | 8.381 | 8.738 | 241 | 42.76 |
| 14 | pinwheel | 7.503 | 7.699 | 149 | 42.90 |
| 15 | shiny-vault | 6.905 | 7.815 | 241 | 47.46 |
| 16 | radiant-collection-dots | 5.571 | 5.792 | 237 | 18.59 |
| 17 | water-web | 5.379 | 6.416 | 196 | 42.57 |
| 18 | radiant | 4.683 | 5.097 | 124 | 30.62 |
| 19 | sequin | 4.341 | 4.831 | 228 | 19.45 |
| 20 | cracked-ice | 3.983 | 4.502 | 169 | 21.73 |
| 21 | vertical-sheen | 3.585 | 4.154 | 158 | 30.72 |
| 22 | cosmos | 3.433 | 3.706 | 234 | 32.81 |
| 23 | vstar-pearl | 3.000 | 4.464 | 241 | 45.60 |
| 24 | ex-emerald | 2.974 | 3.416 | 115 | 37.39 |
| 25 | horizontal-sheen | 1.891 | 2.628 | 158 | 40.20 |
| 26 | diagonal-sheen-right | 1.503 | 2.199 | 134 | 38.07 |
| 27 | mirror | 1.440 | 2.399 | 142 | 39.31 |
| 28 | vertical-sheen-rainbow | 1.222 | 2.440 | 198 | 32.07 |
| 29 | diagonal-sheen-left | 1.127 | 1.898 | 195 | 33.23 |
| 30 | tinsel-ii | 1.120 | 1.554 | 101 | 25.38 |
| 31 | tinsel | 1.074 | 1.568 | 193 | 21.22 |
| 32 | detective-pikachu | 0.482 | 1.103 | 113 | 32.13 |

**min 0.482 · median 5.475 · mean 8.219 · max 47.804**

## The ones that are named

**Every canon moved** — the floor is 0 and the smallest change is 0.482, so
there is no "unaffected" bucket to hide in. Naming therefore uses the
distribution, not the floor: **the seven above twice the median (> 10.95)**.

> **confetti, fireworks, rainbow-glitter-sheen, gold-secret, cosmos-ii-pixel,
> rainbow-glitter, big-glitter**

The top two are in a class of their own: **confetti at 47.8 is 8.7x the median
and nearly 100x the least-affected canon**, and fireworks at 28.9 is 5.3x.

**The prediction held.** The spec expected "the recipes with tuned cell geometry
rather than a global scale" to be most exposed, and that is exactly the head of
this list: confetti, fireworks, the three glitter recipes and cosmos-ii-pixel
are all discrete-element recipes whose cells are laid out against
`vec2(1.0, CARD_ASPECT)`. Squeezing that denominator by 1.55% does not scale
such a field — it re-lays it out, and elements land in different places. The
tail is the sheen family (tinsel, the diagonal/vertical/horizontal sheens,
mirror), which carry a global directional gradient: a 1.55% change in the
denominator moves a smooth ramp by a hair and moves nothing else.

`detective-pikachu` at the bottom is unsurprising for a second reason: it is the
one recipe that samples `uFace` inside `foilPattern()` (the documented purity
exception), so more of what it draws is keyed to the scan than to card-space
geometry.

## What happens next

**Retuning is queue work and is deliberately not done here.** Contract 2 is
stamped on all 32 files with `tunedUnderContract: 1` beside it, so the queue can
find them mechanically: any file where the two differ has not been looked at
since the law moved. Rechecking is per-canon and each one is independent — the
head of this table is where an hour of Chey's eye moves the most pixels.

## Reproducing

```bash
# no database, no api — the lab renders a blank base from source alone
node tools/parity/serve.mjs

# playwright is deliberately not a repo dependency
PW_ROOT=<somewhere>/package.json \
node ../../tools/parity/run.mjs \
     --out <dir> [--phase before|after|diff|both]
```

The pass edits `era-layouts.json`'s `cardAspect` to render the "before" and
restores it in a `finally` block. ~30 minutes for a full pass; `--phase` exists
because a half that already landed should not have to be re-shot. The PNGs are
~40 MB and are not committed; `results.json` carries every number in this table.

---

## Re-verification, 2026-09-01 (Holo 4b verification round)

**Why.** The verifier found the driver ran the harness with
`stdio: ['ignore', 'ignore', 'inherit']` — stdout discarded. The harness's JSON
report is where `canon.applied` and `pageErrors` live, so **neither was ever
asserted** on the original pass. Every number in the table above rested on "the
PNG exists". The lab silently falls back to `patterns.ts` code defaults when the
canon fetch fails, so a render that quietly was not canon would have produced a
number about the wrong thing and nothing would have said so.

**The fix.** `canon-aspect-recheck.mts` now captures the harness's stdout, parses
the report, and **throws** on any of: unparseable report, a non-empty
`pageErrors`, a rendered pattern that is not the requested one, `canon.applied`
anything but `true`, or fewer frames run than requested. The per-render evidence
is written into `results.json` under `renders`, beside the numbers it produced. A
`--only` flag was added so a spot set does not need a 30-minute full pass.

**The spot set.** Six canons spanning the table — the two named heads
(`confetti`, `fireworks`), the tail (`detective-pikachu`), the reference
(`cosmos`), one sheen (`horizontal-sheen`) and `mirror` — re-shot at **both**
aspects with the fixed driver, plus both control pairs. 14 renders.

| | |
|---|---|
| `canon.applied === true` | **14 / 14** |
| page errors | **0 / 14** |
| frames run | 300 / 300 on every render |
| canon files served to the lab | 32 per render, 2 requests each |
| control before / after (mean AE) | **0.0000 / 0.0000** — still bit-identical |

**Every number reproduced BIT-IDENTICALLY** against the published
`results.json` — not to 3 dp, but as identical float64 across all five metrics
per canon:

| canon | mean AE (interior) | mean AE (card window) | max AE | % px changed | vs published |
|---|---:|---:|---:|---:|---|
| confetti | 47.804 | 47.507 | 234 | 40.88 | identical |
| fireworks | 28.866 | 28.119 | 154 | 45.38 | identical |
| cosmos | 3.433 | 3.706 | 234 | 32.81 | identical |
| horizontal-sheen | 1.891 | 2.628 | 158 | 40.20 | identical |
| mirror | 1.440 | 2.399 | 142 | 39.31 | identical |
| detective-pikachu | 0.482 | 1.103 | 113 | 32.13 | identical |

So the published table stands, and it now stands on an assertion rather than on
an assumption. `era-layouts.json` came back to `[63, 88]` with no diff, as the
`finally` block promises.

```bash
PW_ROOT=<somewhere>/package.json \
node ../../tools/parity/run.mjs \
     --out <dir> --only confetti,fireworks,detective-pikachu,cosmos,mirror,horizontal-sheen
```
