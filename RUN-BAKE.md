<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 Chey Rasmussen -->

# Running the bake

`foilkit.deckpal.app` has **no database at runtime**. Every question the site
asks — which series, which sets, which cards, which printings, which foil — is
answered by a file in `data/`. `tools/bake-catalog.mts` is where those files
come from, and it is the only thing in this repository that needs a catalog.

**This document is for you, the maintainer.** You have the database; the agent
that wrote the bake did not, which is why §"When it fails" exists and why you
should read it *before* the first run rather than after.

The bake is **not** part of `pnpm build`, on purpose. A build step that needs
production credentials is a build step that fails on every machine that does
not have them — including Vercel's.

---

## 0. Before the first run — no database needed

Prove the emitter, the shapes and the tests are healthy before you point
anything at Postgres.

```bash
cd /path/to/foilkit
pnpm --config.verify-deps-before-run=false test
```

Expect: `pass N`, `fail 0`. The bake's own tests are `tools/bake/*.test.ts`;
one of them runs the fixture bake for real and reads every file back.

```bash
node --conditions source tools/bake-fixture.mts --out /tmp/fixbake
```

Expect a synthetic bake — 2 series, 4 sets, 300 cards, 422 printings, 5 set
pages, 21 search buckets — written under `/tmp/fixbake`, plus the size report.
Everything in it is invented; the image URLs point at `fixture.invalid` and
every artifact stamps `source: "fixture:synthetic"` so it can never be mistaken
for the real thing.

---

## 1. Environment

The bake reads its connection from the environment, and falls back to `./.env`
if that file exists. Either is fine; a missing `.env` is **not** an error when
the variables are already exported.

| Variable | Where it comes from | Notes |
|---|---|---|
| `PGHOST` | the DeckPal Postgres you already use | |
| `PGPORT` | | defaults to `5432` |
| `PGUSER` | | a **read-only** role is enough and is what you should use |
| `PGPASSWORD` | | never printed by this tool |
| `PGDATABASE` | | |
| `DATABASE_URL` | *alternative to all of the above* | used only when `PGHOST` and `PGDATABASE` are both unset |
| `PG_HOST_PACKAGE` | optional | path to the `package.json` `pg` is borrowed from — see below |

The bake prints `PGHOST`, `PGDATABASE` and `PGUSER` so you can see what it
connected to. It never prints the password and never prints `DATABASE_URL`,
because a bake log is a thing people paste into chat.

If it can build no configuration at all it stops immediately, by name:

```
Error: bake-catalog: no database configuration.
  no .env (using the environment)
  Set PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE, or DATABASE_URL,
  either in the environment or in <root>/.env. See RUN-BAKE.md.
```

### `pg` is borrowed, not depended on

foilkit is a dataset with a renderer attached. It ships measurements *of*
printings, not a list of them, so it has no business depending on a Postgres
driver — and it does not. `pg` is `require`d at run time out of whichever
project supplies the catalog:

```
PG_HOST_PACKAGE   default: <foilkit>/../deckpal/apps/api/package.json
```

If your DeckPal checkout is the sibling directory of your foilkit checkout —
the usual layout — you do not have to set anything. If it is somewhere else,
point `PG_HOST_PACKAGE` at that project's `package.json`. The bake prints which
one it used.

### One connection

The bake opens **exactly one** Postgres connection for the whole job and closes
it before it writes a single byte. Three queries ride it: a column probe, the
series-and-sets query, and the printings query. `data/foil-pattern-cards.json`
and `data/foil-verification-map.json` are built from the rows *that same
connection* already fetched, which is why `tools/bake/pattern-cards.ts` exists
as an importable module rather than as a second script.

---

## 2. Dry run first — always

```bash
cd /path/to/foilkit
node --conditions source tools/bake-catalog.mts --dry-run
```

`--dry-run` does the entire job — connects, queries, assembles, serializes,
runs every assertion, measures every byte — and writes nothing. The byte
numbers it reports are the real serialized sizes, not estimates, so the size
report below is trustworthy from the dry run alone.

Working output looks like this (numbers from a real catalog will be much
larger; this is the shape, not the values):

```
bake-catalog: loaded ./.env; connecting — PGHOST=… PGDATABASE=… PGUSER=…
  pg resolved from /path/to/deckpal/apps/api/package.json
  probed seriesName         → ser.name
  probed seriesTcgdexId     → ser.tcgdex_id
  probed setReleasedOn      → cs.release_date
  probed setCardCountTotal  → cs.card_count_total
  probed cardImageLow       → c.image_url_low
  probed cardImageHigh      → c.image_url_high
  184 set row(s), 41471 printing row(s) over ONE connection

DRY RUN — nothing written. Would write into /path/to/foilkit/data
  12 series, 184 sets, 20500 cards, 41471 printings, 187 set page(s)
  resolverVersion 5, generatedAt 2026-09-01T…Z
  foil-pattern-cards.json — 31234/41471 printings assigned
  foil-verification-map.json — 148 rule group(s)
── search index size (measured, not estimated) ──────────────────────
  index.json               0.3 KB
  27 bucket file(s)      648.0 KB
  TOTAL                  648.3 KB raw / 190.1 KB gzipped
  largest bucket      's' — 2140 row(s), 68.0 KB raw / 20.1 KB gzipped
  per bucket:
    …
── catalog shards ───────────────────────────────────────────────────
  …
```

**Read the six `probed` lines.** Each one is a column name the bake was not
able to verify when it was written, resolved against your live schema. A
`NOT FOUND` is not fatal — the field is emitted as `null` — but it means the
site will be missing that value, so decide whether you care before you commit
the result. See "When it fails" below.

Warnings worth stopping for:

- `WARNING: N printing row(s) named a set the sets query did not return` — the
  two queries disagree about which sets exist. Those printings were dropped.
- `WARNING: N search row(s) whose setId does not round-trip out of the cardId` —
  search will derive the wrong set id for those cards. The rows still ship
  (a slightly wrong hit beats a missing card), and each is exampled.

---

## 3. The real run

```bash
node --conditions source tools/bake-catalog.mts
```

Writes into `<root>/data`:

```
data/catalog/index.json
data/catalog/series/<slug>.json
data/catalog/sets/<setId>.json          (page 1)
data/catalog/sets/<setId>.p<N>.json     (N ≥ 2, pageSize 250)
data/search/index.json
data/search/b/<bucket>.json
data/foil-pattern-cards.json
data/foil-verification-map.json
```

`--out <dir>` writes somewhere else, which is what you want if you would like
to diff a new bake against the committed one before replacing it:

```bash
node --conditions source tools/bake-catalog.mts --out /tmp/newbake
diff <(jq -S . data/catalog/index.json)     <(jq -S . /tmp/newbake/catalog/index.json)
```

(`generatedAt` will always differ. Everything else differing is the news.)

---

## 4. Reading the size report

The report is there so §2's partitioning decision can be revisited against a
number instead of a feeling. `docs/HOSTED-EDITOR.md` §2 estimates the whole
index at ≈700 KB raw / ≈200 KB gzipped at catalog scale; a measured
extrapolation over 20,500 cards puts it at **601–741 KB raw and 75–223 KB
gzipped**, the spread depending only on how compressible real card names turn
out to be. So the documented estimate is right, and the expected reading is a
few hundred KB.

- **Under ~2 MB raw / ~600 KB gzipped:** nothing to do. The a–z/0/`_` split is
  doing its job.
- **Over that:** revisit the partitioning. That is the point at which one
  bucket stops being a cheap first keystroke — the largest bucket is the number
  that actually matters, because it is what a user downloads when they type
  one letter. Split the fat buckets by second letter before you consider
  anything cleverer.

The `bytes` field of `data/search/index.json` carries the same two totals, so
the editor's staleness panel can show them without re-measuring.

---

## 5. Commit the artifacts

**This is a required step, not housekeeping.** Vercel builds from git. An
unbaked artifact is a **missing file**, not a stale one — the site will 404 on
it rather than serve yesterday's answer.

```bash
git add data/catalog data/search data/foil-pattern-cards.json data/foil-verification-map.json
git status --short          # confirm nothing else came along
git commit -m "Bake: catalog shards, search index, pattern cards, verification map"
```

`.gitignore` carries a re-include for the two foil artifacts
(`docs/HOSTED-EDITOR.md` §4). If `git status` does not show your new files,
that is the first place to look.

Before committing, sanity-check the header of one file:

```bash
jq '{version, generatedAt, source, resolverVersion, counts}' data/catalog/index.json
```

`source` must be `"catalog"`. If it says `fixture:` you are about to commit a
fixture bake over the real one — stop.

---

## 6. When to re-run

| Trigger | Why |
|---|---|
| **A DeckPal catalog sync** — a new set, a new printing, corrected names | the shards are a snapshot; new cards simply do not exist to the site until the bake runs |
| **A resolver change** — anything under `packages/resolver` or `packages/patterns` that changes an assignment | `foil-pattern-cards.json` and `foil-verification-map.json` are the resolver *inverted*; a resolver bump without a bake is a map that disagrees with what the renderer draws |
| **`RESOLVER_VERSION` bumped** | the editor compares the artifact's `resolverVersion` against the one the site was built with and shows a staleness banner when they differ. The banner is the design working; the fix is a bake |
| **A mask or window corpus change** | the verification map's leverage ranking is `printings ÷ (exemplars + 1)`; new human evidence changes the queue order |

Nothing here is time-based. There is no "the bake is a week old" problem — only
"the bake is older than a thing that changed".

---

## 7. When it fails — the `COLUMNS` block

**This is the failure this design predicts**, so read it first.

Every DeckPal column name the bake touches lives in one clearly-marked
`COLUMNS` block at the top of `tools/bake-catalog.mts`. Nothing else in the
file writes a column name into a query string. It is split three ways:

- **`verified`** — twelve names that appear in `tools/build-pattern-cards.mts`'s
  query, which has been run against the live schema and returned rows. Not
  guesses.
- **`probed`** — six names that could **not** be verified when the bake was
  written, because its author had no database access. Rather than guess once
  and die at run time, the bake asks `information_schema.columns` which of
  several candidate names actually exists, over the same one connection, before
  it selects anything. Each entry is a candidate list in preference order.
- **`derived`** — three values deliberately **not** selected at all: the card
  number, the variant display name and the variant tier. A derivation we own
  cannot fail on a schema guess. (The card number is additionally derived from
  the cardId suffix so that §2's search round-trip holds *by construction* —
  do not "fix" this by selecting a column.)

### Symptom → fix

**`error: column ser.xyz does not exist`** — a `verified` name was wrong after
all, or the schema moved. Fix the name in `COLUMNS.verified`. There is exactly
one place to edit.

**`probed <name> → NOT FOUND`** — none of the candidate names exists on that
table. The bake continues and emits `null` for that field. To fix it: find the
real column and add it to the front of that entry's `candidates` list.

```sql
-- what does the schema actually call it?
\d series
\d card_set
\d card
-- or:
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_name = 'card_set' ORDER BY ordinal_position;
```

The six probed fields and what they are for:

| Field | Table | Feeds |
|---|---|---|
| `seriesName` | `series` | `catalog/index.json` → `series[].name`, and the set shard header |
| `seriesTcgdexId` | `series` | `series[].tcgdexId`, and the derived image URL |
| `setReleasedOn` | `card_set` | `series/<slug>.json` → `releasedOn` |
| `setCardCountTotal` | `card_set` | `series/<slug>.json` → `cardCountTotal` |
| `cardImageLow` | `card` | `cards[].images.low` |
| `cardImageHigh` | `card` | `cards[].images.high` |

**`N card(s) had an image URL DERIVED from assets.tcgdex.net`** — DeckPal
stores no image URL column that the probe recognised, so the bake constructed
`https://assets.tcgdex.net/en/<seriesTcgdexId>/<setId>/<number>/{low,high}.webp`
from the pattern `docs/HOSTED-EDITOR.md` §5 documents. That is a real, working
URL shape, and the editor proxies it through `/api/image` anyway, so a miss
degrades to a blank thumbnail rather than a broken page. If DeckPal *does*
store URLs, add the column to `cardImageLow`/`cardImageHigh` and re-run — a
stored URL is always preferred over a derived one.

**`to_char(…) function does not exist` / a date cast error** — the release-date
column is a type the `::date` cast cannot take. Change the expression in the
sets query; the goal is a plain `YYYY-MM-DD` string or `null`, never a
timestamp with a zone in it.

### Other failure modes

**`Cannot find module 'pg'`** — `PG_HOST_PACKAGE` points at a `package.json`
whose project does not have `pg` installed. Run `pnpm install` in the DeckPal
checkout, or point the variable somewhere that does.

**`bake: set id 'x/y' contains a path separator`** — working as designed. A
shard name is a path, and a set id with a `/` in it would escape
`data/catalog/sets/`. A `.` is legal (`sv03.5`); a separator is not. Fix the
catalog.

**`… user-scoped field 'ownership' at …`** — the §6 guard fired. Something
user-scoped reached an artifact object. **Fix the query; do not widen the
guard.** These are public files on a CDN, and a leak here is a byte somebody
has already downloaded.

**`CONNECTION BUDGET VIOLATED`** — not something the shipped code can produce;
it is what the stub driver used in testing raises on a second `connect()`. If
you ever see it, someone added a second connection.
