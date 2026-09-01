# `@foilkit/resolver`

Which foil does this printing carry?

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

## The data

`era-layouts.json` holds the art-window rects per frame generation, measured in
canonical space. `assignments-index.json` and `usage-index.json` are trimmed,
bundle-friendly derivations of the cited research in `data/` — regenerate them
with `tools/build-assignments-index.mjs` and `tools/build-usage-index.mjs` after
any change to the research files, never by hand.

`RESOLVER_VERSION` is 5. It is recorded in every hand-mask sidecar's prior, so
the corpus states which rule version it was diffed against. Bump it whenever the
heuristics or the layout data change meaning.

Code is MIT; `era-layouts.json` and the two indexes are CC0-1.0, because they are
measurements. See `REUSE.toml`.
