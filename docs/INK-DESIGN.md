<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 Chey Rasmussen -->

# The reverse-holo ink design

**R8-INK, 2026-09-07.** The contract document for the second layer of a reverse
holo. Companion to `docs/SHADER-CONTRACT.md` (the composite law) and
`docs/TAXONOMY.md` (the 43 foil types).

---

## 1. The two layers, and why one file could not carry both

| | FOIL | DESIGN |
|---|---|---|
| What it is | embossed micro-texture in aluminium | opaque ink printed over that sheet, blocking it |
| Where it comes from | physics | an artist at TPCi |
| Correct model | a procedural GLSL recipe | an authored asset |
| Lives in | `packages/patterns` — the 43-type taxonomy | `data/ink-designs.json` + `data/ink-tiles/` |
| Converges? | yes | **no — there is nothing to converge to** |

The taxonomy conflates them, and the conflation is not cosmetic. Sceptile and
Magneton, and a dozen other reverses that look nothing alike, sit on the **same
vertical-sheen sheet**. Any amount of tuning applied to a procedural recipe will
approach the average of a set of designs that has no average, which is why
"patterned reverse holos look really bad" is a category error rather than a
tuning gap.

The resolver already half-knew this and threw the knowledge away. Both of its
tiers carry a `penaltyOf` that demotes `mirror` rows on reverse printings,
because the research corpus records them as *ink-design evidence, not foil
evidence* (`resolver.ts`; `data/foil-pattern-usage.json`'s own note). This tier
is where that evidence goes instead of being discarded.

---

## 2. The bug that was checked first — refuted, with numbers

The tier was commissioned with a hypothesis attached: that `reverse-sheet` draws
its ring-and-dot grid over a scan that **already contains** the printed design,
so the design is double-drawn and misregistered. That was checked before
anything was changed.

**Method.** Autocorrelation of high-passed luma (box high-pass, r = 6 px) over
the *sheet band* — the card body below the art window, where a reverse design
lives — at lags 4–80 px, against the art window as a control. n = 7 TCGdex
`high.png` catalog scans at 600 × 825.

**Instrument validation, first.** A metric that cannot see the thing it is
asked about is not evidence of absence, so the same measurement was run on a
scan with `reverse-sheet`'s **own** lattice stamped into it at its default
density (uP0 = 11):

| Case | peak lag | acf | SNR |
|---|---|---|---|
| positive control (lattice stamped in) | **54 px** | 0.241 | **7.85** (art window) |
| predicted period, 600 / 11 | 54.5 px | — | — |

The instrument finds the lattice, at the predicted period, at SNR 7.85.

**Result on real scans.**

| Scan | what it is | sheet-band peak | SNR |
|---|---|---|---|
| `sv08.5-040` | Prismatic Evolutions Sylveon — 6 variants, 3 of them reverses | 37 px | 1.63 |
| `sv03.5-095` | 151 Onix — normal + reverse | 9 px | 1.88 |
| `sv01-001` | SV base | 11 px | 1.50 |
| `swsh1-1` | SWSH base | 7 px | 1.80 |
| `bw2-1` | BW Emerging Powers — the Energy Pattern era | 14 px | 1.60 |
| `basep-33` | **reverse-ONLY card** (2002 Wizards promo) | 10 px | 1.47 |
| `pl1-SH4` | **reverse-ONLY card** (Platinum SH) | 11 px | 1.41 |

**SNR 1.41–1.88 on every one**, with peaks at 7–14 px — the adjacency length of
the high-pass residual, not a design period. Two of the seven have **no
non-reverse printing at all**, so their scan can only be of a reverse, and they
read the same as the rest.

**Verdict: REFUTED as stated.** Catalog scans do not carry a printed reverse
design. They are the normal printing, per the TCGdex convention that one image
serves every variant of a card — `sv08.5-040` serves six.

**Three things survive the refutation, and they are why the tier still exists.**

1. **The real defect is worse than double-drawing.** The design is not drawn
   twice; it is drawn from *nothing at all* — a ring-and-dot lattice at a
   density nobody measured, over the whole sheet at uniform spacing, matching no
   actual reverse design. Then `inkGlyph`/`inkDetail`, which read local contrast,
   punch holes in it wherever the printed text happens to be. That is
   misregistration, just not the kind predicted.
2. **The double-draw hazard is real and was completely unguarded.** Nothing in
   the compositor consulted `shows`. The first image that *does* carry a reverse
   printing — subtask 14's community captures, a catalog re-shoot, one of the 29
   reverse-only cards getting a better scan — would have been drawn on twice
   with nothing to stop it. `uInkDraw` is that guard.
3. **The finding is itself the answer to "what should `shows: unknown` do".**
   See §5.

Reproduce it: the scans are cited, not vendored (`AGENTS.md` F2). Fetch them to
the gitignored `reference-media/` from the URLs in the table above
(`https://assets.tcgdex.net/en/<series>/<set>/<number>/high.png`) and run the
autocorrelation described here.

---

## 3. The key: `(scope, type, variantKind)` + rarity

Resolving **card > subset > set > era** — the same most-specific-wins ladder
`lookupAssignment` already uses, with `subset` promoted from an escape hatch to
a real tier.

It is deliberately **not** `(era, type)`. Every one of these breaks that key:

| Case | What breaks |
|---|---|
| **Prismatic Evolutions** `sv08.5` | three reverses of ONE card — standard, Poké Ball, Master Ball — on one sheet. TCGdex serves one image for all three, so the scan cannot separate them either. Only `variantKind` can. |
| **Black Bolt / White Flare** `sv10.5b` `sv10.5w` | the same three, twice more. |
| **Ascended Heroes** `me02.5` | **six** reverse kinds: plain, Poké Ball, Love Ball, Quick Ball, Friend Ball, Dusk Ball. |
| **Plasma sets** `bw8` `bw9` `bw10` | a Team Plasma shield replaces the type symbol on Team Plasma cards only — a *card-level* fact inside a set. |
| **EX Emerald → EX Power Keepers** | gold name, gold HP, silver rarity symbol gated on **rarity**, differently per set (3b `era-research.md` §4.4). |
| **EX Crystal Guardians** `ex14` | gold borders on **three named cards** and no others. That is the card tier, and it is why there is one. |
| **Energy Pattern eras** BW Emerging Powers → SV | the tile is keyed on the Pokémon's **type** — eleven of them, plus a Poké Ball for Trainers. "One tile per group" is really ~13. |

3b's scan-diff classes ride along on every row as `delta`:

* **`null`** — the same scan; only the pattern assignment differs. The three
  Prismatic reverses are the exemplar.
* **`frame`** — the design and the logo stroke sit outside the art window.
  Everything from Diamond & Pearl onward.
* **`full`** — the treatment crosses the window. Six sets: Legendary Collection,
  EX Hidden Legends, EX FRLG, EX Team Rocket Returns, EX Deoxys, EX Legend
  Maker (~577 English masters). Ten EX sets additionally stamp the set name
  *inside* the art box.

---

## 4. One tile plus placement, never a card-sized raster

`uInkTex` is **one lattice cell**. Alpha is ink coverage; RGB is unread.
Placement is eight numbers:

| Parameter | Meaning |
|---|---|
| `across` | tiles across the card **width** — a period a human can measure off a scan |
| `phaseX` / `phaseY` | lattice phase, in cells |
| `turns` | rotation about the card centre, in turns |
| `jitter` | per-cell positional jitter, in cell fractions |
| `stagger` | odd-row x offset in cells (0 = square grid, 0.5 = brick) |
| `strength` | how completely the ink blocks the foil, 0..1 |
| `tone` | how far the ink lifts the blocked field toward paper white |

A tile is a few hundred bytes and the placement is eight floats, so the whole
tier scales by construction. A per-card raster is a corpus that grows with the
catalog and can never be finished.

The lattice is built about the card centre in isotropic card space, so rotation
and phase mean the same thing at every card size, and `across` stays a
measurement rather than a number somebody nudged until it looked right.

---

## 5. `shows`, and what `unknown` does

`data/frames.json` carries `shows` on every image-source record. It reads
`unknown` on all 24, and its own `$doc` is explicit that this is **the finding,
not an unfilled field**: derived, never claimed. It also sets the rule this tier
obeys — *only a MEASURED `reverse` may suppress a compositor overlay.*

**So the default is `normal`, and it is an assumption, stated here so it can be
argued with:** every catalog scan is the normal printing, because TCGdex serves
one image per card and that image serves every variant. §2 measured it on n = 7
and found no printed design in any of them, including two cards with no
non-reverse printing at all. The assumption held on everything measured. It is
still an assumption.

The override is `data/ink-designs.json`'s `frameShows` map — frame id → `shows`
— and it is a **human ratchet** (`AGENTS.md` F4): an entry there beats the
generated value and no regeneration may remove it. It is **empty today**, which
is the honest state. Nothing has been measured to `reverse`, and inventing an
entry would be exactly the claim `frames.json` refuses to make.

The two gates it drives are separate on purpose:

| `state` | `uInkOn` | `uInkDraw` | Result |
|---|---|---|---|
| `none` — no row keys this printing | 0 | 0 | the recipe's procedural fallback — today's render, exactly |
| `queued` — a trademarked mark we may not trace | 0 | 0 | the same. An empty slot costs nothing |
| `no-ink` — a row, and a recorded decision that none is needed | 0 | 0 | the same, and it is **not** queued work |
| `design` — tile resolved, `shows` normal/unknown | 1 | 1 | the recipe stops guessing; the tile is drawn |
| `in-scan` — tile resolved, `shows` **measured** `reverse` | 1 | **0** | the recipe stops guessing; nothing is drawn — the scan already has it |

That last row is the whole point. Leaving `uInkOn` at 0 there would put the
ring-and-dot grid back on top of a printing that already has one.

**Three of the five report a null tile, and they are three different reports.**
`queued` says a drawing is outstanding; `no-ink` says one was considered and is
not wanted; `none` says nothing keys this printing at all. Flattening them is how
Legendary Collection — whose row *records* that it needs no tile — spent a
release announcing itself as work nobody owed.

**An unkeyed series resolves to `none`, and draws nothing.** `era-layouts.json`
measures three eras (`wotc`, `modern-swsh`, `modern-sv`) across eight of the
catalog's twenty-one series. The era lookup used to fall back to `modern-sv`,
which handed the other thirteen — **6,963 of 13,165 reverse printings, 52.9%** —
the SV dot grid at strength 0.8 on no evidence whatsoever: the drawn-from-nothing
defect this tier exists to end, one layer up. Set- and card-scoped rows still
answer for those series (`ex8` and `ex11` are keyed by SET, and the `ex` series
needs no era mapping to reach them). A new era mapping belongs in that table only
when a row exists to serve it — it is also the FOIL resolver's art-window table,
so a slug added for the ink tier's benefit would silently move foil geometry too.

---

## 6. Ownership: what shipped, what is queued

`data/ink-tiles/INK-TILES-NOTICE.md` is the notice; this is the summary.

The line is between **measuring** and **drawing**. "The design repeats every
43 px in canonical space" is a fact about a physical object and facts are not
copyrightable — those numbers are CC0 without qualification. Drawing the mark is
authorship, and a traced Poké Ball is TPCi's design whoever ran the tracer.

**Shipped — generic lattice geometry, uncopyrightable, every coordinate a round
percentage of the cell:** `dot-grid`, `ring-dot`, `pinstripe-diagonal`,
`crosshatch`.

Two of those four — `ring-dot` and `pinstripe-diagonal` — are **drawn but not
keyed**: no row reaches them, because no measurement yet says which era or set
carries that mark rather than a plain dot. That is a legitimate state and it is
DECLARED, in `unkeyedTiles` with the reason, because the alternatives are
somebody deleting the asset as dead weight or keying it to an era on a hunch —
and the second is the drawn-from-nothing defect again.
`tools/build-ink-index.mjs` cross-checks the declaration against the rows in
both directions, so it cannot rot either way.

Every tile is also measured for its **seam** on each build
(`tools/ink-tile-seam.mjs`): a tile is one lattice cell and the shader repeats
it, so whatever leaves one edge must arrive at the opposite edge at the same
offset. `pinstripe-diagonal.svg` shipped with its corner-wrap triangles drawn at
half the size the geometry needs and measured a mean |Δcoverage| of 66/255
across its own wrap — a grid line down every card it was used on, in a file that
read as perfectly reasonable and whose own `desc` said "tiles seamlessly". Only
0 passes now.

**Queued — the slot ships EMPTY and the printings render the procedural
fallback:** `pokeball`, `masterball`, `specialty-balls` (Love/Quick/Friend/Dusk),
`plasma-shield`, `energy-symbols` (eleven types), `ex-set-logos` (ten sets).

Each appears on the contribution queue as an `ink-tile` task with the
`originals-only` guard and a new `art` skill. **A queued slot is a working
state, not a gap** — `uInkOn` stays 0 for that key and the render is unchanged —
so the count going to zero is not the goal; every queued mark carrying its
caution is.

`ex-set-logos` is recorded but is **not a tile this schema can express**: a
set-name logo stamped bottom-right inside the art box is a single positioned
stamp, not a lattice. It needs the second small positioned layer 3b names, and
that is a separate piece of work.

Our own tiles are CC0 in `data/` under the existing `data/**` glob. We can
dedicate them because we hold them outright — the geometry is ours and the
placement numbers are measurements. That is exactly the standing test F2 sets,
and it is why a traced tile could never have shipped under the same glob.

---

## 7. Why this was not a composite-contract bump

The contract versions *the law that turns a stored uniform snapshot into pixels*.
No stored snapshot changed meaning:

* every ink uniform is in `STRUCTURAL_DEFAULTS`, not `GLOBAL_DEFAULTS`, so a
  canon file cannot contain one (`data-receipt.mjs` fails CI on a canon file
  carrying a non-contract uniform);
* `uInkOn` defaults to 0 and every added instruction is inside its branch;
* the recipe that yields does so only when the gate is on.

Proven rather than argued: `tools/parity` rendered all 45 recipes on the blank
base before and after — **45/45 byte-identical**, against a control pair that was
itself 45/45. A byte-identical render under an unchanged law is not a contract
change, so nothing was bumped and no canon recheck was owed.

**What that proof does NOT cover, and it cost a render to learn.** The parity
harness renders a blank base (`uScanBase 0`). The ink layer only does anything
on a real scan, so 45/45 byte-identical says the layer is inert where it should
be inert and says *nothing whatever* about whether it is correct where it is
active. The first version painted the design straight across the **art window** —
`sheet` scope is the era rect INVERTED, so the mask is 0 over the illustration,
and ink printed on a foil sheet cannot exist where there is no sheet. Every test
passed. Parity was 45/45. Looking at the picture is what found it (`AGENTS.md`
F7). The fix scopes the coverage to the mask before the mask is reduced by it,
and the mask term is now pinned by a test.

Measured on a real SV reverse scan after the fix, split by region — meanAE over
the card rect, art window against sheet:

| Comparison | art window | sheet |
|---|---|---|
| plain scan → today's render (`uInkOn 0`) | 0.456 | 13.07 |
| today's render → tier on, nothing to draw | 0.015 | **1.56** ← the procedural ring+dot guess disappearing, in isolation |
| today's render → the registered design | 0.091 | **8.82** |

The art window moves 0.015–0.091 in every case, which is the mask feather edge.

The structural reasons the no-op proof came out the way it did are pinned in
`packages/core/src/__tests__/ink-layer.test.ts` and
`packages/patterns/src/__tests__/ink-yield.test.ts`, so a change that would break
it fails in seconds instead of in ten minutes of Playwright. **If one of those
fails, run the parity harness — do not relax the test.**

---

## 8. Map

| File | What |
|---|---|
| `packages/core/src/shader.ts` | the uniforms, `inkCoverage()`, and the coverage multiply in `main()` |
| `packages/patterns/src/patterns.ts` | `reverse-sheet` yields its procedural stamps on `uInkOn` |
| `packages/resolver/src/ink.ts` | `resolveInk` — the keying, the tier ladder, the two gates |
| `packages/resolver/src/ink-index.json` | DERIVED. Regenerate with `tools/build-ink-index.mjs` |
| `data/ink-designs.json` | the registry — source of record |
| `data/ink-tiles/` | the tiles, and their notice |
| `packages/three/src/ink.ts` | tile → texture |
| `packages/three/src/stage.ts` | `CardConfig.ink`, pushed per frame |
| `apps/editor/src/FoilLab.tsx` | the reverse-scope panel and the placement sliders |
| `tools/task-queue/build.ts` | section 7 — the queued marks |
