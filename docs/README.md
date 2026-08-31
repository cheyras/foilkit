# docs/

Empty on purpose.

This directory holds the **contract documents** — the specifications that the
code is written against and that must version with it. They arrive with the
library extraction, not before, because a contract document written ahead of the
code it describes is a wish list.

Expected to land here:

| Document | What it will specify |
|---|---|
| `SHADER-CONTRACT.md` | The shader ABI — assembly model, the pattern entry point, the full uniform contract, the composite law, and `contract:` versioning |
| `PROVENANCE.md` | The mask sidecar format, `derivation_method`, review status, exemplar weighting, and the `supersedes` / `correction` distinction |
| `RESOLVER.md` | The tier structure that maps a printing to a pattern, and how an assignment records its match tier and confidence |
| `MASK-PIPELINE.md` | How a mask is authored, generated, corrected and archived — and the invariants that stop a machine overwriting a person |
| `PATTERNS.md` | The pattern catalogue as an API surface: ids, parameters, canon files |

Until they exist, the wiki carries the narrative versions:

- [Shader Contract](https://github.com/cheyras/foilkit/wiki/Shader-Contract)
- [Provenance Model](https://github.com/cheyras/foilkit/wiki/Provenance-Model)
- [Foil Taxonomy](https://github.com/cheyras/foilkit/wiki/Foil-Taxonomy)

Those pages are deep-dives and stay useful after the contract documents land —
but once a document here exists, **it is canonical** and the wiki page says so in
its first line. Do not let the pair disagree.

Documentation in this directory is MIT, per `REUSE.toml`.
