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
- Every `.ts`/`.js`/`.mjs`/`.glsl` file must carry
  `// SPDX-License-Identifier: MIT`. This is new convention, not a port — the
  origin repository has zero SPDX headers anywhere.
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
- **The extraction itself.** No library code, no dataset and no `packages/`
  directory exist in this repository yet.
