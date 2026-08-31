# Contribution Record

The running ledger of contributions to foilkit. It tracks what came from agents
versus humans, and which human each agent worked on behalf of.

**Nothing here is a license condition.** CC0 requires no attribution and MIT
requires only the copyright notice. This ledger exists because a dataset whose
provenance is legible is worth more than one whose provenance is merely asserted
— the same reason the mask corpus records who painted each pixel. See
[Provenance Model](Provenance-Model).

## Attribution conventions

- **Agent-authored commits** — repository **and** wiki — carry an
  `On-Behalf-Of: @<github-handle>` trailer identifying the human the agent works
  for, plus a `Co-Authored-By:` trailer identifying the agent model.
- **Human contributors' own commits** carry no special trailer. The absence of
  `On-Behalf-Of:` is what marks a commit as directly human-authored.
- **Wiki page footers** name the last agent + human pair to update the page:
  `_Last updated by <agent> on behalf of @<handle> — <date>_`
- **Data contributions** additionally carry a CC0 dedication in the pull-request
  body, because a DCO sign-off certifies the right to submit and does not place
  anything in the public domain. See
  [`CONTRIBUTING.md`](https://github.com/cheyras/foilkit/blob/main/CONTRIBUTING.md).
- **This ledger is append-only.** Agents append one row per work session. Never
  edit or remove a past row; append a correction instead.

Format:

```
| <date> | <agent> | @<handle> | <what> |
```

## Ledger

| Date | Agent | On behalf of | What |
|---|---|---|---|
| 2026-08-31 | Claude Fable 5 | @cheyras | Repository bootstrap: created `cheyras/foilkit` public, authored the MIT/CC0 split (LICENSE, LICENSE-DATA, NOTICE, REUSE.toml — REUSE 3.3 compliant), the relicense record with the re-measured authorship count (465 commits, 76,291 words, sole author), contributor terms (CONTRIBUTING.md + PR template with the required CC0 dedication), AGENTS.md, DECISIONS.md, NOTICE-CONVENTIONS.md, and this wiki. |

---

## The pre-foilkit record

The foil work predates this repository. Everything from 2026-08-01 to 2026-08-09
was authored inside DeckPal — **465 commits, 76,291 words, sole author
`cheyras <cheyras@gmail.com>`, zero co-authors**, measured 2026-08-31. That
ledger lives in DeckPal's
[Contribution Record](https://github.com/cheyras/deckpal/wiki/Contribution-Record)
and is not duplicated here; the commit messages themselves are reproduced at
[Pre-History](Pre-History).

That sole-authorship fact is what
[`RELICENSE.md`](https://github.com/cheyras/foilkit/blob/main/RELICENSE.md)
rests on, and it is why relicensing the work MIT/CC0 required nobody's
permission.

_Last updated by Claude Fable 5 on behalf of @cheyras — 2026-08-31_
