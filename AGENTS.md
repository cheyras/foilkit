# AGENTS.md — foilkit engineering contracts

Cross-vendor instructions for working in this repository. These contracts apply
to **every** contributor — human or AI, local or cloud, whichever model or editor
drives the work. Humans: `CONTRIBUTING.md` is the onboarding walkthrough; this
file is the reference.

Keep this file short. A contract nobody finishes reading is not a contract.

## What this repository is

foilkit is **a dataset with a renderer attached**: measurements of how real
trading-card foil behaves, plus a WebGL renderer that makes them visible. When
a change would improve the renderer at the cost of the measurements' honesty,
the measurements win.

Planned layout — a pnpm workspace, one repository:

```
packages/{core,three,webgl2,element,react,patterns,resolver,masks}
data/            measurements — CC0
docs/            contract documents
tools/           standalone tooling that predates the extraction
```

Nothing under `packages/` exists yet; the extraction lands in a later pass.
`tools/rectifier/` is live — see its README. It runs on `node --test` with no
build step and no dependencies, which is the bar tooling here is held to.

---

## Contracts

### F1 — The license split is per-file, and it is machine-readable

Every `.ts`, `.js`, `.mjs` and `.glsl` file carries, in its first lines:

```
// SPDX-License-Identifier: MIT
```

Every data file — `data/**`, `*.canon.json`, resolver tables, mask PNGs — is
CC0-1.0, declared by path glob in `REUSE.toml` because JSON and PNG cannot carry
a comment.

**Why:** a prose sentence is what a human reads once and a license scanner never
sees, and surviving a corporate scanner is the entire reason MIT was chosen over
CC0 for the code. Removing a `REUSE.toml` glob silently un-licenses a whole
corpus — it is not a formatting change.

**Where enforced:** `REUSE.toml`; verifiable with `reuse lint`.

### F2 — Standing ownership rule: source and reference, never copy

Ship nothing we do not own outright. No card artwork, scans, logos, game rips or
traced/extracted trademark glyphs — not in `data/`, not in a demo, not in a test
fixture. Reference imagery is **cited**, with a procedure that fetches it
locally; the citation ships, the pixels do not.

Anything original authored to fill a gap left by a rejected third-party asset
carries a **notice file** recording what was investigated, what was rejected and
why, who authored the replacement, and under what license. The shape is
specified in `NOTICE-CONVENTIONS.md`.

**Why:** a CC0 dedication is worth exactly what the dedicator's standing is
worth. One vendored scan makes the whole corpus's dedication unreliable.

### F3 — Verification state is measured, never claimed

Anything that records how a value was arrived at — a mask's `derivation_method`,
a pattern assignment's match tier and confidence — is **derived server-side from
the artifact itself**, never taken from whatever the caller asserted.

The corollary is the one that actually protects the corpus: **machine output can
never re-enter as evidence.** A generated mask is not an exemplar for the
generator that produced it, or the model grades its own homework.

**Why:** a corpus whose provenance is asserted rather than measured degrades
silently and cannot be audited afterward.

### F4 — Human decisions are a ratchet

Regeneration may rewrite any guess and may **never** overwrite a human decision.
Guesses are disposable by design; human input is monotonic and is never rolled
back by a machine. A machine write landing on an existing human artifact must
fail loudly rather than win.

Nothing in the corpus is ever blank — every printing has an answer. Human
attention does not fill a hole, it upgrades a **guess** to a **decision**, and
that decision becomes evidence the next generative pass uses on everything else.
There is no completion state and no backlog with a bottom.

### F5 — Measurements carry their n

A data change states what was measured, on how many cards, and what stayed
unresolved. A measurement without a corpus size is an opinion. Record refusals
too: "measured this, it did not work, here is why" is one of the most valuable
things in the log and the easiest to lose.

### F6 — No unilateral infrastructure mutations

Do not modify hosting configuration, DNS, environment variables, secret stores
or any shared infrastructure without the maintainer's explicit approval. Reading
is free; writing needs a yes, every time, including for changes that look
obviously safe. Never print a secret's value into a transcript or a log.

foilkit's secret store is its own — the contribution App's credentials live
there and never in DeckPal's.

### F7 — Verify the artifact, not the report

A "done" you did not verify is a guess. Load the page, run the query, render the
card, `curl` the endpoint. Type-checks and tests verify code correctness, not
feature correctness. For anything visual: actually look at it, at desktop width
and at 390px.

---

## DECISIONS.md protocol

Append a dated entry for any non-trivial decision — including decisions to *not*
do something, and corrections of earlier entries:

```markdown
## YYYY-MM-DD — Short title
**Decided by:** <who>
**Decision:** <what was decided>
**Why:** <rationale>
**Implications:** <what changes or must be kept in mind>
```

Never edit a past entry to make it look right in hindsight; append a correction.
When something does not make sense, start here — the answer is usually already
logged.

A snapshot lives at the wiki's
[Decision Log](https://github.com/cheyras/foilkit/wiki/Decision-Log). Update both
in the same sitting, or neither.

## Documentation and the wiki

The split is **coupled-to-code vs. not**. Documents that must version with the
code live in the repository; narrative, research and history live in the wiki
and change on their own clock.

| In the repository | In the wiki |
|---|---|
| `README.md`, `LICENSE`, `LICENSE-DATA`, `NOTICE`, `RELICENSE.md` | [Home](https://github.com/cheyras/foilkit/wiki) — routing table for both halves |
| `CONTRIBUTING.md`, `NOTICE-CONVENTIONS.md`, `AGENTS.md` | [Pre-History](https://github.com/cheyras/foilkit/wiki/Pre-History) |
| `DECISIONS.md` (living) | [Decision Log](https://github.com/cheyras/foilkit/wiki/Decision-Log) (snapshot) |
| `docs/**` — the contract documents | [Foil Taxonomy](https://github.com/cheyras/foilkit/wiki/Foil-Taxonomy), [Shader Contract](https://github.com/cheyras/foilkit/wiki/Shader-Contract), [Provenance Model](https://github.com/cheyras/foilkit/wiki/Provenance-Model) |
| `packages/*/README.md` — per-package API | [Contribution Record](https://github.com/cheyras/foilkit/wiki/Contribution-Record) |

Where a repository document has a wiki companion, the wiki page says so in its
first line and labels itself a snapshot or a deep-dive. Update the pair together.
A stale document is worse than no document — it actively misleads.

Before calling a non-trivial task done: work out which documents the change made
stale and fix them **in the same sitting**. "No documents affected" is a real and
fine answer; an un-asked question is not.

## Attribution

Agent-authored commits — repository **and** wiki — carry two trailers:

```
On-Behalf-Of: @<github-handle>
Co-Authored-By: <agent model> <noreply@anthropic.com>
```

Human contributors' own commits carry no `On-Behalf-Of`; its absence is what
marks a commit as directly human-authored.

Wiki page footers name the last agent + human pair:
`_Last updated by <agent> on behalf of @<handle> — <date>_`

The wiki's
[Contribution Record](https://github.com/cheyras/foilkit/wiki/Contribution-Record)
is the append-only ledger. Append one row per work session:
`| <date> | <agent> | @<handle> | <what> |`

None of this is a license condition — CC0 requires no attribution at all. It
exists because a corpus whose provenance is legible is worth more than one whose
provenance is merely asserted.
