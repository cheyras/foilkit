# `@foilkit/forge`

The authoring stack: how a mask comes to exist, how its provenance is derived,
and how a generator learns from human corrections without learning from itself.

**Every import is a `node:` builtin.** The PNG codec is hand-rolled over
`node:zlib`. No sharp, no canvas, no database, no HTTP framework.

…which is why there is a second entry point. `@foilkit/forge` pulls `node:fs`,
`node:zlib` and `node:child_process`, so a browser cannot import it — and the
editor, needing forge geometry, hand-ported the functions into
`apps/editor/src/staging/provisionalDiff.ts` with a byte-parity test holding the
copy in step. **`@foilkit/forge/geometry`** exists so that stays the only one: it
re-exports the vector language, `pen-geometry`, the shared rasteriser and the
contour tracer, and nothing that reaches a builtin.
`tools/check-geometry-browser-safe.mjs` walks that subpath's import graph
transitively on every CI run, because the regression is never in `geometry.ts` —
it is a `node:` import added three modules down by someone with no reason to know
a browser reads their code. A statement-level `import type` is allowed and is
load-bearing: `line-snap` and `edge-trace` reach `png.ts` that way, and it erases.

## Why it is not optional

A hand mask is a **teaching event**, not a deliverable. Every mask a human draws
is both a verification — "this is how this card truly is" — and training signal
about how its era handles foil. That is why `provenance`, the exemplar weighting
in `mask-corpus` and `region-learn`, and the generator travel together. Separate
them and the loop that makes the next generative pass smarter breaks.

## The modules

| | |
|---|---|
| `provenance` | Sidecar v5: the derived label, the provenance tier, the ratchet, the supersede/restore path, `EXEMPLAR_WEIGHT_BY_TIER`. Read `docs/PROVENANCE.md`. |
| `mask-corpus` | Reads the corpus, reports it, and `selectExemplars()` — the only sanctioned way to pick training masks. |
| `mask-artifacts` | Priors, diffs, and the artifact set a saved mask carries. |
| `png` | Decode and encode, over `node:zlib`. |
| `frames` | The frame registry: which transform an image source declares into canonical space. An image matching no record resolves to `unknown` and is refused for authoring — a silently wrong-frame mask is worse than a blocked one. |
| `image-dims` | Raster size from a file header, without decoding it. |
| `edge-trace` | Lands a wobbly hand line on the printed edge it was tracing. |
| `line-snap` | Reads a hand mask's *intent*: an ambiguous band may nudge an edge but never relocate it, and with no scan at all it degrades to self-straightening and says so. |
| `region-learn` | Fits an era rule from human exemplars. Takes the window edge on the foil side of the bevel, and refuses a detected edge beyond `windowMaxMovePx` as a different feature. |
| `vector-template` | The stored vector language — lines, arcs and cubics — plus the fitter that turns a finished raster mask into it, `vectorness`, optional-element discovery across a corpus, and the artwork probe that decides whether one is present. The FITTER emits only lines and arcs; cubics exist because the pen tool draws them. Every consumer switches on the primitive kind exhaustively, with a `never`-typed default, so a fourth kind is a compile error rather than a silent misrender. |
| `pen-geometry` | The arithmetic under a pen tool, and no DOM: evaluate, project (Newton-refined for cubics), de Casteljau split, hit-test with anchor > handle > segment priority, nonzero-winding point test, and a bounding box tight to the curve rather than to the control hull. |
| `pen-engine` | The pen tool's BEHAVIOUR on the same terms: a pure `reduce(state, input, cfg)` state machine with no DOM, no framework and no `node:` builtin, so "feels like Illustrator" is driven by synthetic events in `node --test` rather than only by hand in a browser. Mirrors Illustrator's DOM exactly — absolute handle points, `pointType` as a stored flag — implements the click-precedence ladder as one ordered resolver that `cursorFor` also reads, and enforces its own `maxSnapMovePx` on an injected snap callback rather than trusting it. |
| `template-raster` | Rasterises a vector template back out — at whatever size the card is, so a vector mask never goes stale when the canonical raster changes. |
| `generator` | The generator registry. |
| `analysis-source` | Fetches the scan a mask is authored over. The asset manifest is injected (`registerAssetPool`); without one, lookups fall back to the cache layout on disk. |

Four modules are **command-line entry points**, and are deliberately not
re-exported from the index because importing them runs them: `backfill`,
`corpus`, `fit-template`, `generate-masks`. Run them directly —
`node packages/forge/src/corpus.ts report`.

## The invariants, as tests

207 tests on `node:test`, no dependencies, no build step. They encode what the
teaching loop runs on:

- derived provenance is recomputed on read, so a stale file cannot lie; a
  machine label requires a `GeneratorIdentity` an HTTP caller cannot supply;
  correcting an AI mask yields `ai-corrected` and carries the generator forward
  even when the client forgets the parent;
- a generator write onto an existing mask throws without an explicit supersede;
  restore returns the human mask byte-for-byte; a corrupt archive aborts before
  anything live is deleted;
- unreviewed `ai` masks can never become exemplars, at any corpus size, and an
  `ai-corrected` mask weights below a `hand` one;
- `vectorness` measures the mask rather than the tracer, and no unreviewed `ai`
  mask reaches the template fitter.

MIT. See `REUSE.toml`.
