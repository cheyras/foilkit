# wiki-staging/ — seven wiki pages waiting for one human click

**This directory is temporary and is meant to be deleted.**

The seven files beside this one are foilkit's wiki, written and ready. They are
sitting in the repository rather than in the wiki because **GitHub will not
accept a push to an uninitialized wiki.** The wiki feature is enabled on this
repository (`has_wiki: true`), but until a person creates the first page through
the web UI, `github.com/cheyras/foilkit.wiki.git` does not exist as a git remote
— cloning it and pushing to it both fail with `Repository not found`. There is no
API, CLI or token scope that initializes it; it is a browser-only action.

Verified 2026-08-31: repository public, wiki enabled, wiki remote absent.

## What the maintainer needs to do

1. Go to <https://github.com/cheyras/foilkit/wiki> and click **Create the first
   page**. Any title, any content — it is thrown away in step 3. Save it.
2. Tell whoever is doing the follow-up work that it is done.

## What the follow-up does

```bash
git clone https://github.com/cheyras/foilkit.wiki.git ~/foilkit.wiki
cp wiki-staging/{Home,Pre-History,Foil-Taxonomy,Shader-Contract,\
Provenance-Model,Decision-Log,Contribution-Record}.md ~/foilkit.wiki/
cd ~/foilkit.wiki && git add -A && git commit && git push
```

Then, in this repository, **delete `wiki-staging/` in the same commit** that
records the wiki going live, so the two copies can never drift. Do not leave this
directory sitting next to a live wiki — a duplicated document that nothing keeps
in sync is worse than no document.

Note the placeholder page from step 1 does not need deleting if it was titled
`Home`; the push overwrites it. If it was titled anything else, delete it through
the wiki UI afterward.

## The pages

| File | What it is |
|---|---|
| `Home.md` | The routing table for the repo/wiki split, and the page index |
| `Pre-History.md` | A **copy** of the foilkit-relevant subset of DeckPal's `Foil-Branch-Log` — 36 deduplicated commit messages from the eight `foil/*` branches, plus the short-commit table. DeckPal keeps the full archive |
| `Foil-Taxonomy.md` | The 43 foil treatments, the four organizing axes, the vocabulary, and what is unresolved |
| `Shader-Contract.md` | The shader ABI deep dive — assembly, entry point, uniforms, composite law, structural versioning |
| `Provenance-Model.md` | The sidecar, derivation methods, exemplar weights, supersede versus correction, aliasing, verification bars |
| `Decision-Log.md` | Snapshot of the repo's `DECISIONS.md` |
| `Contribution-Record.md` | The append-only attribution ledger, with one row |

## Until then

Every `…/wiki/…` link in `README.md`, `AGENTS.md` and `docs/README.md` points at
a page that does not exist yet and will 404. They resolve the moment step 1
happens; they were written against the final URLs deliberately, so that nothing
needs rewriting afterward.

Internal links *between* these pages use the wiki's bare-name form
(`[Foil Taxonomy](Foil-Taxonomy)`), which is correct in the wiki and inert here.
That is expected — do not "fix" them into relative paths.
