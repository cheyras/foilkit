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

---

## 2026-09-01 — The extraction landed: five packages, one corpus, one receipt
**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** The foil runtime, authoring stack and corpus were extracted from
DeckPal's `foil/main` (`b803b43`) into
`packages/{core,patterns,three,resolver,forge}`, `data/`, `docs/` and
`reference/`. `RECEIPT.md` records the evidence that nothing changed in transit;
its four measurements are 45/45 byte-identical renders, 177 passing tests, an
identical resolver digest over 10,312 probes, and core compiling *and running*
with three.js absent from `node_modules`.

**Why:** The origin branches are scheduled for deletion, and a move is only
safely reversible-by-inspection if it arrives with proof. The receipt is a
one-time artifact and says so: once read, the harness goes back to being a tool
rather than a gate.

**Implications:** The pending item above — "`packages/` and the dataset remain
empty" — is now closed. Nothing is published: every package is `0.0.0` and no
release has been cut.

---

## 2026-09-01 — Canonical space has exactly one definition, and the rectifier re-exports it
**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** `packages/core/src/card-space.json` (the datum) and
`canonical-space.ts` (the derivation) are the single definition of canonical
card space. `tools/rectifier/constants.ts` is now a re-export from
`@foilkit/core`, and its contract test follows the definition rather than the
shim.

**Why:** DeckPal carried two copies of the same arithmetic because its api
`tsconfig.json` pinned `rootDir` and could not import its web sources; the
rectifier, written here before the extraction, was a third. Its own header
predicted this move. Three copies of an expression are three chances to
disagree.

**Implications:** The rectifier's `CARD_ASPECT` is width/height and the shader's
is height/width, so the shim maps them explicitly (`CARD_ASPECT_WH` /
`CARD_ASPECT_HW`) rather than star-exporting — a silent swap there is a 1.95×
error nobody would notice until a mask was cut wrong.

**Still duplicated, and recorded as such:** `tools/rectifier/png.ts` and
`packages/forge/src/png.ts` are two hand-rolled PNG codecs over `node:zlib`.
Both work, both are tested, and unifying them would touch the rectifier's own
proofs. A follow-up, not a blocker.

---

## 2026-09-01 — CARD_ASPECT derives from millimetres, not from era-layouts.json
**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** `@foilkit/core`'s `CARD_ASPECT` is `CARD_ASPECT_HW`, computed from
the millimetre datum. It previously read `era-layouts.json`'s `cardAspect`.

**Why:** `era-layouts.json` belongs to `@foilkit/resolver`, which is
Pokémon-specific and optional by construction — someone rendering Magic cards
wants the shader and not the resolver. Core reading it would have made the
optional package mandatory.

**Implications:** Identical to every decimal the shader emits (`1.39683`,
`0.0476`), which the render receipt confirms at the byte level. The layout
contract test still asserts that `era-layouts.json` agrees with the expression,
so the two cannot drift apart silently.

---

## 2026-09-01 — Three DeckPal routes became configuration
**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** The glyph asset route, the artwork-citation URL a sidecar records,
and the mask route a corpus report names are now configurable, each defaulting
to a relative path a static host satisfies for free. DeckPal's `@deckscout/db`
import became an injectable pool (`registerAssetPool`).

**Why:** A hardcoded host prefix in an extracted library means nothing anywhere
else, and depending on a database this repository does not have would break
`@foilkit/forge`'s "node: builtins only" property — which is what lets it run
with no install and no build step.

**Implications:** Nothing registered means nothing to look up, which is exactly
the pre-existing unreachable-database path: a fallback, not a crash. The
sidecar's `artworkUrl` stays a CITATION and never an asset; the pixels are never
carried.

---

## 2026-09-01 — pg is not a dependency, and build-pattern-cards says why
**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** `tools/build-pattern-cards.mts` resolves `pg` at run time out of
whichever project supplies the catalog (`PG_HOST_PACKAGE`), rather than foilkit
depending on it.

**Why:** That tool INVERTS the resolver — it walks every printing in a catalog
and records which ones each pattern governs. foilkit ships measurements *of*
printings, not a list of them, and will not grow a database to keep one tool
happy.

**Implications:** The tool still runs in both offline modes
(`--evidence-only`, `--fixture`) with no catalog at all, which is what CI and a
contributor without one use. Subtask 7 turns this into a build-time input
question, because the hosted editor has no database at read time.

---

## 2026-09-01 — The pipeline job prompts were stripped too
**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** The auto-caption block embedded in 39 of the 44
`reference/pipeline/jobs/*.json` prompts was removed, alongside the transcript
sections in all 44 `notes.md` and the inline quotes in the 4 `gemini-spec.md`
files the content rules named.

**Why:** The rules named the notes and the four specs. They did not name the job
files — but the job files carried considerably MORE transcript than the notes
did, and the rule's reason (the creator's words are the creator's, exactly as
the frames are) covers them exactly. Following the letter would have missed the
larger half.

**Implications:** Each prompt now carries a note saying what was there and that
`fetch-reference.sh` writes it back locally, from a source the operator fetched
themselves. The prompt rubric — the part that is ours — is untouched, so the
pipeline stays reproducible for anyone who has the media.

---

## 2026-09-01 — The parity harness renders both sides through ONE page
**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** `tools/parity/` takes its shader, material, pattern and canon
sources as URL parameters. The moving receipt was measured by pointing the same
page at foilkit's `packages/*/dist` and at a plain `tsc` build of DeckPal's
`shader.ts` + `patterns.ts`.

**Why:** The plan called for running DeckPal's harness in DeckPal and foilkit's
in foilkit. Those are two different pages, and a byte difference between them
would have been unattributable — different chrome, different backdrop, different
card rect. Holding the page fixed makes the code the only variable, which is the
claim the receipt is trying to support.

**Implications:** A deviation from the plan, and a strengthening one. It also
leaves a general instrument rather than a one-off: the same harness re-runs the
canon recheck under a future contract bump (one run per law, compared on mean
absolute error), and it is the seed of subtask 6's stress demo.

---

## 2026-09-01 — Canon files frozen; tunedUnderContract deliberately not moved
**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** All 32 canon files now record every contract uniform and every
declared param explicitly, at the value already in effect. 22 widened — the 21
saved on 2026-08-02, plus `tinsel-ii`, which lacked only `uP4`. Ten were already
full. `tunedUnderContract` was not touched.

**Why:** A canon file claims to be a full snapshot. Twenty-one inherited the
eight R4–R6 composite dials from `GLOBAL_DEFAULTS` at read time, which is a
promise to track a code constant — harmless while the constant lived next door,
not harmless once it lives in a separately versioned package.

**Implications:** Recording an inherited default is not a tuning decision, so
those 21 are still `tunedUnderContract: 1` and still in the retune queue. The
zero-delta harness re-ran 45/45 byte-identical after the freeze, which is the
only acceptable evidence for a "nothing changed visually" claim. Undeclared
params and `uScanBase` are not written, for the same reason: writing them would
assert decisions nobody made.

---

## 2026-09-01 — The lab shell did not come across
**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** `FoilLab.tsx`, `CanonLab.tsx`, `MaskProvenance.tsx`, `ui.tsx` and
the `api.ts` HTTP client stayed in DeckPal. The coupling-free view code —
`CardViewer`, `useTilt`, `ViewTransform`, `MaskEditor`, `WindowEditor` — came,
under `@foilkit/three/react`.

**Why:** The extraction plan's package map named `buildFoilMaterial`,
`CardViewer` and `useTilt` for `@foilkit/three` and nothing else. The lab shell
is bound to DeckPal's router, its query client and its API prefix; the hosted
contribution editor is its replacement, not its port.

**Implications:** This is a real loss if the origin branches are deleted before
anyone decides otherwise — roughly 2,700 lines of working editor UI, including
the canon lab's slider layout and the provenance panel. **Flagged for the
maintainer rather than settled here.** The drawing surfaces subtask 8 would
rebuild around are the part that came, which was the expensive half.

---

## 2026-09-01 — Extraction closeout: the evidence JSONs carry no third-party narration

**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** Five things, all of them consequences of one rule — `data/**` is
CC0, and a CC0 dedication can only cover material this project has standing to
dedicate.

**1. The quote scrub.** `data/foil-card-assignments.json` and
`data/foil-pattern-usage.json` carried **162 YouTube-attributed
`sources[].quote` strings, ~2,517 words**, of which **127 were not marked as
paraphrase**, the longest verbatim run was 39 words, and one was labelled
"cleaned auto-caption" in the file itself. Every one of the 162 has been
rewritten as a short paraphrase in the maintainer's voice, prefixed
`Paraphrase (…)`, with the factual claim preserved — set names, pattern
identifications, physical descriptions, demo cards — and the attribution
normalised to video id (the `url`) plus chapter and timestamp. **162 of 162 are
now marked; 0 unmarked.** Where a timestamp was never recorded the text says so
rather than inventing one. Both files also carry a `$comment` stating the policy,
so the next contributor reads the rule before adding a row.

**2. The caption write-back that did not exist.** `reference/README.md` and all
39 `pipeline/jobs/*.json` prompts claimed `fetch-reference.sh` "writes the
caption block back into this slot". No such capability existed. Rather than
delete the claim, it was made true and honest: the docs now say the captions
were **removed from the repository** because they are third-party narration, and
`fetch-reference.sh --captions` (`--captions-only` to skip the video cut) slices
each pattern's chapter range out of yt-dlp's auto-subtitles into
`reference-media/.captions/<slug>.txt`, which the existing `reference-media/`
gitignore rule already covers. Each of the 39 jobs names that path in a new
`captionsFile` field; `pipeline/gemini_vision.py` appends the text when the file
is present and runs on the frames alone when it is not. `RECEIPT.md` carries a
dated correction of the same claim.

**3. The pkmn.gg citations stay.** Ten `sources[].url` entries in
`data/foil-card-assignments.json` (and the ten hostnames the derived index
keeps) point at pkmn.gg. **They are kept.** pkmn.gg was ruled out as an ASSET
source — we do not ship its images or its data — and that ruling says nothing
about citing it. These are provenance records of where an observation came from:
nominative use of the name, a URL, and our own restatement of what it showed.
Deleting them would make the corpus *less* checkable while removing nothing that
was ever copied.

**4. The usage index no longer knows a host.** `tools/build-usage-index.mjs`
hard-coded `http://127.0.0.1:3712/deckscout/api` for its optional coverage
report — a DeckPal address, in a repository with no catalog. The URL is now an
opt-in `--api <base-url>` flag or `FOILKIT_CATALOG_API` env var **with no default
baked in**; with neither, the report is skipped cleanly and the output file is
unaffected, as it always was. Both index builders also had stale extraction
paths (`../../research/*` → `apps/web/src/foil/*`) and could not run at all;
they now read `data/` and write `packages/resolver/src/`. Regenerating with the
fixed paths reproduces both committed indexes **byte for byte**, which is the
evidence that the path fix is right and that no quote text ever reached them.
`reference/fetch-reference.sh` additionally had a latent `set -u` failure —
`local id="$1" out="…$id…"` aborts under bash 5.2 — fixed in the same pass.

**5. Verification.** The resolver digest probe re-ran over the same 10,312
inputs: `8541aa1b389d5a8b04508aa237189dce196ef470f358dc913c8c9584beafc367`,
**identical to the receipt**, and the two output files diff clean line for line —
the scrub moved no guess. 177/177 tests pass, `reuse lint` clean.

**Why:** Third-party narration in a CC0 file is the one defect that makes the
dedication itself false, and the dataset is the half of this project that other
people are meant to be able to take. The evidentiary value of a citation is the
claim plus the pointer, not the wording; paraphrase keeps all of the first and
loses none of the second.

**Implications:** These were the last open items before DeckPal's `foil/*`
branches are deleted. Four verification footnotes belong with them, because each
one looks like a discrepancy until it is explained:

- **The contract stamp is 2, not 4.** The extraction spec says canon files stamp
  contract 4; revision 4b renumbered the contract sequence, and 2 is the value
  that survived. The spec's "4" is superseded, not violated.
- **`foil/tooling-research` was a path SUBSET of `foil/main`.** Nothing was lost
  by extracting from `foil/main` alone; there was no second corpus to merge.
- **The literal string "Transcript excerpt" appears in two mid-history commit
  READMEs.** It is a *reference to* the section that was stripped, not the
  section's content. `git grep -ci transcript` at HEAD hits four files, all of
  them meta.
- **`MANIFEST.json`'s frame check is width-only.** Heights were verified by hand
  this round: 344/344 frames at 270 px, matching the recorded 480 × 270.

**Flagged, not fixed — for the maintainer.** The scan that closed item 1 also
looked at the **340 non-YouTube quotes** in the same two files, and they have the
same shape of exposure: the longest is **83 words from insights.collexy.com**,
with 177 Bulbapedia quotes (longest 56 words), 14 PokeBeach (58) and 9
BleedingCool (34). Bulbapedia is CC-BY-SA and Collexy reserves its rights;
neither is CC0-dedicatable by us. This closeout was scoped to the YouTube
narration and deliberately did not widen itself. **It is the obvious next
scrub**, and it is recorded here so that deleting the origin branches does not
delete the knowledge that it is outstanding.

---

## 2026-09-01 — The written sources are paraphrase too: the 340 the closeout flagged

**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** The follow-up scrub named in the previous entry has been done. The
**340 non-YouTube `sources[].quote` strings** in
`data/foil-card-assignments.json` and `data/foil-pattern-usage.json` — **9,632
words**, none of them marked — are now **340 paraphrases in the maintainer's
voice, 6,984 words, all 340 marked**. Combined with the 162 video citations the
closeout rewrote, **all 502 quote strings in both files are marked paraphrase
and 0 are unmarked, from any source.**

| Source | Quotes | Longest original |
|---|---:|---:|
| Bulbapedia (CC-BY-SA 2.5) | 177 | 56 w |
| Collexy (all rights reserved) | 124 | 83 w |
| PokeBeach | 14 | 58 w |
| pkmn.gg | 10 | 30 w |
| Bleeding Cool | 9 | 34 w |
| Sleeve No Card Behind | 6 | 22 w |
| **Total** | **340** | **83 w** |

Attribution was normalised the way the video citations were, to the same
`Paraphrase (…) — ` form: publication name plus the page title the URL already
names, with the `url` field unchanged beside it — `Paraphrase (Bulbapedia,
'Holofoil') — …`, `Paraphrase (Collexy, 'XY era holofoil overview') — …`,
`Paraphrase (pkmn.gg, 'Silver Tempest Trainer Gallery' set list) — …`. Nothing
was invented to fill a field: none of these URLs carries a section anchor, so
none of the citations claims one, exactly as the video citations say "timestamp
not recorded" rather than guessing a timestamp. Both files' `$comment` policy
note now covers **every** quote rather than only the video ones, and says why.

**Why:** The closeout's rule has not changed — `data/**` is CC0, and a CC0
dedication can only cover material this project has standing to dedicate. What
changed is the recognition that the written sources are the *worse* half of the
problem, not the lesser one:

- **Bulbapedia is CC-BY-SA 2.5.** That is not merely "not ours to dedicate", it
  is a **direct licence conflict inside a CC0-declared file**: CC-BY-SA is
  copyleft, it requires attribution and share-alike on any reuse, and CC0 is a
  waiver of exactly those conditions. 177 CC-BY-SA strings sitting under a CC0
  notice made the notice false about a third of the file's citations, and would
  have propagated a share-alike obligation to every downstream user who took the
  dataset at its word. A paraphrase of a fact carries no such obligation:
  CC-BY-SA covers the expression, and the facts about which foil pattern a set
  used are not copyrightable in the first place.
- **Collexy, PokeBeach, Bleeding Cool and Sleeve No Card Behind reserve their
  rights outright.** The 83-word Collexy passage was the single largest block of
  third-party prose anywhere in the repository, larger than any video quote the
  closeout removed.
- **pkmn.gg stays cited, for the reason given last time.** Its ten entries were
  already the project's own restatements of set-list counts; they are now marked
  and attributed like the rest. Citing a source is not copying it.

**Implications and verification.**

- **The guesses did not move.** The resolver digest probe re-ran over the same
  **10,312 inputs** and returned
  `8541aa1b389d5a8b04508aa237189dce196ef470f358dc913c8c9584beafc367` —
  **identical to `RECEIPT.md` and to both receipt files**, with the same tier
  split (4,160 `facet`, 2,664 `set`, 2,520 `series`, 880 `card`, 88
  `heuristic`) and `RESOLVER_VERSION` 5. Citation text is evidence *for* a row,
  never an input *to* it, and the digest is what proves that rather than
  asserting it.
- **Both derived indexes regenerate byte-identically.**
  `tools/build-assignments-index.mjs` (125 rows, 21 facets) and
  `tools/build-usage-index.mjs` (122 rows) produce no diff at all — not even a
  citation-text change, because neither index carries quote text, only
  hostnames.
- **177/177 tests pass; `reuse lint` is clean** (575/575 files carry copyright
  and licence information; CC0-1.0 and MIT, no bad or deprecated licences).
- **Longest remaining verbatim-looking run: 19 words, and it is a list of
  Pokémon names** — "Ho-Oh, Lugia, Pikachu, Wobbuffet, Hoothoot, Noctowl,
  Feraligatr, Meganium, Typhlosion, Latias, Latios, Cleffa, Smoochum, Shuckle,
  Raikou, Entei, Suicune, Porygon" — which is the enumerated fact itself and is
  not expression anyone can own. The next two are set names in a list (11 and 10
  words, both "Wizards Black Star Promos, Southern Islands and Best of Game").
  **The longest run containing any connective prose at all is 8 words** —
  "Raichu came in the Supreme Victors Value Pack", five of them proper nouns.
  Mean shared run across all 340 is 4.4 words. The longest paraphrase in the
  file is 46 words, against an 83-word longest original.

This closes the item the previous entry flagged. Nothing about the source-quote
policy is now outstanding in either evidence file.

---

## 2026-09-01 — The stage is two packages: policy without a renderer, and a binding with one

**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** "One renderer, any number of cards" ships as **`@foilkit/stage`**
(the budget ladder, the six tilt sources, the frame schedule, the scissor
arithmetic, the texture sizing — importing nothing) plus **`FoilStage` inside
`@foilkit/three`** (one canvas, one `WebGLRenderer`, a material cache keyed by
`patternId`, a texture cache keyed by URL, one rAF loop, one
`IntersectionObserver`, one `ResizeObserver`).

**Why:** folding all of it into `@foilkit/three` was the obvious alternative and
was refused for a concrete reason, not an aesthetic one. A `packages/stage` that
depended on `@foilkit/three` would have been imported back by
`three/react/CardViewer`, and TypeScript project references forbid the cycle;
breaking the cycle by moving `CardViewer` into the new package would have
changed its import path, which is a public shape this work promised to keep.
Splitting *policy* from *binding* has no cycle in either direction, and it buys
something real: the ladder and the sources are arithmetic over rectangles and
frame times, so they are tested by `node --test` with no GPU (40 new tests), and
a future `webgl2` or `element` adapter inherits the architecture instead of
reimplementing it. `tools/check-independence.mjs` now proves `stage` imports no
renderer, exactly as it does of `core`.

**Implications:**

- `CardViewer` keeps every prop it had and becomes a thin host registering one
  element, in `blit` mode so its overlays and pan/zoom wrapper are untouched.
  `useTilt` keeps its public shape and delegates the mapping to the stage's
  sources.
- `options.renderer` is honoured, never restyled and never disposed: a host
  already running a three.js scene must not be forced into a second context.
- **`renderScale` is a no-op in `underlay`.** A card's pixels there ARE the
  page's pixels and cannot be scaled up after the fact. It is live in `blit`,
  where a card is rendered small and stretched on the way out. Rung 1 therefore
  has one step fewer in underlay, and the ladder moves on to rung 2 rather than
  pretending otherwise.
- **Frozen (rung 3) and stopped (rung 4) cards are still DRAWN in `underlay`.**
  Freezing means the image stops changing, which is what the rung is for; it
  saves the per-card CPU work and not the fragment shading. In `blit` a frozen
  card skips its render and its blit entirely, so it saves both.

## 2026-09-01 — The ladder reads work time, and `preserveDrawingBuffer` was refused

**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** The budget ladder's input is the stage's own **work** time — how
long its frame callback took — compared against the budget of the cadence
currently being run when deciding to drop, and against the TARGET cadence when
deciding to climb. `blit` reads the shared drawing buffer with `drawImage`
inside the same frame, and the renderer is created **without**
`preserveDrawingBuffer`.

**Why:** the obvious signal, the wall-clock gap between frames, is
self-defeating: rung 2 lengthens that gap deliberately, so a ladder reading its
own cadence as evidence of load can drop but can never climb back. Judging drops
and climbs against different budgets is what lets a stage sit correctly at 30fps
without either oscillating or getting stuck there.

`preserveDrawingBuffer: true` was considered for a different design of rungs 3–4
— clear only the dirty card rects and let frozen cards' pixels persist, which
would have saved fragment shading in `underlay` too. Refused: it costs a
driver-dependent full-frame copy every frame, and it breaks the moment the page
scrolls, because a persisted rect is in the wrong place as soon as its element
moves. Reading the buffer inside the same task needs no such flag.

**Implications:** the ladder can be exercised deterministically by adding
measurable work rather than by finding a slow machine — `stage.syntheticLoadMs`
busy-waits inside the measured region, the demo exposes it as a slider, and the
acceptance test uses it. That is the only honest way to assert "engages and
recovers" in CI, since the ladder reads work time and has no idea where the work
came from. Measured on this run: forced 26ms of work per frame took the ladder
from step 0 to step 7 (rung 2, "30 fps") and it returned to step 0 within ~15s
of the load being removed.

## 2026-09-01 — The stress demo commits no card imagery, and its faces are arithmetic

**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** `apps/demo` draws its card faces in a canvas from a seeded
generator. No scan, no fetch of one, no fixture. What is real in it is the
shipped recipes, their canon snapshots read from `data/foil-canon`, the shipped
composite and the shipped stage.

**Why:** F2 (source and reference, never copy) is written to cover `data/`, a
demo and a test fixture in the same breath, and there is nothing to trade away
here: the texture budget is a function of SIZE and COUNT, and the generated
faces are the same size and count real scans would be. A blank base also
exercises the classic composite path (`uScanBase: 0`), which is the one the
canon files were tuned under.

**Implications:** the demo is runnable by anyone who clones the repository, with
no credentials, no image proxy and no network beyond the local static server —
which is also what makes it viable as a CI gate. The acceptance job runs it in
headless Chromium under SwiftShader as a separate workflow job, so a
contributor's unit-test failure is not queued behind a browser download.

## 2026-09-01 — Vector masks rasterise at the size the stage chose, and the common tier uploads nothing

**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** The stage takes a `maskVector` — a rasteriser it calls with a
width and height IT picked from the card's on-screen box — rather than a stored
raster. Masks get half the face budget and a 512px ceiling
(`maskTextureWidth`). Cards sharing a `maskVectorId` share one rasterisation per
size. Where there is neither a hand mask nor a vector one, the layout-rect tier
renders with **no texture at all**.

**Why:** `uMaskTex` is low-frequency alpha — the feather is 0.008 UV, several
pixels wide at any plausible size — so a mask matched to face resolution buys
detail the shader immediately blurs away. And a mask stored as geometry has no
size to be wrong: the stage measures the box, picks a width, and asks for it, so
"which raster size do I store" is a question that never gets asked. The
signature is deliberately the one `@foilkit/forge`'s `rasterizeTemplate(tpl, w,
h, opts)` already has, so the authoring stack plugs in unchanged, and
`rasterizeSvgMask(d)` covers the case where a host has only a path string —
`Path2D` speaks SVG path syntax natively, arcs included.

The stage does NOT depend on `@foilkit/forge` to do this. Forge reaches for
`node:fs` in several modules, and a browser-side stage importing it would drag
the authoring stack into every consumer's bundle. Passing the rasteriser in is
one function and no dependency.

**Implications:** measured in the demo — 42 mounted cards, one third of them
vector-masked, produce **one** raster. The other two thirds upload nothing,
which is the reason three hundred cards hold six textures rather than three
hundred and six. Changing a template's geometry requires changing its
`maskVectorId`; the cache key is the id and the size, not the function
identity.

## 2026-09-01 — The dead band probes, because a one-way ladder is not a ladder

**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** After `probeAfterMs` (default 5s) sitting in the dead band — under
budget, but without the clear headroom a fast climb needs — the ladder steps up
ONE rung to see whether that rung holds. A probe undone by a drop within
`probeGraceMs` counts as refused and the probe interval doubles, to a 60s
ceiling; clear headroom resets it.

**Why:** CI found this, on the same run as the pixel-ratio bug, and it is the
more interesting of the two. The GitHub runner's resting frame work landed
inside the dead band. That made it stable at step 0 — correctly, nothing was
over budget — but it also made it stable at step 5 after a transient, because
climbing required headroom the machine never had. The run recovered 8 → 5 and
stopped, and a page in that state is quietly worse until it reloads. "It climbs
back up as headroom returns" cannot be true if the ladder is a one-way door: a
stall becomes indistinguishable from a correct answer.

The dead band's *width* is what makes this bite. It is 0.6 to 1.0 of the target
budget — 10ms to 16.7ms at 60fps — which is a large and entirely ordinary place
for a real machine to live.

**Implications:** a transient can no longer permanently degrade quality; the
worst case is a machine that oscillates between two adjacent rungs, and the
backoff makes that rare and then rarer. Two tests pin it: a transient followed
by 40s of dead-band work must return to step 0, and a rung-dependent workload
where the step above genuinely does not hold must produce fewer than 30 rung
changes over 320 simulated seconds — where a fixed 500ms probe would produce
about twelve hundred.

## 2026-09-01 — Boxes handed to a renderer are in CSS pixels

**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** `cardGlBox` returns CSS pixels, and everything the stage hands
three.js is in that unit. The only device-pixel arithmetic left is the blit's
`drawImage` source rect, which reads the drawing buffer directly.

**Why:** three multiplies every `setViewport`/`setScissor` by its own
`_pixelRatio` on the way to GL. The stage was converting to device pixels first,
so the ratio went on twice. That is the identity at ratio 1 and invisible; at
0.5 it draws every card into the wrong quarter of the screen. It survived local
testing and four green checks in the same CI run for one reason: this machine's
ladder rests at step 0, so every screenshot was taken at ratio 1. The runner's
rests lower, and both modes screenshotted flat background — one distinct colour,
luma 14 to 14 — while contexts, programs, textures and draw calls all still read
correct. The cards were being drawn perfectly, somewhere else.

**Implications:** the acceptance now screenshots each mode a second time with
the ladder PINNED to a reduced-resolution step. A bug invisible at full quality
is not caught by a test that only ever runs at full quality, and waiting for a
slow machine to reveal it is not a test — it is luck, and this time the luck
belonged to CI rather than to a user.

## 2026-09-01 — npm publishes will use `@cheyras/foilkit-*`; the repo does not rename

**Decided by:** @cheyras

**Decision:** the workspace keeps `@foilkit/core`, `@foilkit/patterns` and the
rest. When these are published it will be under **`@cheyras/foilkit-*`**,
because there is no npm organisation behind this project and one person's scope
is a more honest home for it than an org created only to hold a name. Nothing in
the repository is renamed now.

**Why:** the scope a package is published under and the specifier the source
imports are different questions, and conflating them costs a churn commit across
every file for zero behaviour. Subtask 1 reserved `foilkit` on npm; the org was
never created, so `@foilkit/*` is not actually held.

**Implications:** `README.md` states the publish name so a reader is not
surprised. The rename happens once, at publish time, and the packages' `name`
fields are the only thing it touches — `packages/*` directory names,
`pnpm-workspace.yaml` and every import specifier stay as they are.

## 2026-09-01 — `assets.tcgdex.net` sends `access-control-allow-origin: *`, and the proxy ships anyway

**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** the CORS question subtask 7 opened is **answered: permissive**.
Measured with `curl -D -`, with and without an `Origin` header, on
`https://assets.tcgdex.net/en/base/base1/4/high.webp` — `200`,
`access-control-allow-origin: *`, `access-control-expose-headers:
Content-Length,Content-Range`; the `OPTIONS` preflight answers `204` with
`access-control-allow-methods: GET, OPTIONS`. A cross-origin
`<img crossOrigin="anonymous">` therefore uploads as a WebGL texture without
tainting the canvas. **`api/image.ts` ships regardless.**

**Why:** only one of the three reasons for the proxy was ever about CORS. The
other two hold whichever way the check landed: a volunteer-run CDN should not be
hammered every time somebody scrubs a set, and — the one that matters for the
corpus — subtask 4's frame registry resolves a framing from **source URL +
raster dimensions**, so a URL under our control is what keeps that key stable
when upstream re-encodes something. A green CORS result means dropping the proxy
stays *available* later; it is not a reason to skip it now.

**Implications:** the frame registry's key is `/api/image?p=…` for anything the
editor draws over, and it stays that way even if upstream's URL structure moves.
The `src=` form exists so a recorded source URL passes through byte-identically.
SSRF is closed by construction rather than by an allow-list check: the function
only ever builds `${ASSETS_ORIGIN}/${path}` from a path that matched a strict
five-segment regex.

## 2026-09-01 — The client-side search index is ~700 KB, and is partitioned anyway

**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** the static search index is **601–741 KB raw / 75–223 KB gzipped**
at catalog scale, partitioned by normalized first letter into 27 buckets loaded
on demand.

**Why (the measurement, n stated):** `/search` was a Postgres full-text query;
static means an index in the browser, and subtask 7 flagged it as the one place
in the read path with real size implications. It was measured rather than
guessed: the real emitter was run over 20,500 synthetic cards / 41,471 printings
/ 184 sets — the catalog's own scale, taken from `data/foil-pattern-cards.json`
— with **cardId lengths drawn from the real measured distribution** in
`data/foil-card-assignments.json` (n = 341, mean 10.32 chars, min 6, max 15) and
card-name length swept at 11/14/18 chars under two entropy models to bracket
gzip. That range is the answer; the fixture bake measures 9.6 KB raw / 3.4 KB
gzipped at 300 cards.

**Implications:** 700 KB is small enough to ship whole, so partitioning is not
load-bearing — it is there so a first keystroke does not pay for the
twenty-five buckets it excluded, and because a bucket is the unit that grows
when the catalog does. `data/search/index.json` records the measured byte
totals, so the decision stays answerable against a number. RUN-BAKE.md names
~2 MB raw / ~600 KB gzipped as the threshold that would justify revisiting it.

## 2026-09-01 — Ownership comes out of the editor; the replacement filters are contribution-shaped

**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** `ownedOnly`, the owned-only chip, the per-series owned counts, the
per-set "N owned" and the per-card ownership badge are **removed** from the
hosted editor — not hardcoded to `false`. They are replaced by
**has-mask / no-mask / has-window-geometry**, answered from
`data/corpus-manifest.json` rather than from a query parameter.

**Why:** there is no DeckPal account behind `foilkit.deckpal.app`, so an
owned-only filter has nothing to filter against. A dead parameter threaded
through four `useQuery` calls is worse than its absence, because the next person
has to work out whether it does anything. And the replacement is not a
substitute for the old filter — it answers the question a contributor actually
has, which is "what work is and is not done".

**Implications:** the baked catalog shards must never carry a user column, a
collection count or an internal id; `tools/bake/guards.ts` asserts that
structurally by walking every emitted object for a forbidden key. The ownership
dot on a card thumbnail became a MASK dot — the contribution fact in the same
three pixels.

## 2026-09-01 — The editor's home screen is a queue, not a card picker

**Decided by:** Claude Fable 5 on behalf of @cheyras, on 3a's measurement

**Decision:** `/` renders the verification map's rule groups ranked by leverage
(`printings ÷ (exemplars + 1)`). The card picker lives on `/card` and is what
you reach for when you already know which printing you came for.

**Why:** 3a produced the ranking specifically to answer "is the editor a card
picker or a queue", and the answer is in the numbers: the top group is
`modern-swsh / sheet / energy-symbols-ii / set` governing **2,041 printings with
zero human exemplars**, and the top five all govern 500+ printings each. A
picker asks which card you came for; most of the time the honest answer is
"whichever one teaches the rule the most".

**Implications:** the queue draws no progress bar and no completion state, and
the end-to-end run asserts there is no `<progress>` element anywhere. Nothing in
this corpus is ever blank — a card with no human attention is *guessed*, not
missing — so a completion bar would be a lie about both halves. Groups above a
leverage floor are labelled as a **regeneration pass** rather than offered as a
button, because that is a tool run against the corpus, not a thing a browser
does.

## 2026-09-01 — A staged session's seed is immutable, which is what makes one correction per session free

**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** `updateMaskSession` has no path to `session.seed`. Every
intermediate save updates pixels, geometry, uniforms and the comment; the seed
is written once, when the session is created, and the single PUT at submit
carries `derivation { startedFrom, parent }` from it.

**Why:** the old lab rewrote `session` on every Save so the mask just written
became the parent of the next — ten saves on a card produced ten correction
records, ten parent PNGs, ten diffs. Collapsing that to one needed **no change
to the provenance contract at all**: `writeMaskRecord` reads the parent from
disk at write time and derives `derivation_method` by diffing saved pixels
against what the declared seed rasterizes to. Making the seed structurally
unreachable turns "one correction per session" from a discipline into a
property.

**Implications:** `keep-mine` on a conflict changes nothing about the payload —
the correction lands against current upstream automatically, which is exactly
what "reparented onto current upstream" means. The trade is ten weak training
samples for one strong one per card, which is right for the corpus and is worth
remembering when #10 recalibrates exemplar weights.

## 2026-09-01 — Conflicts compare the resolved answer, not the seeded file

**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** conflict detection runs **two** comparisons: the sha256 of the
mask that answers now against the one stashed at seed time, AND the identity of
the record that answered. Five outcomes — `none`, `parent-changed`,
`alias-moved`, `parent-vanished`, `parent-appeared` — and three choices,
`keep-mine` / `take-theirs` / `re-trace`. Never a merge.

**Why:** masks alias across variants by `prior.scope`, so upstream can grow a
*sibling* mask that changes which record answers for the staged variant
**without touching the file that was seeded from**. A sha comparison against the
seeded file sees nothing. The pixels are not in conflict in that case; the
provenance parent is, and a correction recorded against the wrong parent is a
lie in the training signal.

**Implications:** the probe carries an identity as well as a hash, and the
end-to-end run asserts the alias case separately from the sha case — with
identical pixels on both sides, so a test that only moved the sha would pass
while the bug shipped. Nothing auto-merges: two people painting the same alpha
channel have no lines to reason about, and any automatic result is
plausible-looking garbage nobody drew.

## 2026-09-01 — The undo stack is not persisted

**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** a staged session persists current pixels, the seed, and the parent
sha. Not the undo history.

**Why (measured):** mask PNGs average 7.7 KB and the whole 96-file corpus is
738 KB — masks were never the constraint. `MaskEditor` keeps 12 `ImageData`
snapshots at canonical raster, ~1.4 MB each, ~16 MB per card. Persisting three
orders of magnitude more data to preserve a 12-step history through a tab close
is a bad trade.

**Implications:** IndexedDB is still the right store (binary-friendly, async,
quota in hundreds of megabytes), but it was chosen against the undo number
rather than the mask number. The end-to-end run asserts a stored session is
under 400 KB, so a future change that starts persisting history fails loudly.

## 2026-09-01 — A direct write is a commit; the writer list is compiled in

**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** `api/mask.ts` materialises the corpus into `/tmp` from the
repository head, runs the real `writeMaskRecord` against it, and commits exactly
what changed through the git data API with `force: false`. The writer capability
is a list in `api/_lib/writers.ts`, mirrored in the editor, with a test that
reads the editor's source and compares.

**Why:** running the same `writeMaskRecord` is what keeps `derivation_method`
server-derived — a second implementation of that rule would be a second place
for it to be wrong. Compiling the list in rather than reading it from an env var
means granting the second writer is a reviewable commit rather than a dashboard
click, and the mirror test means the UI can never offer a save the server
refuses, or hide one it would have allowed.

**Implications:** `@foilkit/forge`'s `FRAMES_FILE` had to become lazy and
`FOILKIT_FRAMES_FILE`-overridable, because it walked for a `pnpm-workspace.yaml`
at import time and threw inside a bundle that has none. The gate is not
weakened: a raster matching no frame record still refuses to save.
**Attribution limitation, stated rather than hidden:** the commit's committer is
the project token's account and the author is the signed-in writer
(`<id>+<login>@users.noreply.github.com`). Subtask 9's GitHub App collapses the
two; this is the honest interim. The `force: false` on the ref update is the
same principle as the conflict UI one layer up — if somebody pushed in between,
refuse rather than discard.

## 2026-09-01 — Deletions are not stageable in v1

**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** `deleteMask` / `deleteWindow` / `deleteCanon` stay live for a
writer-capability holder and are **absent** from the staging layer. There is no
"stage a deletion" path and no flag to flip.

**Why:** a contributor's first available action should not be removing ground
truth. A deletion also has no diff to review — the PR would be an empty file and
a claim — so there is nothing for #9's pipeline to put in front of a reviewer.

**Implications:** re-open it when there is a reviewer flow that can weigh one.
Deleting a canon file is recorded in its commit message as "this pattern is
recorded as never canon'd again", because that absence is real signal for #11's
queue rather than a reset to defaults.

## 2026-09-01 — Canon edits get a second session type, keyed by patternId

**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** the staging layer holds two session kinds —
`mask:<cardId>:<variantId>` and `canon:<patternId>` — sharing a store, an export
bundle and the conflict machinery, with their own eventual PRs.

**Why:** a canon file is per-*pattern* and global. It does not belong to any
card, so it cannot ride the one-session-per-card rule without lying about what
it is.

**Implications:** a canon conflict is sha-only — a full uniform snapshot has no
aliasing — and offers `keep-mine` / `take-theirs` and no `re-trace`, because
there is nothing to ghost underneath a slider. The hash is taken over a
canonicalised (key-sorted) serialisation, so two files differing only in key
order are the same canon.

## 2026-09-01 — A contributor's comment becomes PR body text, not a committed file

**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** the comment box no longer writes `issues/foil/<id>/report.md` +
`context.json` into the repository. The text is stored in the staged session and
carried in the export; it becomes the PR body when #9's pipeline ships.

**Why:** a stranger's note about their own change belongs in the review, not in
the tree. Committing it also means every drive-by note is a permanent file
somebody has to prune later.

**Implications:** stored and exported, never committed — so nothing is lost in
the interim, and the eventual PR body can be assembled without re-deriving
anything. A direct write puts the note in the **commit message body** instead,
which is the same idea in the place a writer already has.

## 2026-09-01 — The provisional local diff is built, and is labelled provisional everywhere

**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** the editor computes an offline agreement number by rasterizing the
seed client-side. It is shown as provisional, never persisted into a session,
and never sent in a payload.

**Why:** the server decides `derivation_method` and `agreement` by diffing the
saved pixels against what the declared seed rasterizes to, and the client must
never label a mask. But the client owns the same rasterizer, and editing
entirely blind for a whole session hides the one number that says whether the
work is improving the shared rule or fighting it.

**Implications:** `provisionalDiff.ts` is a **line-for-line port** of forge's
`rasterizePriorAlpha` and `diffMask`, because forge reaches `node:zlib` through
its PNG codec and cannot enter a browser bundle. A parity test runs in Node —
where both are importable — and asserts byte-equality across seven geometries
including the inverted sheet, a zero-area rect and a radius larger than its box.
If forge's rasterizer moves and the port does not, that test fails. That is the
only thing that keeps a port a port.

## 2026-09-01 — `data/frames.json` is fetched, not bundled, by the write endpoint

**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** `api/mask.ts` downloads `data/frames.json` from the repository
head into its `/tmp` workspace and points `FOILKIT_FRAMES_FILE` at it, per
request.

**Why:** the frame gate is what stops a mask being authored over a scan nobody
can name, and a stencil cut for an unnamed picture is worse than no stencil.
Bundling the registry into the function would freeze it at deploy time, so a
`data/frames.json` update would authorise masks against numbers the corpus no
longer uses — and the drift would be silent, which is the failure mode the gate
exists to prevent.

**Implications:** one extra API read per write, on a path that already makes
several. The registry and the pixels it authorises are the same generation, by
construction.

## 2026-09-01 — The uncanon'd pattern count is 12, not 13

**Decided by:** Claude Fable 5 on behalf of @cheyras

**Decision:** `data/corpus-manifest.json` derives the uncanon'd list rather than
trusting a count, and the derived answer is **12**: `ace-spec`, `acid-wash`,
`crosshatch`, `disco`, `energy-symbols`, `energy-symbols-ii`, `ex-starfoil`,
`pokeball-masterball`, `prism`, `prismatic-pokeball`, `rainbow-mirror`,
`tcg-classic`.

**Why:** subtask 5 recorded 13, which is `45 implemented patterns − 32 canon
files`. That arithmetic counts `none`, the no-foil recipe, which has no canon by
definition and never will. The corpus itself has not moved.

**Implications:** the builder prints a `FINDING:` line whenever the derived list
disagrees with the recorded count, and does **not** fail the build over it — a
count is a claim and the corpus is the measurement. `docs/HOSTED-EDITOR.md` was
corrected.
