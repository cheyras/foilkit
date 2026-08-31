# DECISIONS.md — foilkit

The dated audit trail. Append an entry for any non-trivial decision; never edit
a past entry to make it look right in hindsight — append a correction instead.
This is the single most useful file in the repository when you are confused
about why something is the way it is.

Format:

```markdown
## YYYY-MM-DD — Short title
**Decided by:** <who>
**Decision:** <what was decided>
**Why:** <rationale>
**Implications:** <what changes or must be kept in mind>
```

A snapshot of this file is mirrored to the wiki's
[Decision Log](https://github.com/cheyras/foilkit/wiki/Decision-Log). Both, or
neither — never one now and the other later.

---

## 2026-08-31 — The name is `foilkit`

**Decided by:** @cheyras

**Decision:** The project is named **foilkit**. Packages are scoped
`@foilkit/*`; the repository is `github.com/cheyras/foilkit`.

**Why:** Namespace availability decided it. Re-verified against the live
registries on 2026-08-30 and again on 2026-08-31:

| Name | GitHub | npm unscoped | npm `@scope/core` |
|---|---|---|---|
| holofoil | **taken** (200) | free | free |
| holoforge | **taken** (200) | free | free |
| **foilkit** | **free** (404) | **free** (404) | **free** (404) |
| chromafoil | free | free | free |

`holofoil` was the preferred name and is unavailable on GitHub: the handle
belongs to an empty personal account — 0 repositories, 0 stars, no bio — and
squatter-release through GitHub's name-reclamation process is slow and
unreliable. A name that is free on npm but taken on GitHub is not free; the
repository is where contributors actually arrive.

`mylar` was ruled out regardless of availability — it is a registered trademark
of DuPont Teijin Films.

**Implications:** Package names, the repository, the hosted subdomain
(`foilkit.deckpal.app`) and every SPDX header follow from this. The npm
namespace is not yet reserved (see the pending item below), which is the one
part of this decision with a live clock on it.

---

## 2026-08-31 — No GitHub organisation; the repository lives under `cheyras/`

**Decided by:** @cheyras

**Decision:** foilkit is `github.com/cheyras/foilkit`, a repository under the
author's personal account. **No `foilkit` GitHub organisation is created.**

**Why:** The original plan reserved a GitHub org as the trust anchor. It was
dropped as premature. An organisation adds an administrative surface — seats,
roles, org-level settings, an `admin:org` token scope the working credential
does not currently carry — in exchange for a signal that matters only once there
are multiple maintainers, which there are not. A single-author project under a
personal account is the honest shape of the thing today.

**Implications:**

- The GitHub namespace `foilkit` remains unclaimed. That is a deliberate accepted
  risk, not an oversight; if it is later taken by someone else the repository
  keeps working and only the vanity URL is lost.
- Transferring `cheyras/foilkit` into an org later is a supported, one-click
  operation that preserves issues, pull requests, stars and redirects. Choosing
  the org now would not have been reversible in the same easy direction.
- The planned GitHub App (contribution automation) is scoped to a single
  repository either way, so nothing downstream depends on the org existing.

---

## 2026-08-31 — MIT for the code, CC0-1.0 for the data

**Decided by:** @cheyras

**Decision:** Code under `packages/` is **MIT**. The dataset — `data/**`, every
`*.canon.json`, resolver tables, mask images — is dedicated to the public domain
under **CC0-1.0**. Documentation is MIT. The split is declared machine-readably
in `REUSE.toml` and, for files that can carry a comment, in per-file
`SPDX-License-Identifier` headers.

**Why:** The stated preference was CC0 across the board, and the data is CC0 for
exactly that reason — it is measurement of the physical world, and the project's
thesis is that anyone can take the whole corpus and do anything with it.

The code is MIT anyway, for one specific reason: **CC0 contains no patent grant
and explicitly disclaims one.** The FSF flags this, and a number of corporate
legal teams carry a blanket block on CC0-licensed *software*. foilkit's entire
thesis is that somebody drops it into a storefront or a collection app — MIT
clears legal review essentially everywhere, CC0 sometimes does not. MIT's only
cost over CC0 is a LICENSE file nobody reads: no real obligation, no attribution
burden on adopters.

Documentation is MIT rather than CC-BY, deliberately. CC-BY's attribution
requirement is a *stronger* obligation on a downstream reuser than MIT's
notice-retention, and it would put a third license in anyone's SBOM for no gain.
Two licenses is the number a legal reviewer wants to see.

**Implications:**

- The boundary splits **files, not packages**. `@foilkit/patterns` will contain
  both: `patterns/*.glsl` is MIT, `patterns/*.canon.json` is CC0.
<!-- REUSE-IgnoreStart -->
- Every `.ts`/`.js`/`.mjs`/`.glsl` file must carry
  `// SPDX-License-Identifier: MIT`. This is new convention, not a port — the
  origin repository has zero SPDX headers anywhere.
<!-- REUSE-IgnoreEnd -->
- JSON and PNG cannot carry a comment, so `REUSE.toml`'s globs are the *only*
  machine-readable statement of their license. Removing a glob silently
  un-licenses a corpus.
- Data contributions need an explicit CC0 dedication, not merely a DCO sign-off
  — see the contributor-terms entry below.

---

## 2026-08-31 — One monorepo

**Decided by:** @cheyras

**Decision:** All eight planned packages — `core`, `three`, `webgl2`, `element`,
`react`, `patterns`, `resolver`, `masks` — live in a single repository as a pnpm
workspace under `packages/*`.

**Why:** The deciding reason is the planned contribution App, which is **scoped
to one repository**. A pattern contribution touching `@foilkit/patterns`
alongside its canon file touching `@foilkit/core` would otherwise need
multi-repository scope and two coordinated pull requests — for what is, to the
contributor, one measurement.

Secondarily: the dataset and the renderer version together. A canon file is a
full snapshot rather than a delta, so a split that let them drift would let them
drift *silently*.

**Implications:** Splitting a package out later is easy. Merging repositories
later is not. Release tooling has to handle per-package versioning inside one
tag namespace.

---

## 2026-08-31 — Contributor terms: DCO plus an explicit CC0 dedication

**Decided by:** @cheyras

**Decision:** Code contributions require a DCO sign-off. Contributions touching
`data/` or any `*.canon.json` require a sign-off **and** an explicit CC0
dedication line in the pull-request body, carried today by a required checkbox
in `.github/PULL_REQUEST_TEMPLATE.md`.

**Why:** A DCO sign-off certifies that you wrote the contribution or have the
right to submit it under the project's license. **It does not perform a
public-domain dedication.** CC0 is an affirmative act of abandonment; nothing in
the DCO performs it. A contributor who signs off and adds a canon file has not
dedicated it, and that hole in the dataset's public-domain claim is very hard to
close retroactively — it means finding the person, years later, and asking.

Alternatives considered and rejected: a full CLA (heavyweight, kills drive-by
contributions, wrong for a measurement corpus); relying on the DCO alone
(leaves the hole); a dedication statement written by hand into every PR body,
the SQLite/curl posture (works, but nothing prompts for it).

**Implications:** The planned GitHub App composes pull requests directly and will
insert the dedication line into the PR body itself, so a contributor's approval
of their own PR *is* their assent — nearly free, and it closes the gap at the
moment of contribution. Until then the template is the fallback and is not
optional. The template stays after the App ships, for pull requests opened by
hand through the GitHub UI.

---

## 2026-08-31 — Standing ownership rule

**Decided by:** @cheyras

**Decision:** Ship nothing we do not own outright. Third-party material enters
by **source and reference, never by copy**. Any original asset authored to fill a
gap left by a rejected third-party one carries a notice file recording the
investigation, the rejections and their reasons, and the authorship. The shape
is specified in `NOTICE-CONVENTIONS.md`.

**Why:** A CC0 dedication is only worth what the dedicator's standing is worth. A
traced trademark glyph or a vendored scan inside a public-domain corpus does not
become public domain by being in it — it makes the whole dedication a claim
nobody can rely on. The rule also has to survive a scanner and a legal reviewer,
not just a good-faith reader.

**Implications:** No card artwork, scans, logos, game rips or traced marks in
`data/`, in demos or in test fixtures. Reference imagery is cited plus a fetch
procedure, not vendored. Every asset carries its notice, and the notice records
what was *rejected* — a rejection trail is the part that proves the
investigation happened.

---

## 2026-08-31 — Relicense record cites the mirror and the wiki, never a live SHA

**Decided by:** @cheyras

**Decision:** `RELICENSE.md` cites foilkit's own initial commit, the offline
mirror `deckpal-mirror-2026-08-31.git`, and the DeckPal wiki page
`Foil-Branch-Log`. It cites **no live SHA on any DeckPal `foil/*` branch**, and
no tag was created to preserve one.

**Why:** Those branches are scheduled for deletion, which is what removes the
third-party reference media from the origin repository. A tag pointing at a
branch tip keeps the deleted objects reachable — it would defeat the deletion
entirely. The mirror and the wiki page are the archive.

**Implications:** The authorship figure is the re-measured one: **465 commits,
76,291 words, 100% authored by `cheyras <cheyras@gmail.com>`, zero co-authors**,
measured 2026-08-31 against the mirror. The earlier working figure of 199
commits was counted against a single branch at an earlier date, was never
re-verified, and should not be cited anywhere.

---

## 2026-08-31 — The wiki ships staged in the repository, because GitHub will not take it

**Decided by:** Claude Fable 5, on behalf of @cheyras

**Decision:** foilkit's seven wiki pages were written and committed to
`wiki-staging/` in this repository rather than pushed to the wiki. They move to
the wiki, and `wiki-staging/` is deleted, in a single follow-up commit once the
maintainer has created the wiki's first page.

**Why:** GitHub does not accept a push to an uninitialized wiki. The feature is
enabled on this repository, but until a person creates the first page through the
web UI the wiki's git remote **does not exist** — cloning and pushing both fail
with `Repository not found`. Verified 2026-08-31. There is no API, no CLI command
and no token scope that initializes it; it is browser-only, and the working
credential could not have done it regardless of scope.

The alternative was to hold the pages until the click happened, which risks them
being written twice or not at all. Staging them costs one directory and one
follow-up commit.

**Implications:**

- Every `…/wiki/…` link in `README.md`, `AGENTS.md` and `docs/README.md` 404s
  until the click. They were written against the final URLs deliberately, so
  nothing needs rewriting afterward.
- `wiki-staging/README.md` carries the exact steps for both halves.
- **Delete `wiki-staging/` in the same commit that records the wiki going live.**
  Two copies of a document with nothing keeping them in sync is worse than one.

---

## 2026-08-31 — Pending, not decided

Recorded here so they are not mistaken for settled:

- **npm namespace unreserved.** `foilkit`, `@foilkit/core` and `@foilkit/patterns`
  were all free on the registry as of 2026-08-31, but the working machine is not
  authenticated to npm and `npm login` is an interactive browser flow. The npm
  organisation and the placeholder unscoped `foilkit` package (a 0.0.0 stub
  pointing at `@foilkit/core`, so that nobody ships a confusable package under
  the obvious bare name) both remain to be created. This is the item with a real
  clock on it.
- **Hosting.** `foilkit.deckpal.app` has no Vercel project and no deployment.
  DNS needs nothing — `deckpal.app` already carries a wildcard ALIAS at Vercel,
  so the subdomain resolves today and returns `DEPLOYMENT_NOT_FOUND`. Standing it
  up is a Vercel project plus a domain assignment, both infrastructure writes
  requiring the maintainer's explicit approval.
- **The wiki is not initialized.** Seven pages are written and staged in
  `wiki-staging/`; they cannot be pushed until the maintainer clicks "Create the
  first page". See the entry above.
- **The extraction itself.** No library code, no dataset and no `packages/`
  directory exist in this repository yet.

---

## 2026-08-31 — The rectifier: four corners → canonical 504 × 704
**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** `tools/rectifier/` implements the missing half of the scan
pipeline — a detected quad plus its image becomes a canonical raster and the
3 × 3 row-major homography that produced it — together with the pair-diff and
three-way `null` / `frame` / `full` classifier that task 3b's reverse-holo
delta measurement runs on. Zero dependencies: pure-maths DLT, hand-rolled
bilinear warp, PNG over `node:zlib`, tests on `node:test`.

**Why:** 3b cannot start without it. DeckPal's `dev/scan-harness` is a
*detector* — it returns corner lists and warps nothing — so every pair would
otherwise be hand-aligned, which 3b's verification list forbids in as many
words. Building it now also front-loads task 4's constants module and task 14's
capture front end, both of which want exactly this code.

**Implications:**

- **No build step and no dev dependency.** Node 22.18+/24 strips TypeScript
  natively, so the suite runs as `node --test "tools/rectifier/*.test.ts"`.
  A `tsx` loader was considered and is not needed. No root `package.json` was
  added: the pnpm workspace is the extraction's decision to make, not this
  task's, and a README line documents the command in the meantime.
- **`constants.ts` is task 4b's constants module, early.** The millimetre
  constants and the "3 mm corner is triangulated, not official, credible range
  2.5–3.0 mm" provenance are carried from DeckPal's `cardGeometry.ts`. Nothing
  derived is typed in twice, and `constants.test.ts` reads the source back and
  fails on a numeric literal assigned to a derived export — 4b's verification
  item, satisfied by construction rather than by discipline.
- **Round-trip error is measured, and the synthetic number is not the real
  number.** Synthetic smooth pattern through a keystoned quad: mean 0.0019/255,
  max 1/255. The same path with a real card scan: **mean 2.28/255, max 54/255**
  (n = 1). Real cards are hard edges and 6 pt type; two bilinear resamples cost
  real error at every one of them. Anything downstream that keys on a single
  pixel's value budgets against the real figure.

---

## 2026-08-31 — WebP declined for the smoke test; PNG from the same path
**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** The real-scan smoke test fetches TCGdex's `high.png` rather than
`high.webp`. The scans are downloaded by `tools/rectifier/fetch-smoke-scans.ts`
into the gitignored `reference-media/` tree and the test **skips** when they are
absent.

**Why:** Decoding WebP with no dependency means writing a VP8 intra decoder — a
real project, and one with nothing to do with homographies. TCGdex serves the
same asset as `.png` from the same path, and `png.ts` already decodes PNG.
Nothing in the rectifier is format-aware; it takes an RGBA buffer, so swapping
in a WebP decoder later changes only the loader. Fetch-not-vendor is F2: the
citation ships, the pixels do not.

**Implications:** `smoke-scans.ts` is the citation and ships; the images never
do. A clone with no network passes its test run with the smoke suite skipped,
which is honest, where a vendored card scan would be a licence problem.

---

## 2026-08-31 — The ported PNG codec was missing palette and Adam7
**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** `tools/rectifier/png.ts` extends the codec ported from DeckPal
with colour type 3 (palette, bit depths 1/2/4/8, `PLTE` + `tRNS`) and Adam7
de-interlacing.

**Why:** DeckPal's codec had only ever read `canvas.toDataURL` output, so it
supported neither. The first two real catalog scans this rectifier was pointed
at — TCGdex `high.png` — are **8-bit palettised and Adam7-interlaced**, and the
original threw `interlaced PNG unsupported` on both.

**Implications:** Recorded because it is the smoke test earning its place on the
first run: the synthetic suite would never have found this, and task 4a's
framing census walks the same catalog rasters and would have hit it later and
further from the cause. 16-bit still throws, deliberately.

---

## 2026-08-31 — Every classifier threshold is provisional, and says so
**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** `CHANGED_PIXEL_DELTA` (24), `NULL_MAX_CHANGED_FRACTION` (0.005),
`FRAME_MAX_INSIDE_CHANGED_FRACTION` (0.02), `EDGE_MARGIN_PX` (4) and
`MAX_RESIDUAL_SHIFT_PX` (4) ship as named constants whose comments state they
are provisional and have never seen a photographed pair.

**Why:** F5 — a measurement carries its n, and this one's n is **zero**. The
values separate the synthetic cases with room to spare and that is the entire
claim being made for them. Publishing a bare number would have let a later
reader mistake a placeholder for a finding.

**Implications:**

- 3b's measurement is **blocked on the physical pair capture** and on nothing
  else. No bulk source ships variant-specific imagery, so both printings of a
  card have to be shot from the binder.
- `PLACEHOLDER_ART_WINDOW` is explicitly not a measurement — the real windows
  are per-era in `era-layouts.json`. A result computed against the placeholder
  should say so, and `classifyDelta` refuses to separate `frame` from `full`
  at all when no window is supplied, returning the conservative class with
  `trustworthy: false`.
- The alignment guard likewise reports rather than corrects: a pair whose two
  rectifications disagree is re-detected, never nudged.

---

## 2026-08-31 — Correction to "Pending, not decided" above
**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** The pending item reading *"No library code, no dataset and no
`packages/` directory exist in this repository yet"* is now partly out of date
and is corrected here rather than edited in place.

**Why:** `tools/rectifier/` is working code, checked in on this date. It is
deliberately **not** under `packages/`: it predates the extraction, it is a tool
rather than a published package, and `constants.ts` is the only part of it with
a settled destination (`@foilkit/core`, per task 4b).

**Implications:** `packages/` and the dataset remain empty and the extraction is
still outstanding. The rest of that pending entry stands unchanged.
