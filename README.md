# foilkit

**A dataset with a renderer attached.**

foilkit is a corpus of measurements of how real trading-card foil behaves —
which pattern a given printing actually carries, where the foil actually sits on
the card face, how it actually moves under tilt — together with a WebGL
renderer that makes those measurements visible.

The framing matters, because it is the opposite of how these libraries usually
work. A foil shader with a few sample cards is a demo. The value here is the
**mapping from real printings to accurate foil**, across eras and rarities and
reprints, built from scans of physical cards and hand-corrected where the rules
guessed wrong. The shader is what renders the answer; the dataset is the answer.

## Status

**Extracted, not released.** The library and the corpus landed on 2026-09-01,
moved out of the repository the foil work began in. Nothing is published to npm
and every package is `0.0.0` — but the code runs, the tests pass, and the
measurements are here.

| | |
|---|---|
| [`packages/core`](packages/core/) | The shader ABI — canonical card space, the uniform contract, `PREAMBLE + pattern.glsl + MAIN`, canon layering. **Zero dependencies, no renderer.** |
| [`packages/patterns`](packages/patterns/) | The 45 recipes as data, individually importable. |
| [`packages/stage`](packages/stage/) | Many cards on one renderer, as policy: the budget ladder, the six tilt sources, the frame schedule, the texture sizing. **Zero dependencies, no renderer.** |
| [`packages/three`](packages/three/) | The three.js binding — `FoilStage` (one canvas, one context, any number of cards), the material, plus the React card viewer and the mask/window drawing surfaces. |
| [`packages/resolver`](packages/resolver/) | Which foil a printing carries. Pokémon-specific and optional by construction. |
| [`packages/forge`](packages/forge/) | The authoring stack: provenance, the mask corpus, the generator, edge tracing, vector templates. `node:` builtins only. |
| [`data/`](data/) | 32 canon files, 21 card directories of masks in canonical 504 × 704, the frame registry, the resolver's cited evidence. |
| [`tools/rectifier`](tools/rectifier/) | Four detected corners into a canonical raster, and the pair diff that needs it. |
| [`tools/parity`](tools/parity/) | The frame-stepped zero-delta render harness. |
| [`apps/demo`](apps/demo/) | The stress demo: several hundred cards, one WebGL context, both presentation modes, every tilt source, a live ladder readout — and the acceptance run that asserts all of it. |

`packages/webgl2`, `element` and `react` are not built yet. The one obligation
the extraction carried for them is already met: `core`, `patterns` and `stage`
import nothing from three.js, and CI proves it on every push, so each of them is
a later *addition* rather than a later rewrite — and each inherits "one
renderer, any number of cards" instead of reimplementing it.

**The move came with a receipt.** 45 of 45 recipes render byte-identically
before and after; 177 tests pass; the resolver returns an identical digest over
10,312 probes built from the assignment corpus itself; and `core` compiles and
runs with three.js absent from `node_modules`. See [`RECEIPT.md`](RECEIPT.md).

```
pnpm install
pnpm test          # 177 tests, no build step
pnpm run build
```

Issues and discussion are open.

## The license split

Two licenses, split by **file** rather than by package:

| | License | Where |
|---|---|---|
| **Code** | MIT | `packages/**`, `tools/**` — TypeScript, JavaScript, GLSL, tooling |
| **Data** | CC0-1.0 | `data/**`, every `*.canon.json`, resolver tables, mask images |

Drop the code in a storefront and MIT gets you through legal review. Take the
whole dataset and do anything at all with it — CC0 asks nothing of you, not even
attribution.

The split is declared machine-readably in [`REUSE.toml`](REUSE.toml) (REUSE
specification 3.3), because a prose sentence is what a human reads once and a
license scanner never sees. Source files also carry
`SPDX-License-Identifier` headers; JSON and PNG cannot, which is what the
`REUSE.toml` globs are for.

Why MIT for the code and not CC0 for everything: **CC0 contains no patent grant
and explicitly disclaims one**, and a number of corporate legal teams block
CC0-licensed software outright. The full reasoning, along with the authorship
record behind the relicense, is in [`RELICENSE.md`](RELICENSE.md).

Neither license grants any right in a third-party trademark. Card names, set
names and "Pokémon" are TPCi trademarks, used here only to identify which
printing a measurement describes. See [`NOTICE`](NOTICE).

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first. The short version:

- Code contributions need a **DCO sign-off** (`git commit -s`).
- Data contributions need a sign-off **and an explicit CC0 dedication**, because
  a sign-off certifies your right to submit and does not place anything in the
  public domain. The pull-request template carries the dedication as a required
  checkbox.
- **Ship nothing we do not own outright.** Third-party material comes in by
  source and reference, never by copy. See
  [`NOTICE-CONVENTIONS.md`](NOTICE-CONVENTIONS.md).

[`AGENTS.md`](AGENTS.md) is the engineering contract — it applies to human and
AI contributors alike.

## Documentation

| Where | What |
|---|---|
| [`docs/`](docs/) | Contract documents — the shader ABI, the provenance model, the mask pipeline, the pattern taxonomy, the verification run |
| [Wiki](https://github.com/cheyras/foilkit/wiki) | Narrative, research and history: pre-history, the deep-dive companions, the contribution ledger. Where a wiki page has a companion in `docs/`, **the document in `docs/` is canonical** |
| [`DECISIONS.md`](DECISIONS.md) | Dated audit trail of every decision and correction |
| [`RECEIPT.md`](RECEIPT.md) | The moving receipt — the evidence that the extraction changed nothing |
| [`reference/`](reference/) | The foil reference corpus: notes, specs, and a script that fetches the media it cites |

## Origin

The foil work began inside [DeckPal](https://github.com/cheyras/deckpal), an
AGPL-3.0 TCG collection platform, and was extracted here by its sole author.
DeckPal will re-consume `@foilkit/*` as a pinned dependency once the library is
ready; the two projects are otherwise independent. The relicense record and the
authorship measurement behind it are in [`RELICENSE.md`](RELICENSE.md).
