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
answers `503 not_configured` and names the variable — rather than degrading into
"nobody is ever a writer", which would be a mystery instead of an error.

| Name | Purpose | Environments | Secret? | Missing behaviour |
|---|---|---|---|---|
| `FOILKIT_SESSION_SECRET` | HMAC key for the signed session cookie. **≥ 32 characters**; generate with `openssl rand -hex 32`. | Production, Preview | **yes** | `/api/me` and every write endpoint answer `503 not_configured` naming it. Read and staging are unaffected. |
| `FOILKIT_OAUTH_CLIENT_ID` | The GitHub OAuth App's client id. Public half. | Production, Preview | no | `/api/auth/start` answers `503 not_configured` naming it; the Sign in link fails. |
| `FOILKIT_OAUTH_CLIENT_SECRET` | The same App's client secret. | Production, Preview | **yes** | The callback answers `503 not_configured` naming it; nobody can complete sign-in. |
| `FOILKIT_GITHUB_TOKEN` | The token that **commits** a direct write. Fine-grained PAT scoped to `cheyras/foilkit` with **Contents: read and write** and nothing else. | Production | **yes** | Write endpoints answer `503 not_configured` naming it, before they read a cookie or touch the repository. (`502 write_failed` is a different answer entirely: the token was present and GitHub refused the commit.) |
| `FOILKIT_REPO` | `owner/repo` to commit into. Defaults to `cheyras/foilkit`. | optional | no | Uses the default. |
| `FOILKIT_BRANCH` | Branch to commit onto. Defaults to `main`. | optional | no | Uses the default. |
| `FOILKIT_APP_ID` | The contribution App's numeric App ID (its settings page, "App ID"). | Production, Preview | no | `/api/contribute` answers `503 not_configured` naming it; Submit says so and leaves the session staged. |
| `FOILKIT_APP_PRIVATE_KEY` | The contribution App's private key, the **whole PEM** including the `-----BEGIN`/`-----END` lines. Newlines may arrive as literal `\n` escapes — the function normalises all three shapes (real newlines, `\n` escapes, surrounding quotes, CRLF). | Production, Preview | **yes** | Same `503 not_configured`. A key that is present but is not a PEM is also a `503`, naming the variable and never echoing the value. |
| `FOILKIT_APP_INSTALLATION_ID` | The App's installation id on `cheyras/foilkit` — the number at the end of `https://github.com/settings/installations/<id>`. | Production, Preview | no | Same `503 not_configured`. |
| `FOILKIT_APP_SLUG` | The App's URL slug, used in the commit author line `<slug>[bot]`. Defaults to `foilkit-contribute`. | optional | no | Uses the default; the commit still lands, the avatar may not resolve. |
| `FOILKIT_APP_USER_ID` | The App's bot user id (`https://api.github.com/users/<slug>%5Bbot%5D` → `id`), used in the commit author address. Defaults to `FOILKIT_APP_ID`. | optional | no | Uses the App id. Cosmetic only — GitHub attributes the commit by the token that pushed it. |
| `FOILKIT_FRAMES_FILE` | Overrides where `@foilkit/forge` reads `data/frames.json`. **Set by the function at run time; do not configure it.** Listed because it exists. | — | no | The write endpoint sets it per request. |

**Never print a value into a transcript or a log.** `vercel env ls` lists names
and targets only; do not run anything that dumps a value.

### Two credentials, two paths — and why both still exist

| | Direct write (`/api/mask`, `/api/canon`, `/api/window`) | Contribution (`/api/contribute`) |
|---|---|---|
| Credential | `FOILKIT_GITHUB_TOKEN`, a fine-grained PAT | The GitHub App, via a 1-hour installation token |
| Who may use it | The writer list in `functions/_lib/writers.ts` | Any signed-in GitHub account |
| Where it writes | `main`, fast-forward, `force: false` | `contrib/<login>/…`, force-updated |
| Result | A commit | A branch, a commit and a pull request |

They are independent. A deployment can have either, both or neither, and each
endpoint's `503` names its own variables — so "Submit is broken" resolves to
"the App is not installed yet" rather than to a mystery.

**The attribution split on the DIRECT path,** stated plainly because it is a real
limitation: the commit's **committer** is the token's account; the **author** is
the signed-in writer, recorded as `<id>+<login>@users.noreply.github.com`.
Author is the field every log view shows, so "whose work is this" is answered
correctly and "who pushed it" says the project account.

**On the CONTRIBUTION path** the commit is authored by the App bot and carries
`Co-authored-by: <name> <id+login@users.noreply.github.com>`, which is the
mechanism GitHub itself uses for this: the contributor's avatar appears on the
commit and their name on the pull request. That matters more than it sounds.
People contribute where their name shows up.

### The contribution App — what to create, exactly

One GitHub App, owned by the maintainer, installed on `cheyras/foilkit` only.

- **Name / slug:** anything; `foilkit-contribute` is what `FOILKIT_APP_SLUG`
  defaults to, so using it means one fewer variable to set.
- **Homepage URL:** `https://foilkit.deckpal.app`
- **Webhook:** **disabled.** Nothing listens for one.
- **Where can this App be installed:** "Only on this account".
- **Repository permissions — exactly two:**
  - **Contents: Read and write** (branches, blobs, trees, commits)
  - **Pull requests: Read and write** (open and update the pull request)
- **Everything else: No access.** In particular *not* Actions, *not* Workflows,
  *not* Administration. The pipeline creates branches and pull requests and does
  nothing else, and a permission granted "just in case" is a permission that is
  on the table the day the key leaks.
- **Account permissions:** none.

Then **Generate a private key** (it downloads a `.pem`), **Install** the App on
`cheyras/foilkit`, and note the installation id from the URL you land on —
`https://github.com/settings/installations/<id>`.

Three values go into Vercel:

```bash
vercel env add FOILKIT_APP_ID production
vercel env add FOILKIT_APP_PRIVATE_KEY production   # the WHOLE pem, BEGIN/END lines included
vercel env add FOILKIT_APP_INSTALLATION_ID production
```

> **The plan said "private key in a secrets manager, not env", and this is env.**
> Vercel's encrypted (sensitive) environment variables **are** this deployment's
> secrets manager: the value is write-only once set, `vercel env ls` prints names
> and targets only, and it is injected into the function process at run time. A
> separate secrets service would add an outbound dependency on the request path,
> a second credential to bootstrap it with, and a new failure mode, in exchange
> for the same property. Rotation is `vercel env rm` + `vercel env add` + a
> redeploy. Recorded in `DECISIONS.md`, 2026-09-05.

**Never paste the key into a chat, a log or a commit.** The functions are written
so that a malformed key produces a `503` naming the *variable* and never the
*value*, and `functions/_lib/app-auth.test.ts` asserts exactly that.

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
vercel env add FOILKIT_GITHUB_TOKEN production          # direct write, maintainer only
vercel env add FOILKIT_APP_ID production                # the contribution pipeline
vercel env add FOILKIT_APP_PRIVATE_KEY production
vercel env add FOILKIT_APP_INSTALLATION_ID production
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

Boots every built function with an **empty** environment and exercises it, then
drives the whole contribution pipeline through the built `/api/contribute.func`
against a **mocked GitHub** — branch, commit, pull request, with the exact
payloads asserted and `main` proved untouched. Expect `74 passed, 0 failed`.
This is the check that would have caught the first deploy's failure, and CI runs
it (`--no-network`) on every push.

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
| `FOILKIT_SESSION_SECRET` only | The above, plus `/api/me` answering `200` signed-out. Sign-in `503`s naming the OAuth app; direct writes `503` naming `FOILKIT_GITHUB_TOKEN`; Submit `503`s naming the three `FOILKIT_APP_*`. |
| + the OAuth pair | Sign-in works. Writes and Submit still `503`, each naming its own. |
| + `FOILKIT_GITHUB_TOKEN` | Direct write commits. Submit still `503`s naming the App. |
| + the three `FOILKIT_APP_*` | **Submit opens pull requests**, for anybody signed in — and the writer's "Open as PR instead" works too. |

The two credential sets are independent on purpose. Adding the App changes
nothing about the direct-write path, and removing the PAT would leave
contribution working and direct write refusing, which is a supportable state
rather than a broken one.

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
| Submit says `503` naming `FOILKIT_APP_*` | The App is not installed, or its variables are not set. Nothing is lost — the session is still staged and still in an export. |
| Submit says `503` about minting an installation token | The App exists but is no longer installed on the repository, or the installation id is wrong. Check `https://github.com/settings/installations`. |
| Submit says `502 pr_failed` mentioning "not accessible by integration" | The App's permissions are narrower than **Contents: write** + **Pull requests: write**. Widen them on the App's settings page, then accept the permission request on the installation. |
| Submit is refused with a checklist | Working as intended. Every item was checked server-side **before a branch existed**, so nothing was pushed and the list is the fix. |
| A pull request has no evidence comment | `PR evidence` only runs when `data/foil-masks/**` or `data/foil-canon/**` changed, and it can only comment on a branch in this repository. A fork's pull request gets the strip as a workflow artifact instead. |
| The evidence image does not render inline | `raw.githubusercontent.com` is only fetchable by GitHub's image proxy for a **public** repository. If foilkit ever goes private the strip is still on the `pr-evidence` branch and still a workflow artifact; only the inline render stops. |
| A mask save is refused mentioning a frame | The raster matches no record in `data/frames.json`. A stencil cut for a picture nobody can name is worse than no stencil; this gate is doing its job. |
