<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 Chey Rasmussen -->

# Deploying foilkit.deckpal.app

The hosted contribution editor. A static Vite SPA plus a handful of Vercel Node
functions, with **no database at runtime**.

Everything here is for the maintainer. Two steps in this document cannot be done
by an agent and were deliberately left undone: **creating the Vercel project and
setting its environment variables**, and **running the catalog bake**
(`RUN-BAKE.md`), which needs a Postgres connection.

> **AGENTS.md F6 — no unilateral infrastructure mutations.** Reading Vercel
> configuration is free; changing it needs the maintainer's explicit yes, every
> time, including for changes that look obviously safe. Nothing in this document
> is permission to run any of it.

---

## What deploys

| | |
|---|---|
| **Domain** | `foilkit.deckpal.app` — a DNS record on DeckPal's domain pointing at a **new Vercel project sourced from the foilkit repo**. Two projects, one apex domain. |
| **Source** | `cheyras/foilkit`, branch `main` |
| **Build** | `pnpm run build:vercel` (in `vercel.json`) |
| **Output** | `.vercel/output` — the **Build Output API**, produced by `tools/build-functions.mts` |
| **Functions** | `functions/**/*.ts`, esbuild-bundled one file per route, `nodejs22.x` |
| **Secret store** | **foilkit's own, never DeckPal's.** Subtask 9's App credentials will live here too. |

The deploy carries no shared backend and no shared env with DeckPal. The editor
never calls DeckPal's API.

### Why the build emits `.vercel/output` itself

The first production deploy answered `500 FUNCTION_INVOCATION_FAILED` on every
function — a boot crash, before any handler ran. `@vercel/node` transpiles each
`.ts` file in place without rewriting import specifiers, so `from
'./_lib/http.ts'` survived into the emitted JS beside a file called
`_lib/http.js`; and workspace packages were copied into the bundle with nothing
mapping `@foilkit/forge` to them. Both are packaging, not code.

`tools/build-functions.mts` bundles each route into one self-contained file and
writes the whole deployment — static, functions and routing table — through the
Build Output API. Vercel then uses that directory verbatim and builds nothing of
its own, so **the artifact deployed is the artifact verified locally**.

Two consequences worth knowing before you edit anything:

- **`vercel.json` is two commands and nothing else.** Its `rewrites`, `headers`,
  `functions` and `outputDirectory` keys would be ignored, so they are gone
  rather than misleading. The routing table lives in `tools/build-functions.mts`.
- **The sources live in `functions/`, not `api/`.** A root-level `api/` is what
  Vercel's zero-config detection looks for, and with the sources there BOTH
  builders ran and wrote into the same `.func` directory. The routes are still
  served at `/api/*`.

---

## Environment variables

Every variable a feature depends on is declared here in the same commit that
introduced the code reading it. A missing one **fails loudly** — the endpoint
answers `500 not_configured` and names the variable — rather than degrading into
"nobody is ever a writer", which would be a mystery instead of an error.

| Name | Purpose | Environments | Secret? | Missing behaviour |
|---|---|---|---|---|
| `FOILKIT_SESSION_SECRET` | HMAC key for the signed session cookie. **≥ 32 characters**; generate with `openssl rand -hex 32`. | Production, Preview | **yes** | `/api/me` and every write endpoint answer `500 not_configured`. Read and staging are unaffected. |
| `FOILKIT_OAUTH_CLIENT_ID` | The GitHub OAuth App's client id. Public half. | Production, Preview | no | `/api/auth/start` answers `500 not_configured`; the Sign in link fails. |
| `FOILKIT_OAUTH_CLIENT_SECRET` | The same App's client secret. | Production, Preview | **yes** | The callback answers `500 not_configured`; nobody can complete sign-in. |
| `FOILKIT_GITHUB_TOKEN` | The token that **commits** a direct write. Fine-grained PAT scoped to `cheyras/foilkit` with **Contents: read and write** and nothing else. | Production | **yes** | Write endpoints answer `502 write_failed` naming the variable. |
| `FOILKIT_REPO` | `owner/repo` to commit into. Defaults to `cheyras/foilkit`. | optional | no | Uses the default. |
| `FOILKIT_BRANCH` | Branch to commit onto. Defaults to `main`. | optional | no | Uses the default. |
| `FOILKIT_FRAMES_FILE` | Overrides where `@foilkit/forge` reads `data/frames.json`. **Set by the function at run time; do not configure it.** Listed because it exists. | — | no | The write endpoint sets it per request. |

**Never print a value into a transcript or a log.** `vercel env ls` lists names
and targets only; do not run anything that dumps a value.

### Why a PAT and not a GitHub App

The App is subtask 9, and it is the right long-term answer — it can commit *as*
the contributor and open PRs on their behalf. Until it exists, a fine-grained
PAT with one repository and one permission is the smallest thing that works.

**The attribution consequence, stated plainly:** the commit's **committer** is
the token's account; the **author** is the signed-in writer, recorded as
`<id>+<login>@users.noreply.github.com`. Author is the field every log view
shows, so "whose work is this" is answered correctly; "who pushed it" says the
project account. The App collapses the two.

### The GitHub OAuth App

One OAuth App, owned by the maintainer:

- **Homepage URL:** `https://foilkit.deckpal.app`
- **Authorization callback URL:** `https://foilkit.deckpal.app/api/auth/callback`
- **Scopes requested: none.** A no-scope token still reads `/user`, which is a
  public profile, and that is the entire question being asked. This service
  cannot act as the user and never sees their email — `user:email` is
  deliberately not requested, which is why the commit author uses the
  `noreply` form.

The callback URL is registered on the App rather than sent as a `redirect_uri`,
which is what makes it unbypassable from a crafted link.

---

## The maintainer's deploy steps

### 1. Bake the catalog (once, before the first deploy)

The read path has nothing to read until this runs. Follow **`RUN-BAKE.md`** — it
needs `PGHOST`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` (or `DATABASE_URL`) and a
DeckPal checkout for the `pg` driver. Dry-run first, then commit the artifacts:

```bash
node --conditions source tools/bake-catalog.mts --dry-run
node --conditions source tools/bake-catalog.mts
git add data/catalog data/search data/foil-pattern-cards.json data/foil-verification-map.json
git commit -m "Bake: catalog shards, search index, resolver inversion"
git push
```

Vercel builds from git, so an unbaked artifact is a **missing file**, not a stale
one. The editor renders "No catalog has been baked for this site yet" and browse
is unavailable — visibly, which is the point.

### 2. Create the Vercel project

```bash
vercel link --yes --scope <team>        # or create it in the dashboard
```

Root directory: the repository root (**not** `apps/editor` — the build needs the
workspace and the functions need `functions/` at the root). `vercel.json` supplies the
build command, output directory and function config; nothing needs setting in
the dashboard's build panel.

### 3. Set the environment variables

```bash
vercel env add FOILKIT_SESSION_SECRET production
vercel env add FOILKIT_OAUTH_CLIENT_ID production
vercel env add FOILKIT_OAUTH_CLIENT_SECRET production
vercel env add FOILKIT_GITHUB_TOKEN production
```

Repeat for `preview` if preview deploys should be able to sign in. **Do not put
`FOILKIT_GITHUB_TOKEN` in preview** unless you want a preview branch to be able
to commit to `main`.

### 4. Add the domain

Point `foilkit.deckpal.app` at this project. The DNS record lives on
`deckpal.app`; the project is foilkit's. A DNS record is not a derivative work,
so there is no license entanglement — `RELICENSE.md` says so in a sentence.

### 5. Check the artifact before deploying it

```bash
pnpm run build:vercel
node --conditions source tools/verify-functions.mts
```

Boots every built function with an **empty** environment and exercises it.
Expect `34 passed, 0 failed`. This is the check that would have caught the first
deploy's failure, and CI runs it (`--no-network`) on every push.

### 6. Deploy

```bash
vercel --prod
```

### 7. Verify the artifact, not the report (F7)

```bash
curl -sI https://foilkit.deckpal.app/                                  # 200, text/html
curl -s  https://foilkit.deckpal.app/corpus-manifest.json | head -c 200
curl -s  https://foilkit.deckpal.app/catalog/index.json   | head -c 200
curl -s  https://foilkit.deckpal.app/api/me                            # {"login":null,"writer":false,…}
curl -sI "https://foilkit.deckpal.app/api/image?p=en/base/base1/4/high.webp"   # 200 image/webp
```

Then **open it on the iPad** and author a mask. That is the acceptance bar for
this deploy, and it is not a curl.

---

## Local development

```bash
pnpm install
node --conditions source tools/bake-fixture.mts --out data/fixture-bake
node --conditions source tools/build-corpus-manifest.mts
cd apps/editor && FOILKIT_BAKE=fixture pnpm dev
```

`FOILKIT_BAKE=fixture` points the catalog half at a **synthetic** bake — 2
series, 4 sets, 300 invented cards, one of them paged past 250 — while the
corpus half (masks, canon, window geometry) stays the real committed data. The
editor badges a fixture catalog visibly, so nothing there can be mistaken for a
real printing.

`vite dev` does not run the functions, so `/api/*` 404s. The editor already
reads that as "signed out / feature unavailable", which is the correct state.
For the real thing:

```bash
vercel dev
```

---

## Failure modes worth knowing before they happen

### What a half-configured deployment does

Configuration is checked **first**, at the top of each handler, before a cookie
is parsed or a repository is read — so a missing variable is a named `503`, never
a `500` and never a crash. That distinction is the whole point: a boot crash
means the code was packaged wrong, a 500 means it hit something unexpected, and
a 503 naming a variable means the code is fine and you have not finished setting
up. The first deploy conflated all three.

| Variables set | What works |
|---|---|
| *nothing* | Browsing, the queue, staging, **and `/api/image`** — card scans need no environment at all. `/api/auth/signout` still clears a stale cookie. Everything else answers `503 not_configured` naming what it needs. |
| `FOILKIT_SESSION_SECRET` only | The above, plus `/api/me` answering `200` signed-out. Sign-in `503`s naming the OAuth app; writes `503` naming `FOILKIT_GITHUB_TOKEN`. **This is the state the site is in today.** |
| + the OAuth pair | Sign-in works. Writes still `503` naming the token. |
| + `FOILKIT_GITHUB_TOKEN` | Direct write commits. |

| Symptom | Cause |
|---|---|
| `500 FUNCTION_INVOCATION_FAILED` on every route | A packaging failure, not a configuration one. Run `pnpm run build:vercel && node --conditions source tools/verify-functions.mts` — it reproduces boot crashes locally. |
| `503 not_configured` with a variable named | Exactly what it says; see the table above. Nothing is broken. |
| "No catalog has been baked for this site yet" | `data/catalog/` was never committed. Run `RUN-BAKE.md`. |
| A yellow banner naming two resolver versions | The bake is older than the resolver this build ships. Re-bake; pattern assignments may have moved. |
| "Fixture data — this catalog is synthetic" | The deploy was built with `FOILKIT_BAKE=fixture`, or a fixture bake was committed. |
| Sign in does nothing | `FOILKIT_OAUTH_CLIENT_ID` unset, or the App's callback URL does not match `https://<host>/api/auth/callback` exactly. |
| Save says `403 not_a_writer` | The signed-in login is not in `functions/_lib/writers.ts`. Granting is a config line **and a deploy** — the list is compiled in, deliberately, so it cannot be changed without a reviewable commit. |
| Save says `502` mentioning a fast-forward | Somebody pushed between the read and the write. The commit is refused rather than discarding theirs — retry the save. |
| A mask save is refused mentioning a frame | The raster matches no record in `data/frames.json`. A stencil cut for a picture nobody can name is worse than no stencil; this gate is doing its job. |
