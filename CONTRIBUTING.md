# Contributing to foilkit

foilkit is **a dataset with a renderer attached**. Most of what is valuable here
is measurement — which foil pattern a real printing actually carries, where the
foil actually sits on the card, how it actually behaves under tilt. The shader
is the part that makes the measurement visible.

That shapes the licensing, and the licensing shapes what we need from you.

---

## The rule, in one table

| What you are contributing | License it goes in under | What you have to do |
|---|---|---|
| Code — `packages/**`, `.ts`, `.js`, `.glsl`, tooling | **MIT** | DCO sign-off |
| Data — anything under `data/`, any `*.canon.json`, resolver tables, mask PNGs | **CC0-1.0** | DCO sign-off **and** an explicit public-domain dedication |
| Docs | **MIT** (see `REUSE.toml`) | DCO sign-off |

Both lines of that middle row are required. Here is why the second one is not
redundant.

## A sign-off is not a dedication

The Developer Certificate of Origin certifies something narrow and useful: that
you wrote the contribution or have the right to submit it, and that you are
submitting it **under the project's license**. It is a statement about
provenance and permission.

It is **not** a public-domain dedication. CC0 is an affirmative act — the
rights-holder abandons their rights in the work. Nothing in the DCO performs
that act, and nothing in it can. A contributor who signs off on a pull request
adding a canon file has certified that they had the right to submit it; they
have not placed it in the public domain.

That distinction matters more here than it would in most projects. The dataset's
whole claim is that it is unencumbered — that anyone can take the whole corpus
and do anything with it, with no attribution and no permission. A single
contributed measurement that was merely *licensed* rather than *dedicated*
punches a hole in that claim, and it is a very hard hole to close retroactively:
you have to find the contributor, years later, and ask.

So we ask at the moment of contribution, when it costs nothing.

## The dedication

For any pull request touching `data/` or a `*.canon.json` file, the PR body must
carry this line:

```
CC0-Dedication: I dedicate my contributions to the data in this pull request to
the public domain under CC0 1.0 Universal, waiving all copyright and related
rights worldwide to the extent permitted by law.
```

The pull request template puts it there for you as a checkbox. Tick it
knowingly; do not tick it for someone else's measurements.

**This is automatic if you contribute through the editor.**
[foilkit.deckpal.app](https://foilkit.deckpal.app) composes your session into a
pull request and inserts the dedication line into the body itself, from the
GitHub identity that authorised the submission — so approving your own pull
request *is* your assent. No checkbox, no opportunity to forget.

The template is still here, and still not optional, for pull requests opened by
hand. `functions/_lib/pr-body.test.ts` reads this file and asserts that the App
inserts **this exact string**: if the two ever drift apart, the test suite fails
rather than the dedication quietly becoming a paraphrase somebody has to
litigate.

## DCO sign-off

Every commit needs a `Signed-off-by` trailer:

```
Signed-off-by: Your Name <your.email@example.com>
```

`git commit -s` adds it. It must be a real name and a reachable address, and it
certifies the [Developer Certificate of Origin 1.1](https://developercertificate.org/).

## The standing ownership rule

**Ship nothing we do not own outright.** Anything third-party comes in by
*source and reference*, never by copy.

This is not a preference; it is what makes a CC0 dataset honest. A dedication
you did not have standing to make is worse than no dedication. Concretely:

- No card artwork, no scans, no logos, no game rips, no traced or extracted
  trademark glyphs — not in `data/`, not in the demo, not in a test fixture.
- Reference imagery is *cited*, not vendored. Ship the citation and the
  procedure that fetches it locally.
- Anything original that fills a gap left by a rejected third-party asset gets a
  **notice file** recording what was investigated, what was rejected and why, and
  who authored the replacement. See `NOTICE-CONVENTIONS.md` for the shape.

If you are unsure whether something clears this rule, open an issue before you
open a pull request.

## Attribution

Agent-authored commits (repository **and** wiki) carry two trailers:

```
On-Behalf-Of: @<github-handle>
Co-Authored-By: <agent model> <noreply@anthropic.com>
```

Human contributors' own commits carry no `On-Behalf-Of` trailer — its absence is
what marks a commit as directly human-authored. The wiki's
`Contribution-Record` page is the running ledger; append one row per work
session.

None of this is a license condition. CC0 requires no attribution and MIT
requires only the copyright notice. The ledger exists because a dataset whose
provenance is legible is worth more than one whose provenance is merely
asserted.

## Contributing through the editor

You do not have to open a pull request by hand, and for a mask or a canon tune
you probably should not.

[**foilkit.deckpal.app**](https://foilkit.deckpal.app) is the hosted editor.
Browsing and drawing need no account at all: open a card, paint a mask, and
press Save — the session is stored in your browser and survives a reload, a tab
close and days of gap. One card is one session.

When you are ready, **Submit** from the *Staged work* screen. That is the one
moment sign-in is asked for, and here is exactly what happens:

1. Your session is **validated server-side, before anything is pushed** — the
   PNG parses and is the canonical 504 × 704, the mask actually distinguishes
   foil from non-foil, the seed's parent is pinned, and the session is not stale
   without you having seen that it is. A failure is a checklist, not a pull
   request.
2. A GitHub App commits your session to `contrib/<your login>/…` and opens one
   pull request. The commit is authored by the App and carries
   `Co-authored-by: <you>`, so **your avatar is on the commit and your name is
   on the pull request**.
3. The body carries your own note about your change, the provenance numbers, the
   conflict status, the DCO sign-off and — for anything touching `data/` — the
   CC0 dedication above.
4. A workflow renders an **8-frame tilt sweep** of what you submitted and posts
   it as a comment. That is also the compile gate: a shader that does not link
   fails there.

Submitting the same session again updates the same branch and the same pull
request. Nothing is ever discarded from your browser by submitting.

If the deployment has no App configured, Submit says so, names the missing
configuration, and leaves your session exactly where it is. Export it from the
same screen and nothing is trapped in one browser.

## Before you open a pull request

- Read `AGENTS.md`. It is short, and it is the engineering contract — human or
  agent, it applies to you.
- Log anything non-trivial in `DECISIONS.md` (format is in `AGENTS.md`).
- Data changes: say what you measured, on how many cards, and what stayed
  unresolved. A measurement with no `n` is an opinion.

## Status

The library code has landed — `packages/{core,patterns,stage,three,resolver,forge}`
build and are tested, the hosted editor is live at
[foilkit.deckpal.app](https://foilkit.deckpal.app), and the contribution
pipeline described above opens real pull requests. Issues, discussion and
contributions are all welcome.
