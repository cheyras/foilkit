<!-- SPDX-License-Identifier: CC0-1.0 -->
<!-- SPDX-FileCopyrightText: 2026 Chey Rasmussen -->

# Ink-tile notice

Follows `NOTICE-CONVENTIONS.md`. This directory is a **drop slot** as that
document defines one — files can land here without review — so the rule is
stated before the first file arrives, not after.

## 1. What this covers — and the claim

Every file in `data/ink-tiles/`. Today:

| File | Geometry |
|---|---|
| `dot-grid.svg` | one centred disc, r = 38% of the cell |
| `ring-dot.svg` | an annulus (r 34% / 29%) around a centred disc, r = 9% |
| `pinstripe-diagonal.svg` | a 45° band, 26% duty, corner to corner |
| `crosshatch.svg` | two orthogonal bars, 16% wide, edge to edge |

**The claim.** These are hand-written SVG path and shape elements, authored for
this project from stated numbers. Nothing here was traced, auto-traced,
extracted, or derived from any card scan, game rip, asset dump, or third-party
vector set. Every coordinate in every file is a round percentage of the cell,
which is a checkable claim: a traced curve does not land on `r="38"`.

The distinction that matters, and the one this directory is built around:

- **Measuring a period is a measurement.** "The design repeats every 43 px in
  canonical space" is a fact about a physical object, and facts are not
  copyrightable. Those numbers live in `data/ink-designs.json` as placement
  parameters and are CC0 without qualification.
- **Drawing the mark is authorship.** A traced Poké Ball is TPCi's design no
  matter who ran the tracer. Recognisable marks therefore do **not** enter this
  directory as tracings; they enter as original recreations with their own
  notice, or they do not enter at all.

## 2. Why it is original — the research trail

The question this tier had to answer first was whether a reverse-holo design
could be recovered from imagery already available, in which case authoring
anything would have been the wrong move.

> **TCGdex catalog scans (`assets.tcgdex.net/en/**/high.png`), n = 7.**
> Autocorrelation of high-passed luma over the sheet band (the card body below
> the art window) at lags 4–80 px. Peak signal-to-noise **1.41–1.88** on every
> scan, with the peak sitting at lags 7–14 px — an adjacency artefact of the
> high-pass, not a design period. **Instrument validated by a positive
> control**: the same measurement on a scan with `reverse-sheet`'s own ring+dot
> lattice stamped into it (uP0 = 11) returns lag **54 px** at SNR **7.85**, the
> predicted 600/11 = 54.5. Two of the seven were cards with **no non-reverse
> printing at all** (`basep-33`, `pl1-SH4`), and they read the same as the rest.
> **Conclusion: catalog scans do not carry a printed reverse design. There is
> nothing to recover. Rejected as a source.**

> **The glyph slot (`assets/glyphs/`, R3-GLYPH).** Real, adjacent, and the right
> shape — but empty, and empty for the same ownership reason. It is also
> keyed per PATTERN, and the whole finding of this subtask is that the design is
> not a property of the pattern: a dozen visually different reverses sit on one
> vertical-sheen sheet. **Right mechanism, wrong key. Rejected as a home for
> these, kept as the precedent for how a slot behaves when it is empty.**

> **Auto-tracing a reverse-holo photograph.** The maintainer's own rectified
> 504 × 704 photographs (holo-archive `3b-pairs`) do show a real reverse
> printing. Tracing them would produce the actual TPCi layout, which is exactly
> the thing `AGENTS.md` F2 forbids, and a CC0 dedication over it would be worth
> nothing. **Rejected on ownership, not on quality — it would have worked.**
> What was taken from those photographs instead is a *number*: see §5.

> **Generic geometry — dots, rings, pinstripes, crosshatch.** Uncopyrightable
> by construction; no source needed and none used. **Accepted**, and this is
> what shipped.

## 3. Who authored it

Claude Fable 5, on behalf of @cheyras, 2026-09-07, in the same commit as the
ink-design tier itself. The commit trailers name the same pair.

## 4. License

Released into the public domain under **CC0 1.0**
(<https://creativecommons.org/publicdomain/zero/1.0/>), SPDX `CC0-1.0`.

Covered by `REUSE.toml`'s `data/**` glob, which is what licenses the SVG
binaries — an SVG can carry a comment, but the glob is what a scanner reads.

We can dedicate these because we hold them outright: the geometry is ours and
the placement numbers are measurements. That is exactly the standing test
`AGENTS.md` F2 sets, and it is why a traced tile could never have shipped under
the same glob.

## 5. Trademark note

"Pokémon", "Poké Ball", "Master Ball", the Team Plasma insignia and the
individual energy-type symbols are trademarks of Nintendo / The Pokémon Company.
**None of them is in this directory.** The tiles here are generic lattice
geometry and evoke nothing in particular.

The registry (`data/ink-designs.json`) names those marks in its `queued` list
with the slot left **empty**, so the affected printings render the procedural
fallback and the task queue carries the work with this caution attached. A
queued slot is the honest state; a traced one would not be. Filling one means
authoring an original recreation and adding its own notice section here **in the
same commit** — never "to be added later".

Neither MIT nor CC0 can grant a right the grantor does not hold, and this
dedication grants nothing over any third-party mark.

## 6. The drop rule

1. **Originals only.** No traced, extracted, auto-traced or derived third-party
   marks, whatever the tool and whatever the intent.
2. **Every file arrives with its notice**, in the same commit — a row in §1 and,
   for anything evoking a mark, a paragraph in §5.
3. **The fallback when that cannot be met:** leave the slot empty. The registry
   row keeps its placement parameters, `uInkOn` stays 0 for that key, the recipe
   renders its procedural fallback, and the task queue shows the gap. Nothing
   ships. This is the important one — a drop slot with no fallback eventually
   receives something it should not, and the pressure at that moment is to ship
   it anyway.
