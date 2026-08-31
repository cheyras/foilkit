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

**Pre-extraction.** This repository currently holds the license split, the
engineering contracts and the documentation skeleton. The library packages —
`core`, `three`, `webgl2`, `element`, `react`, `patterns`, `resolver`, `masks` —
land in a subsequent extraction pass from their origin repository, along with
45 pattern recipes, 32 canon files, the mask corpus and the resolver.

Nothing is installable yet. Issues and discussion are open.

## The license split

Two licenses, split by **file** rather than by package:

| | License | Where |
|---|---|---|
| **Code** | MIT | `packages/**` — TypeScript, JavaScript, GLSL, tooling |
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
| [`docs/`](docs/) | Contract documents — the shader ABI, the provenance model, the resolver tiers (arriving with the extraction) |
| [Wiki](https://github.com/cheyras/foilkit/wiki) | Narrative, research and history: the pattern taxonomy, the provenance model deep-dive, pre-history |
| [`DECISIONS.md`](DECISIONS.md) | Dated audit trail of every decision and correction |

## Origin

The foil work began inside [DeckPal](https://github.com/cheyras/deckpal), an
AGPL-3.0 TCG collection platform, and was extracted here by its sole author.
DeckPal will re-consume `@foilkit/*` as a pinned dependency once the library is
ready; the two projects are otherwise independent. The relicense record and the
authorship measurement behind it are in [`RELICENSE.md`](RELICENSE.md).
