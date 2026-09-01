<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 Chey Rasmussen -->

# Threshold evidence

**Corpus: n = 4 photographed pairs, 8 photographs, 2 sets, 1 era (modern-sv).
Measured 2026-08-31. Of those, 1 pair registers well enough for its numeric
delta class to be trusted.**

`README.md` said the delta classes were unmeasured, every threshold in
`diff.ts` was provisional at n = 0, and the blocker was the physical pair
capture. The pairs have now been shot and measured. This file records what
that produced. **No photograph is committed here or anywhere in this repo — the
numbers below are the whole of the record.**

## What changed in the code

**Nothing, in the thresholds.** `CHANGED_PIXEL_DELTA`,
`NULL_MAX_CHANGED_FRACTION`, `FRAME_MAX_INSIDE_CHANGED_FRACTION`,
`EDGE_MARGIN_PX` and `MAX_RESIDUAL_SHIFT_PX` keep the values they shipped with,
and this file explains why refitting them would have been worse than leaving
them alone.

**One thing, in the alignment guard.** `AlignmentReport` now carries
`peakContrast`, because the guard passed four pairs of which three were badly
misregistered. See "The alignment guard" below.

## The corpus

| Pair | Set / era | Printings | Question |
|---|---|---|---|
| A | modern-sv, 2024 basic energy | normal + reverse-holo | reverse vs normal |
| B | modern-sv, 2026 common | normal + reverse-holo | reverse vs normal |
| C | modern-sv, 2026 common | normal + reverse-holo | reverse vs normal |
| D | modern-sv, 2026 rare | **holo** + reverse-holo | reverse vs **holo** — a different question |

Pair A is a full-bleed basic energy card: the illustration runs to the frame, so
the era art window does not name a real boundary on it.

## Why the thresholds were not refitted

**`CHANGED_PIXEL_DELTA = 24` cannot work on photographs, and that is measured.**

It counts a pixel changed when max-abs RGB difference exceeds 24/255, a value
fitted against synthetic pairs where only the ink can differ. Between two
photographs of two physical cards, much more differs:

- **Exposure.** The per-channel least-squares gain taking the reverse printing
  onto its normal was **0.38–0.56 on three of the four pairs** — those reverse
  frames are two to three times brighter, because a foil sheet returns far more
  light to the lens. Only pair A was near unity (0.96 / 1.00 / 1.08).
- **Foil optics.** A holo surface's colour depends on its angle to the light.
- **Foil micro-texture.** The reverse's printed foil is dense high-frequency
  structure the normal does not carry at all.

The demonstration is pair A, the one that registered cleanly (band-pass NCC
0.967, zero-pixel residual shift, exposures matching within 4%). Its raw and
gain-matched difference images are **visually near-black** — its true ink delta
is small. The shipped threshold still marks **40.8%** of its art window changed
and `classifyDelta` returns `full`.

To bring pair A under the existing 2% `frame` ceiling, `CHANGED_PIXEL_DELTA`
would have to rise past **73/255**, which is the p99 of that pair's own
inside-window delta. A threshold set above the 99th percentile of the signal it
gates is not a threshold. **Refitting the ceilings would have encoded an
illumination artefact as a measurement.**

Gain matching alone does not rescue it: applying the fitted per-channel gain
moved pair A's inside-changed fraction from 43.2% to 40.8%, and moved the other
three *up*. Removing a global affine response does not remove angle-dependent
foil optics or foil texture.

## Measured numbers

Raw per-pixel RGB delta, art window from `era-layouts.json` `modern-sv`
(x 0.075, y 0.0981, w 0.85, h 0.3749), after a measured integer registration:

| Pair | reg NCC (fine / 4×) | changed inside | changed outside | inside mean / p99 | outside mean / p99 | class |
|---|---|---|---|---|---|---|
| A | **0.967 / 0.979** | 40.8% | 32.5% | 26.1 / 76 | 27.4 / 97 | `full` |
| B | 0.340 / 0.688 | 95.3% | 86.2% | 55.7 / 195 | 73.2 / 183 | `full` |
| C | 0.105 / 0.614 | 90.9% | 81.0% | 40.4 / 163 | 62.6 / 188 | `full` |
| D | 0.128 / 0.487 | 85.6% | 70.2% | 52.1 / 174 | 51.3 / 161 | `full` |

Structural delta — band-passed luma normalised by the card's own structural
standard deviation, so it is invariant to both gain and offset. Units are
standard deviations:

| Pair | mean inside | mean outside | outside/inside | frac > 1 sd inside / outside |
|---|---|---|---|---|
| A | 0.288 | 0.271 | 0.94 | 3.4% / 4.5% |
| B | 1.117 | 0.691 | 0.62 | 39.3% / 22.8% |
| C | 0.939 | 0.867 | 0.92 | 32.9% / 29.5% |
| D | 1.161 | 0.775 | 0.67 | 41.8% / 27.0% |

A frame-confined delta should show **more** change outside the art window than
inside — a ratio above 1. Pairs B, C and D are all below 1, which is backwards
for the hypothesis and is the signature of misregistration: the artwork carries
the most fine detail, so a few pixels of misalignment produce the largest
structural delta exactly there. On those three pairs the ratio is a registration
diagnostic, not a result.

## The alignment guard

**`checkAlignment` reported `aligned: true` for all four pairs, including three
whose band-pass NCC was 0.10–0.34.** That is a false pass, and the cause is
structural rather than a tuning error.

The guard correlates **raw luma**. For a normal-against-reverse pair, raw luma
is dominated by the very difference being measured — a whole foil sheet — so the
objective is nearly flat and its argmin is noise. Measured here, the best shift
improved the mean absolute residual by **under 1 unit out of ~35**, and several
reported shifts sat exactly on the guard's own ±12 search limit. A peak at the
edge of its search window, improving the objective by 3%, is not a registration.

`AlignmentReport` therefore now carries **`peakContrast`** — the best residual
minus the mean residual over the whole search window. It costs nothing to
compute, it was already implicit in the search, and it is what distinguishes a
real minimum from a flat field. A caller that wants a trustworthy guard should
require a peak that actually stands out, not merely a small shift.

The threshold `MAX_RESIDUAL_SHIFT_PX = 4` is left alone: it is a sensible bound
on *how far* a shift may be, and the defect was never the bound. The defect was
that a flat objective could satisfy it.

## Registration: the die-cut edge is not a sufficient datum

The single most useful thing this run measured, and it is a handoff to task 14
rather than a threshold.

Both halves of every pair were rectified through `rectify()` from independently
detected corners — the same code path throughout, no hand alignment. After that,
pair A registers at NCC 0.967 while pairs B, C and D register at 0.10–0.34 at
full resolution, rising to 0.49–0.69 at 4× downsample where the reverse's foil
micro-texture has averaged away. Pair C shows a stable **16 canonical px — 2 mm
— horizontal offset at every scale tested.**

Two physical causes, neither removable by better corner detection:

1. **Sleeves.** Cards are photographed in clear penny sleeves whose rim sits
   ~20 source px outside the card and is not reliably separable from it. The
   sleeve is open at the top, so the top edge is the least reliable of the four
   on every frame.
2. **Print centring variance.** Two copies of the same card have their printed
   content sitting differently inside the die cut. Edge-rectified copies of one
   card therefore do **not** have their ink in the same place.

**A capture pipeline that rectifies to the die cut alone will carry this error
into every contributed pair.** Content registration is required as a separate
stage.

## What is still unmeasured

- **The EX era (2003–2007).** Still zero pairs. This is where task 3b predicts
  the `full` class actually lives — EX Deoxys running the pattern across image
  and text, FireRed & LeafGreen's centre-card Poké Ball, Hidden Legends'
  background type symbol. Each must be tested explicitly rather than assumed.
- **The WOTC era.** Zero pairs, so `PLACEHOLDER_ART_WINDOW` and the `wotc` era
  rect remain untested against a photograph.
- **Full-face rarities.** No illustration rare, special illustration rare or
  full-art pair. Pair A is full-bleed and structurally similar, but it is a
  basic energy card and not a rarity.
- **A `null` or `frame` classification.** Every pair measured returned `full`,
  for the metric reasons above, so neither of the other two classes has yet been
  produced by a real pair. The classifier's three-way behaviour is still
  exercised only by the synthetic suite.

## What the run does establish

Independently of the classifier, direct inspection of the rectified tag block
confirmed a **frame-confined structural ink difference on 3 of 3 pairs from the
2026 set**: the set-code badge inverts between the two printings (black field
with white type on the normal, white field with black type on the reverse), and
the collector number, illustrator credit, rarity pip and flavour text all gain a
white knockout keyline on the reverse. On the holo-against-reverse pair the
treatment tracked the **reverse printing rather than the presence of foil**,
which is the useful direction for keying.

The basic energy card did not show the badge inversion; its badge is light on
both printings. n = 1, unresolved.

None of that came from a threshold. It came from looking at the rectified crops,
which is what the rectifier is for.
