# `@foilkit/forge`

The authoring stack: how a mask comes to exist, how its provenance is derived,
and how a generator learns from human corrections without learning from itself.

**Every import is a `node:` builtin.** The PNG codec is hand-rolled over
`node:zlib`. No sharp, no canvas, no database, no HTTP framework.

## Why it is not optional

A hand mask is a **teaching event**, not a deliverable. Every mask a human draws
is both a verification — "this is how this card truly is" — and training signal
about how its era handles foil. That is why `provenance`, the exemplar weighting
in `mask-corpus` and `region-learn`, and the generator travel together. Separate
them and the loop that makes the next generative pass smarter breaks.

## The modules

| | |
|---|---|
| `provenance` | Sidecar v4: the derived label, the ratchet, the supersede/restore path, `EXEMPLAR_WEIGHT`. Read `docs/PROVENANCE.md`. |
| `mask-corpus` | Reads the corpus, reports it, and `selectExemplars()` — the only sanctioned way to pick training masks. |
| `mask-artifacts` | Priors, diffs, and the artifact set a saved mask carries. |
| `png` | Decode and encode, over `node:zlib`. |
| `frames` | The frame registry: which transform an image source declares into canonical space. An image matching no record resolves to `unknown` and is refused for authoring — a silently wrong-frame mask is worse than a blocked one. |
| `image-dims` | Raster size from a file header, without decoding it. |
| `edge-trace` | Lands a wobbly hand line on the printed edge it was tracing. |
| `line-snap` | Reads a hand mask's *intent*: an ambiguous band may nudge an edge but never relocate it, and with no scan at all it degrades to self-straightening and says so. |
| `region-learn` | Fits an era rule from human exemplars. Takes the window edge on the foil side of the bevel, and refuses a detected edge beyond `windowMaxMovePx` as a different feature. |
| `vector-template` | Fits a finished raster mask to lines and arcs, measures `vectorness`, discovers optional elements across a corpus, and probes the artwork to decide whether one is present. |
| `template-raster` | Rasterises a vector template back out — at whatever size the card is, so a vector mask never goes stale when the canonical raster changes. |
| `generator` | The generator registry. |
| `analysis-source` | Fetches the scan a mask is authored over. The asset manifest is injected (`registerAssetPool`); without one, lookups fall back to the cache layout on disk. |

Four modules are **command-line entry points**, and are deliberately not
re-exported from the index because importing them runs them: `backfill`,
`corpus`, `fit-template`, `generate-masks`. Run them directly —
`node packages/forge/src/corpus.ts report`.

## The invariants, as tests

99 tests on `node:test`, no dependencies, no build step. They encode what the
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
