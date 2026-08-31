**Deep dive.** The narrative companion to the mask corpus. When `docs/PROVENANCE.md` lands with the extraction it becomes the canonical specification; this page stays as the explanation of why each rule exists and what it is defending against.

# Provenance Model

foilkit's dataset is only worth what its provenance is worth. A corpus that
cannot tell you **who painted a given pixel** degrades silently: a generator
learns from its own unreviewed output, converges on its own mistakes, and every
number downstream still looks fine.

So the corpus records, for every artifact, how it came to exist — and it
*derives* that record from the artifact rather than accepting the caller's word
for it.

## The two rules everything else follows from

**1. Verification state is measured, never claimed.** The method label on a mask
is computed server-side by comparing the saved pixels against the pixels the
claimed starting point actually rasterizes to. A client cannot assert that a
human painted something.

**2. Machine output can never re-enter as evidence.** Unreviewed generated masks
carry an exemplar weight of exactly zero — not by configuration, not by a flag,
not at any corpus size. A generator that learns from its own output is grading
its own homework.

Everything below is machinery for those two sentences.

---

## Where the artifacts live

```
data/foil-masks/<cardId>/<variantId>.png             alpha = foil coverage
data/foil-masks/<cardId>/<variantId>.prior.png       the era RULE, rendered
data/foil-masks/<cardId>/<variantId>.diff.png        mask vs rule — green added, red removed
data/foil-masks/<cardId>/<variantId>.parent.png      the mask BEFORE this save
data/foil-masks/<cardId>/<variantId>.parent.diff.png what this save changed
data/foil-masks/<cardId>/<variantId>.json            the sidecar
data/foil-masks/<cardId>/superseded/<variantId>.<runId>/   verbatim undo archive
```

A mask is a **single alpha channel** saying where foil is. It is coverage data,
not a picture of a card — which is what lets the corpus be CC0 and ship publicly.
RGB in the PNG is display tint for the editor and carries no meaning.

One threshold governs everything: alpha at or above the midpoint counts as foil.

## The sidecar

Version 3. The fields that matter:

| Field | Meaning |
|---|---|
| `artworkKey` | **Equals the card id.** The identity rule, below |
| `derivation_method` | The honest label. Derived, never accepted |
| `authorship` | `human` / `machine` / `mixed` — **recomputed on read** |
| `reviewStatus` | `human-authored` / `human-adjusted` / `unreviewed` — **recomputed on read** |
| `artworkUrl` | Which scan the mask was drawn on. What a generator must consume |
| `card` | Set, series, name, number — so a generator lane can group by set with no database |
| `prior` | The starting point: source, era, scope, the deterministic rect, and optionally the hand-adjusted window and the generator identity |
| `diff` | **Rule versus mask** — added, removed, unchanged, and Jaccard agreement |
| `correction` | **Human versus parent.** Present only when a human edited a prior mask |
| `supersedes` | **Machine versus replaced.** Present only when a generator replaced something |
| `lineage` | Oldest to newest, this save last, capped |

`authorship` and `reviewStatus` being recomputed on every read is not an
optimisation — it means a hand-edited or stale sidecar **cannot claim a status
its method denies**. The derived fields have no independent existence.

`prior.rect` always carries the *deterministic era-rule* numbers even when a
hand-adjusted window was in effect, so the recorded agreement never stops scoring
the rule. That is what makes the corpus able to answer "is the rule getting
better?" years later.

Older sidecar generations are migrated **in memory on read**, permanently.
Nothing has to be rewritten, and an on-disk upgrade pass exists that is purely
additive — it never touches the PNG, the rule render, or the recorded numbers.

---

## `derivation_method` — five values, and their weights

| Method | Who painted it | Authorship | Review status | Exemplar weight |
|---|---|---|---|---|
| `layout-flatten` | Machine — a rect baked, no strokes | machine | human-adjusted | **0** |
| `hand` | Human, from geometry | human | human-authored | **1** |
| `hand-refined` | Human, on top of an existing non-AI mask | human | human-authored | **1** |
| `ai` | A generator; **no human has looked at it** | machine | unreviewed | **0** |
| `ai-corrected` | A generator proposed, a human then edited | mixed | human-authored | **0.6** |

The weights encode judgements worth spelling out:

- **`layout-flatten` is 0** because it teaches the generator only the rectangle
  it already has. It is not wrong; it is uninformative.
- **`ai` is 0** because unreviewed machine output is not evidence of anything
  except that the machine ran.
- **`ai-corrected` is 0.6, not 1**, because a human painted it but was
  *anchored* by what the machine proposed. It must not outrank an unanchored
  human mask.

`reviewStatus` drives the review queue and the editor's badge — an `unreviewed`
mask is shown with an explicit invitation: correct it and it becomes training
signal.

## How the method is derived

```
if nothing was painted        → keep the parent's honest label
if the parent was ai/…        → ai-corrected
if there was any parent       → hand-refined
otherwise                     → hand
```

"Was anything painted" is **measured**: the saved alpha is compared against the
alpha the claimed starting point rasterizes to.

### The antialiasing-seam rule

This is the subtle part, and the reason the whole thing works.

When the seed was an existing stored mask, both images came out of the same
rasterizer, so an exact comparison is correct — every differing pixel is a human
stroke.

When the seed was *geometry*, two different correct rasterizers are being
compared: the editor bakes a window with a canvas rounded-rect fill, the server
rasterizes the same rect from a signed-distance field. They legitimately disagree
in the one-pixel antialiasing band. Measured on a WOTC window at working
resolution: **389 pixels out of 330,260 cross the threshold differently, and all
389 sit in that band.**

So in the geometry case a pixel counts as painted only where **the seed is
unambiguous** — where its three-by-three neighbourhood is entirely foil or
entirely empty. A brush stroke always clears that bar. A rasterizer seam never
does.

Without this rule, every unpainted flatten would have stamped itself `hand` —
which is exactly the lie the provenance model exists to stop. It is locked by
tests that run in CI.

### Who may claim a machine label

Only a real generator, and only by supplying a full generator identity: name,
version, model id, run id, parameters, the exemplars it learned from, and a
confidence. HTTP callers cannot construct one. There is no path from the editor
to an `ai` label.

And a safety net in the other direction: **whatever a client claims, if the file
already on disk is `ai`, it *is* the parent.** Otherwise a client that forgot to
report the parent would silently launder a generated mask into `hand`, and the
correction signal — the most valuable thing in the corpus — would be lost.

A save with no parsable prior is rejected outright. A corpus entry that cannot be
diffed teaches nothing.

---

## Choosing exemplars

There is exactly one sanctioned way to pick training masks, and it records its
rejections:

1. Reject anything whose exemplar weight is zero, with the reason attached —
   *unreviewed machine output* or *machine-rasterized geometry*.
2. Reject anything from a different era.
3. Reject anything from a different scope. **A window mask must never teach a
   sheet mask.**
4. Sort survivors by weight, then recency.

It returns both the chosen and the rejected, each rejection carrying its reason,
so a selection is auditable in both directions.

Gathering exemplars by globbing the directory instead is the failure this
prevents, and it is an easy one to commit by accident. If a new selection path is
ever added, it routes through the same function — or the safeguard is a lie.

The same rule applies to refinement in the other direction: a refiner **refuses a
source whose exemplar weight is zero**, because a refiner that can eat its own
output will drift a boundary one pixel per pass, forever.

---

## `supersedes` versus `correction`

These are mirror images and they must never be read as one another.

| | `correction` | `supersedes` |
|---|---|---|
| What happened | **A human edited a prior mask** | **A generator replaced a mask that was already there** |
| What it means | Training signal — the supervised pair | A proposal awaiting review |
| Written when | A human painted over a parent | A machine write carried an explicit supersede |

They share a shape: the parent's identity and hash, a parent render, a change
map, added/removed/unchanged counts, Jaccard agreement, changed fraction, a
bounding box, and a coarse grid of per-cell change fractions.

A correction is the product, not a footnote — it is the only place the corpus
learns what the rule got wrong and where. Reading a supersede as a correction
would feed a generator's own reshaping back as though a human had endorsed it,
which is precisely what the exemplar weights exist to prevent.

### The invariant

**A machine write onto an existing mask throws unless it carries an explicit
supersede with a run id.** Silence used to mean overwrite, which is how human
work disappears. A human save can never carry a supersede at all — it is
machine-only by construction.

### What a supersede does on disk

Order matters and is deliberate: **archive first**, while the originals are still
there; then write the parent render and the change map; then the sidecar. A crash
between steps leaves the archive intact, which is the safe direction to fail.

The archive copies every artifact **verbatim** and records a hash per file, plus
a self-describing manifest. Self-describing on disk, not merely pointed at by the
sidecar — because once a human corrects a generated mask the live sidecar stops
being about the supersede, and the original must still be one command away.

Restoring verifies **the whole archive before deleting a single live file**, so a
corrupt archive can never turn "undo" into "lose both". It refuses to supersede a
half-record, and it refuses to restore an archive missing the mask itself rather
than deleting the live one.

---

## Aliasing — a mask belongs to a scan

The identity rule, in the owner's words: *the Machamp mask should be the same one
for all the ones of this Machamp, because they have the same picture.*

What the catalog actually proves is narrower and is what the rule rests on: **all
variants of one card render the same scan.** Imagery is keyed per card; the
variant table carries no imagery of its own. Hence the artwork key is the card
id.

**Mask aliasing is per `(cardId, scope)`.** An exact file wins. Failing that — and
only when a scope was supplied, never by guessing — a sibling variant's mask at
the same scope is used, newest first, and the response says which variant it came
from. A holo (window) and a reverse (sheet) of the same card must **never** share
a mask.

**Window geometry aliases per card and is scope-agnostic**, because the art box
is a property of the scan and a sheet is the same box inverted. Saving geometry
identical to the era rule *deletes* the file rather than storing a no-op.

Where it deliberately does not alias:

- **Across card ids.** Different cards reprinting the same illustration — Base
  Set 2, promo reprints — cannot be *proven* identical from the catalog. There is
  no illustration key; illustrator plus name is a heuristic, and perceptual
  hashing is similarity rather than identity. Cross-card reuse is a human
  decision, never automatic.
- **Sidecars too old to carry a prior.** No guessing.
- **On save.** Saving while viewing an aliased mask writes a **new file under the
  current variant** — provenance stays with the variant it was actually drawn on.

Counting follows from this, and getting it wrong inflates coverage several times
over: **mask coverage counts per `(cardId, scope)`**, window coverage per
`cardId`, pattern assignment per printing.

---

## How a claim gets verified

Two different bars, for two different kinds of claim.

### Pattern claims — judged renders against reference footage

A deterministic tilt sweep is rendered on a **real catalog scan** — no silent
substitutions; every judged result names the exact card rendered — and scored
against the reference corpus on four dimensions: static appearance, tilt motion,
layer character, colour travel. A match requires **every** dimension to clear the
bar. The verdict is machine-validated for schema and internal consistency, not
merely read.

Five things learned the hard way, and they generalise well beyond this project:

- **The owner's eye is ground truth.** A mechanism built from someone's *words*
  can still fail their *eye*, and the eye wins. Two mechanisms were overturned
  this way after being built from the very notes that requested them.
- **Judge noise is measured, not assumed** — several points per roll on provably
  identical renders. Before believing any regression, confirm the render actually
  changed.
- **Pixel proof beats a consistent verdict — but only for internal claims.**
  Several "completely static" judgements were pixel-refuted; still-frame motion
  blindness has five data points. Pixel-verify first, then flag for a live look.
- **External ground truth outranks an internal proof.** The canonical failure: a
  correct external report of a mirrored slope was dismissed three times by a
  geometry proof. The proof was sound and proved the wrong thing — that the render
  matched the code comment, not that the name matched reality. An
  internal-consistency proof can never clear a claim about the mapping to
  reality.
- **A claim that survives re-rolls is signal.** The "hallucination" label has to
  be re-earned against ground truth each time, or it becomes a self-sealing
  dismissal.

### Mask claims — state the bar before you see the numbers

The evaluation takes the bar as an **input** and prints a verdict. The shipped
default is a mean leave-one-out intersection-over-union at or above 0.90 with no
held-out card below 0.85.

Two standing corollaries:

- **Boundary distance, edge adherence and vector-ness never promote a class.**
  They describe precision; the overlap metric is what gates. A flawless vector
  boundary in the wrong place is still wrong.
- **Run adherence with a probe the generator did not optimise against.**

The measured state at extraction: the modern reverse-holo sheet class **passes**
comfortably, well above the rule-only baseline. The WOTC window class **fails**,
and the entire error is the subject silhouette — the same gap the rectangle-based
era layout cannot express. That is an honest recorded failure, not a rounding
problem, and it is the corpus's most valuable open work item.

---

## Related

- [Foil Taxonomy](Foil-Taxonomy) — what a pattern assignment is asserting
- [Shader Contract](Shader-Contract) — the mask tiers as the renderer consumes them
- [Pre-History](Pre-History) — the commits in which these rules were argued out

_Last updated by Claude Fable 5 on behalf of @cheyras — 2026-08-31_
