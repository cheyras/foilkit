# Relicense record

This document exists so that a stranger — or a corporate legal reviewer — can
verify that the MIT and CC0 grants in this repository were made by someone with
standing to make them.

## Summary

The foil rendering work, the pattern taxonomy, the mask corpus and the resolver
originated inside [DeckPal](https://github.com/cheyras/deckpal), which is
licensed **AGPL-3.0**. All of it was written by one person. That person, the
sole copyright holder, has relicensed the extracted work as **MIT** (code) and
**CC0-1.0** (data) in this repository.

| | |
|---|---|
| **Sole author and copyright holder** | Chey Rasmussen (`cheyras <cheyras@gmail.com>`) |
| **Origin** | `cheyras/deckpal`, AGPL-3.0, branches `foil/*` |
| **New licenses** | MIT for `packages/`, CC0-1.0 for `data/` |
| **Date of relicense** | 2026-08-31 |

The legal name is stated deliberately. CC0 requires no attribution, and
elsewhere in this repository attribution can be absent entirely — but a
public-domain dedication is only verifiable if you can tell **who had standing
to make it**. That is what this page is for, and it is the one place in the
project where the real name is non-optional.

## Authorship measurement

Measured **2026-08-31**, against the union of commits on the eight `foil/*`
branches of `cheyras/deckpal` that were not reachable from `main`:

| | |
|---|---|
| Commits | **465** |
| Words of commit message | **76,291** |
| Distinct authors | **1** — `cheyras <cheyras@gmail.com>`, on 465 of 465 commits |
| Co-authors / `Co-Authored-By` humans | **0** |

Zero commits carry a second human author. There is no contributor whose
permission would be needed and no CLA problem to unwind. AI agents worked on
the author's behalf under `On-Behalf-Of:` / `Co-Authored-By:` trailers; those
trailers name a model, not a second rights-holder, and the work-product is the
author's.

The number **465** replaces an earlier working figure of 199 that circulated
during planning. 199 was counted against a single branch at an earlier date and
was never re-verified; it should not be cited.

## What this record cites, and why not a live SHA

The eight `foil/*` branches are scheduled for deletion from `cheyras/deckpal`
once this extraction lands. **This record therefore cites no live DeckPal SHA**,
and no tag was created to preserve one — a tag would keep the deleted objects
reachable, which is precisely what the deletion is meant to end.

Three durable citations instead:

1. **This repository's initial commit** — the point at which the relicensed work
   begins. Everything in foilkit's history is MIT/CC0 from its first commit
   onward; nothing here was ever published under AGPL-3.0 in this repository.

2. **The offline mirror `deckpal-mirror-2026-08-31.git`** — a `git clone
   --mirror` of `cheyras/deckpal` taken on 2026-08-31, before any branch
   deletion, verified `git fsck`-clean with all branch tips matching `origin` at
   that moment. This is the verifiable pre-deletion record of the source
   history. It is held offline by the author.

3. **The DeckPal wiki page
   [`Foil-Branch-Log`](https://github.com/cheyras/deckpal/wiki/Foil-Branch-Log)**
   — a public, permanent archive of all 465 commit messages, grouped by branch,
   which records **every branch's pre-deletion tip SHA**. Those SHAs resolve
   against the mirror in (2). DeckPal keeps that archive permanently; foilkit's
   wiki carries a copy of the foil-relevant subset as `Pre-History`.

## Why MIT for the code rather than CC0 for everything

The stated preference was CC0 across the board, and the data is CC0. The code is
not, for one specific reason: **CC0 contains no patent grant and explicitly
disclaims one.** The FSF flags this, and a number of corporate legal teams carry
a blanket block on CC0-licensed *software*.

foilkit's whole thesis is that somebody drops it into a storefront or a
collection app. MIT clears legal review essentially everywhere; CC0 sometimes
does not. MIT's only cost over CC0 is a LICENSE file nobody reads — it creates
no meaningful obligation and no attribution burden on adopters. The dataset,
which is measurement rather than software, has no patent surface to worry about
and stays CC0.

## Where the code/data boundary sits

The boundary splits **files**, not packages. `@foilkit/patterns` will contain
both:

| Kind of file | License | Mechanism |
|---|---|---|
| `packages/**/*.glsl`, `*.ts`, `*.js`, `*.mjs` | MIT | `SPDX-License-Identifier: MIT` header in the file |
| `data/**`, `*.canon.json`, resolver tables, mask PNGs | CC0-1.0 | `REUSE.toml` path globs (JSON and PNG cannot carry a comment) |

This is declared machine-readably in `REUSE.toml` because a prose note is what a
human reads once and a license scanner never sees — and surviving a scanner is
the entire reason MIT was chosen. The prose stays as the human-readable version;
`REUSE.toml` is what makes the split real.

## Hosting on a deckpal.app subdomain

foilkit's contribution surface is intended to be served at
`foilkit.deckpal.app`. The domain belongs to DeckPal, which is AGPL-3.0; the
code and the deployment are foilkit's, which is MIT.

**This creates no license entanglement.** A DNS record is not a derivative work,
and serving an MIT application at a hostname whose parent domain also serves an
AGPL application combines nothing. The two are separate deployments with
separate source, separate builds and separate secret stores; the AGPL's
source-provision obligation attaches to the AGPL program's users, not to
whatever else answers on a neighbouring hostname.

## Trademarks

Neither MIT nor CC0 grants any right in a third-party mark, and neither this
record nor the dedication attempts to. See `NOTICE`.

---

_Recorded 2026-08-31 by Claude Fable 5 on behalf of @cheyras._
