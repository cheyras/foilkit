# docs/

The **contract documents** — the specifications the code is written against and
that must version with it. A pattern only means something relative to a specific
`main()`, so the documents describing that law live in the repository and move
when it moves. A wiki changes on its own clock, which is the wrong clock for a
contract.

Working rule: **if a contributor would have it open while editing, it lives
here.**

| Document | What it specifies |
|---|---|
| [`SHADER-CONTRACT.md`](SHADER-CONTRACT.md) | The shader ABI — the assembly model, the pattern entry point, the full uniform contract, the composite law, and `contract:` versioning |
| [`PROVENANCE.md`](PROVENANCE.md) | The mask sidecar, `derivation_method`, review status, exemplar weighting, the ratchet, and the `supersedes` / `correction` distinction |
| [`MASK-PIPELINE.md`](MASK-PIPELINE.md) | How a mask is authored, generated, corrected and archived — and the invariants that stop a machine overwriting a person |
| [`TAXONOMY.md`](TAXONOMY.md) | The 45 patterns: what each one physically is, which printings carry it, and how the recipe models it |
| [`VERIFICATION.md`](VERIFICATION.md) | The renders judged against the reference corpus — the run, the rubric, every verdict with its score and discrepancies |
| [`CANON-ASPECT-RECHECK.md`](CANON-ASPECT-RECHECK.md) | The composite-contract 1 → 2 recheck: per-canon delta, which ones a human should look at, and in what order |

`canon-aspect-recheck.json` is the machine-readable form of the last one.

Four of these were written inside DeckPal, where the foil work began, and were
carried here with their paths updated and their measurements untouched. Each
says so at the top, along with what to make of the DeckPal-only HTTP surfaces
they describe. `PROVENANCE.md` was authored here, out of
`packages/forge/src/provenance.ts` and the mask-pipeline sections covering the
same ground.

Two documents named in the pre-extraction plan for this directory did not land:
`RESOLVER.md` and `PATTERNS.md`. Both would be API-surface documentation for
packages that currently carry README files instead, and writing them ahead of
the hosted editor would be describing an interface nobody has used yet.

## The wiki half

Narrative, research and history live in the
[wiki](https://github.com/cheyras/foilkit/wiki) and change on their own clock:
`Home`, `Pre-History`, `Foil-Taxonomy`, `Shader-Contract`, `Provenance-Model`,
`Decision-Log`, `Contribution-Record`.

Where a wiki page has a companion here, **the document here is canonical** and
the wiki page says so in its first line, labelling itself a snapshot or a
deep-dive. Update the pair together — a stale document is worse than no
document, because it actively misleads.

Documentation in this directory is MIT, per `REUSE.toml`.
