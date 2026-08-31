# foilkit Wiki

foilkit is **a dataset with a renderer attached** — a corpus of measurements of
how real trading-card foil behaves, together with a WebGL renderer that makes
those measurements visible. The value is the mapping from real printings to
accurate foil, across eras and rarities and reprints. The shader renders the
answer; the dataset *is* the answer.

The code is MIT and the dataset is CC0-1.0. The repo lives at
[github.com/cheyras/foilkit](https://github.com/cheyras/foilkit).

**Status: pre-extraction.** The repository currently holds the license split,
the engineering contracts and the documentation skeleton. The library packages,
45 pattern recipes, 32 canon files, the mask corpus and the resolver arrive with
the extraction pass.

---

## How this wiki splits from the repo

The rule is **coupled-to-code versus not**, and it is stated here so nothing is
ambiguous.

If a document has to version with the code — if a reader could be misled by
reading it against a different commit — it lives in the repository. If it is
narrative, research or history, changing on its own clock, it lives here.

Where the same subject has both, the wiki page says so in its first line and
labels itself a **snapshot** or a **deep dive**. The repository copy is the
canonical one, and the pair is updated together or not at all.

## Wiki pages

### The corpus

| Page | What it covers |
|---|---|
| [Foil Taxonomy](Foil-Taxonomy) | The 43 foil treatments — what each one physically is, which eras and sets carry it, and the axes (era, scope, family) that organise them. The best starting point for a stranger |
| [Provenance Model](Provenance-Model) | How the dataset knows who painted a pixel: the mask sidecar, derivation methods, exemplar weighting, and the supersede-versus-correction distinction. **Note:** the canonical copy will be `docs/PROVENANCE.md`; this page is the deep dive |
| [Shader Contract](Shader-Contract) | The shader ABI — assembly model, the pattern entry point, the uniform contract, the composite law and its invariants, and why versioning here is structural rather than a version number. **Note:** the canonical copy will be `docs/SHADER-CONTRACT.md`; this page is the deep dive |

### Project history

| Page | What it covers |
|---|---|
| [Pre-History](Pre-History) | The foil work as it happened inside DeckPal, 2026-08-01 to 2026-08-09 — the verification rounds, the refusals, the mechanisms that were overturned. **A copy** of the foilkit-relevant subset of DeckPal's [Foil Branch Log](https://github.com/cheyras/deckpal/wiki/Foil-Branch-Log), which keeps the full archive permanently |
| [Decision Log](Decision-Log) | Snapshot of the repo's `DECISIONS.md`. The living version is [`DECISIONS.md`](https://github.com/cheyras/foilkit/blob/main/DECISIONS.md) |

### Meta

| Page | What it covers |
|---|---|
| [Contribution Record](Contribution-Record) | Attribution ledger — who contributed what, and which agent worked on whose behalf |

---

## Repo documentation (not in the wiki)

These live in the repository because they are tightly coupled to the code, the
license, or the contract:

| Document | Location | What it covers |
|---|---|---|
| `README.md` | repo root | What foilkit is, the license split, status |
| `LICENSE` | repo root | MIT, covering `packages/` |
| `LICENSE-DATA` | repo root | CC0-1.0, covering `data/` |
| `NOTICE` | repo root | Third-party marks — what the CC0 dedication cannot cover |
| `RELICENSE.md` | repo root | The relicense record and the authorship measurement behind it |
| `REUSE.toml` | repo root | The machine-readable license split (REUSE 3.3) |
| `CONTRIBUTING.md` | repo root | How to submit, and why a DCO sign-off is not a CC0 dedication |
| `NOTICE-CONVENTIONS.md` | repo root | The shape every asset notice has to carry |
| `AGENTS.md` | repo root | Engineering contracts, human and agent alike |
| `DECISIONS.md` | repo root | Living decision log (the wiki page is a snapshot) |
| `docs/` | `docs/` | The five contract documents — arriving with the extraction |
| `packages/*/README.md` | per package | Per-package API |

---

## Conventions

- Every page footers the last agent and human pair that updated it:
  `_Last updated by <agent> on behalf of @<handle> — <date>_`
- Agent-authored commits, repo and wiki alike, carry `On-Behalf-Of:` and
  `Co-Authored-By:` trailers. A commit with no `On-Behalf-Of:` is directly
  human-authored.
- [Contribution Record](Contribution-Record) is append-only: one row per work
  session.

None of that is a license condition — CC0 requires no attribution at all. It
exists because a corpus whose provenance is legible is worth more than one whose
provenance is merely asserted.

_Last updated by Claude Fable 5 on behalf of @cheyras — 2026-08-31_
