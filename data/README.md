# data/

**Everything in this directory is dedicated to the public domain under
[CC0 1.0 Universal](../LICENSE-DATA).** No attribution, no permission, no
conditions. Take the whole corpus and do anything with it.

That grant is declared machine-readably by the `data/**` glob in
[`REUSE.toml`](../REUSE.toml), which is the *only* statement of it for most of
what lands here — JSON and PNG cannot carry a comment header. Do not remove that
glob; it is not a formatting change, it silently un-licenses the corpus.

Empty for now. The dataset arrives with the extraction:

| Directory | What it holds |
|---|---|
| `foil-canon/` | Per-pattern canon files — full uniform snapshots, hand-tuned against real scans |
| `foil-masks/` | The mask corpus: `<cardId>/<variantId>.png` (alpha = foil coverage) plus its provenance sidecar, the rule it was drawn against, and the diff between them |
| `foil-overrides/` | Per-card sparse diffs against a canon baseline |
| `foil-windows/` | Hand-adjusted art-window geometry, where the era rule was measurably wrong |
| `ink-tiles/` | The reverse-holo DESIGN layer's tiles: one lattice cell each, alpha = ink coverage. **A drop slot** — read its notice before adding one. Original geometry only; a recognisable mark is queued empty rather than traced |

Three committed files here are not measurements of a printing, and say so:

| File | What it holds |
|---|---|
| `verification-verdicts.json` | The **standing** yay/nay verdicts, extracted by hand from `docs/VERIFICATION.md` with the line numbers that justify each row. Update it in the same commit as any new judging wave |
| `task-queue.json` | The hosted editor's contribution queue — **generated** on every build by `tools/build-task-queue.mts` from seven other artifacts. Never hand-edited; CI's `--check` proves it matches its inputs |
| `ink-designs.json` | The ink-design registry: which printed design sits over which foil sheet, keyed `(scope, type, variantKind)` + rarity. The placement parameters ARE measurements and carry their `n`; the tile GEOMETRY is authored, and the marks we may not author sit in `queued[]` with the slot left empty. See [`docs/INK-DESIGN.md`](../docs/INK-DESIGN.md) |

## What is a measurement, and what is not

These files are observations of physical printings: which foil a printing
carries, where the foil sits on the card face, how the composite has to be tuned
to sit correctly on a scan. That is why they are CC0 and the renderer is not —
see [`RELICENSE.md`](../RELICENSE.md).

Two things follow, and both are contracts rather than preferences:

- **No third-party bytes, ever.** No card artwork, no scans, no logos, no game
  rips. A mask is coverage data — a single alpha channel saying where foil is —
  not a picture of a card. Reference imagery is cited with a fetch procedure;
  the pixels do not ship. See [`NOTICE-CONVENTIONS.md`](../NOTICE-CONVENTIONS.md).
- **A contributed measurement needs an explicit CC0 dedication**, not merely a
  DCO sign-off. A sign-off certifies your right to submit; it does not place
  anything in the public domain. See [`CONTRIBUTING.md`](../CONTRIBUTING.md).

The CC0 dedication covers these measurements and no third-party trademark. Card
names and set names appear here only to identify which real printing a
measurement describes. See [`NOTICE`](../NOTICE).
