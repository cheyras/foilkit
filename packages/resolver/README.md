# `@foilkit/resolver`

Which foil does this printing carry — and which design is printed over it?

```ts
import { resolveFoil, maskForScope, ERAS, RESOLVER_VERSION } from '@foilkit/resolver'

const guess = resolveFoil({
  seriesSlug: 'base',
  setId: 'base1',
  cardId: 'base1-4',
  rarity: 'rare holo',
  variantKind: 'holo',
})
// -> { patternId, scope, eraId, guess: { match, confidence, ... } }
```

**Pokémon-specific, and optional by construction.** Someone rendering Magic
cards wants the shader, not this — which is why `@foilkit/core` does not depend
on it, and why `CARD_ASPECT` derives from the millimetre datum rather than from
this package's `era-layouts.json`.

## Nothing is ever blank

Every foiled printing gets an answer. A card with no human attention is not
missing — it is **guessed**, and the guess is good enough to ship. `guess.match`
records which tier answered, most specific first: `card`, `facet`, `set`,
`series`, `heuristic`, with a confidence beside it. Human attention does not
fill a hole; it upgrades a guess to a decision.

## Scope

`FoilScope` is `window | sheet | full | none`, computed from the variant class
and overridable per assignment row:

- **`window`** — art-window holos, foil-facet prints, and the scope overrides
  (baby shinies, Detective Pikachu holos). Foil follows the artwork; this is
  where a hand mask earns the most.
- **`sheet`** — reverse holos. The era rect inverted, shared across thousands of
  printings.
- **`full`** — full-foil rarities, plus VSTAR-style overrides. Foil covers the
  face, so the layout tier already has it right by default.
- **`none`** — no foil, except where a card-level `normal`-class row overrides
  the catalog.

Every scope stays eligible for a hand mask. A shared rule is never provably right
until a person looks at the card — a `full`-scope card whose foil actually stops
at the text box is exactly the case only a human finds. Scope changes the
leverage of the work, never the permission to do it.

## The second axis: `resolveInk`

A reverse holo is two orthogonal things. The FOIL is embossed micro-texture in
aluminium — physical, so a procedural recipe converges on it, and that is what
`resolveFoil` picks. The DESIGN is opaque ink printed over that sheet, blocking
it: an artist's layout, which procedural will never converge on because there is
nothing to converge to — a dozen visually different reverses share one
vertical-sheen sheet.

```ts
import { resolveInk } from '@foilkit/resolver'

resolveInk({
  seriesSlug: 'scarlet-violet',
  setId: 'sv08.5',
  cardId: 'sv08.5-040',
  variantKind: 'reverse-foil-masterball',
})
// -> { tileId, state, placement, match, scope, delta, uInkOn, uInkDraw, ... }
```

Keyed on `(scope, type, variantKind)` with rarity, resolving
**card > subset > set > era**. Not `(era, type)`: Prismatic Evolutions ships
three reverses of one card on one sheet, Ascended Heroes six, and EX Emerald
onward gates ink on rarity per set.

`state` distinguishes three kinds of "no tile", and a caller that flattens them
will report a queued trademark as "nothing here":

- **`design`** — a tile resolved; draw it.
- **`queued`** — a row matched but its tile is a trademarked mark we may not
  trace. The slot is empty ON PURPOSE, `uInkOn` stays false, and the recipe
  renders its procedural fallback — today's render, exactly.
- **`in-scan`** — the image already shows the reverse printing, so drawing ours
  would double it. `uInkOn` stays TRUE here: the recipe must stop guessing too.
- **`none`** — no row keys this printing.

Contract document: `docs/INK-DESIGN.md`. It carries the measurement that refuted
the double-draw hypothesis, and the assumption behind `shows: unknown`.

## The data

`era-layouts.json` holds the art-window rects per frame generation, measured in
canonical space. `assignments-index.json`, `usage-index.json` and
`ink-index.json` are trimmed, bundle-friendly derivations of the cited research
in `data/` — regenerate them with `tools/build-assignments-index.mjs`,
`tools/build-usage-index.mjs` and `tools/build-ink-index.mjs` after any change to
the source files, never by hand. The ink builder also runs in CI with `--check`,
and validates the registry: a row naming a tile with no SVG on disk fails the
build rather than resolving to "no design here".

`RESOLVER_VERSION` is 5; `INK_RESOLVER_VERSION` is 1, versioned separately so a
change to one axis does not invalidate a corpus stamped against the other. It is recorded in every hand-mask sidecar's prior, so
the corpus states which rule version it was diffed against. Bump it whenever the
heuristics or the layout data change meaning.

Code is MIT; `era-layouts.json` and the two indexes are CC0-1.0, because they are
measurements. See `REUSE.toml`.
