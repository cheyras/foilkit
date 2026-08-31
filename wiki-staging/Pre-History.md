**Snapshot, and a copy.** This page reproduces the foilkit-relevant subset of DeckPal's [`Foil-Branch-Log`](https://github.com/cheyras/deckpal/wiki/Foil-Branch-Log). It is a **copy, never a move** — DeckPal keeps the full archive permanently, and it is the authoritative one.

# foilkit — Pre-History

foilkit did not start here. Every pattern recipe, the shader contract, the mask
pipeline and the provenance model were developed between 2026-08-01 and
2026-08-09 inside [DeckPal](https://github.com/cheyras/deckpal), on eight
parallel `foil/*` branches that were never merged into its `main`.

Those branches are being deleted. Their *files* came here with the extraction;
their *commit messages* did not, and that is where most of the reasoning lives —
the measurements, the refusals, the things that were tried and did not work.
This page is that writing.

## What this page is, and what it is not

**It is a subset.** DeckPal's `Foil-Branch-Log` carries **465 commits and 76,291
words** across all eight branches, including the DeckPal-side housekeeping and
every rebase of every branch. This page carries the foil work: the shader, the
pattern taxonomy, the mask pipeline and the corpus.

**It is deduplicated.** The eight branches were independently rebased lines of
the same work, so a single piece of work appears up to eight times in the source
archive with a different SHA each time. Of the 262 commits reproduced in full
there, **36 are distinct**; 29 of those appear on all eight branches. This
page carries each once, with the SHA from the branch it was taken from and a note
of how many branches carried it.

**Its SHAs do not resolve anywhere public.** They are identifiers into the
offline mirror `deckpal-mirror-2026-08-31.git`, taken before any deletion.
DeckPal's page records every branch's pre-deletion tip SHA alongside them. Do not
treat them as links.

**Sole author throughout:** `cheyras <cheyras@gmail.com>`. That is the fact
[`RELICENSE.md`](https://github.com/cheyras/foilkit/blob/main/RELICENSE.md) rests
on, and it is why relicensing this work MIT/CC0 needed nobody's permission.

## How to read it

Chronological, oldest first. The `R0`–`R7` prefixes are the verification rounds —
each one a render sweep judged against the video-reference corpus, then re-judged
against the owner's eye, which outranked it. Reading them in order is the fastest
way to understand why the shader looks the way it does, because most of them are
records of a mechanism being *overturned*.

Three things recur and are worth watching for:

- **A refusal is a result.** Several of the most useful entries record something
  measured and then declined — a rule seed that closed zero of the gap, an onset
  ramp abandoned after three attempts, a metallic treatment rolled back to
  mirror-only after it flattened every other pattern's colour.
- **The eye outranks the proof.** R3's diagonal-sheen swap is the canonical case:
  an internally sound geometry proof dismissed a correct external report three
  times, because it proved render-matches-comment rather than
  slug-matches-reality.
- **Machine output is never evidence.** The exemplar-weight rule and the
  supersede archive both exist because a generator that learns from its own
  unreviewed output converges on its own mistakes.

---

## Commits

### `db82e3f` — 2026-08-01 — foil/main: workbench v1 — three.js viewer, 5-pattern starter library, era layout masks

Quarantined foil workbench at /pokedex/foil-lab (URL-only, linked from
nowhere, chrome-free): real owned-card scans from the image cache, tilt via
pointer/gyro(iOS permission)/manual with reduced-motion respected, uniform
sliders, pattern + mask-scope overrides, mask overlay toggle, copy-recipe
JSON. Pattern library v1 tuned against owned eras (Base/WOTC, SV, Mega
Evolution): Starlight, Cosmos, SV default holo, SV reverse sheet, Cracked
Ice — uniform contract (core + uP0..3) designed for the full 15-20 set.
Era layout spec as data (era-layouts.json, rects measured on real scans);
resolver v1 (series, rarity, variant kind) -> pattern + mask scope.
SKILL.md x2 (foil-effects, mask-pipeline stub). main.tsx gains a dev-only
double-createRoot guard (Vite HMR entry-invalidation footgun, see DECISIONS).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MY2totBB6u2Z3sjFdPy8bn

### `e3dc8be` — 2026-08-01 — foil/main v2: Pencil mask editing, comment queue, iPad two-column, branch api

Apple-Pencil hand-mask drawing on the workbench (MaskEditor: card-aligned
canvas overlay, pen+mouse default w/ finger toggle, pressure brush, eraser,
12-step undo, touch-action none, starts from layout prior); masks persist as
committed ground-truth artifacts data/foil-masks/<card>/<variant>.png+json
(derivation_method hand) via the env-gated branch api (POKEDEX_FOIL_LAB=1,
port 3712, PGPOOL_MAX=1 — inert in prod), auto-load and beat the layout tier
(uMaskTex contract; CanvasTexture flipY=false, exactly one V flip). Comment
button captures card/variant/pattern/scope/mask state + all slider values to
issues/foil/<id>/ (report.md + context.json), out of the fix-issues sweep.
Era-grouped owned-card picker (WOTC / SWSH / SV+ME headings); two-column
layout (viewer | controls) from 700px — verified at 390px, 744x1133,
1133x744, 1440x900 with simulated pen strokes. SKILL.md x2 updated.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MY2totBB6u2Z3sjFdPy8bn

### `44e79fb` — 2026-08-02 — foil: fix diffuse darkening — scan sampled sRGB-decoded but never re-encoded (issue ls9u0y)

The face texture was uploaded SRGB8_ALPHA8 (hardware sRGB->linear decode at
sample time) while the foil ShaderMaterial writes gl_FragColor raw — three.js
only appends the linear->sRGB colorspace_fragment chunk to built-in materials —
so every scan rendered in linear values displayed as sRGB (measured flat
184->123 / 199->147, exactly the sRGB->linear curve). Sample the scan undecoded
(NoColorSpace): the compositing model is authored in display space and
pattern=none at rest is now pixel-comparable to the flat view (mean abs luma
diff 44.55 -> 2.16, mapping identity +/-2). Also zero pattern-none's default
specular so the baseline is truly the plain scan.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

### `4548fca` — 2026-08-02 — foil: any-card picker — full-catalog browse/search, Owned-only as a toggle

Chey: pull up ANY card in the catalog and tilt it, owned or not. Picker now
browses the whole catalog by era -> set (paged strip, promo sets run 300+),
adds full-catalog name search, and keeps Owned-only as a filter toggle
(default on = prior behavior). Zero new endpoints: existing /series,
/series/:slug, /sets/:setId (paged), /search, /cards/:cardId serve it all;
unowned cards list their catalog variants (quantity 0) and resolve the same
base-guess pattern path. Selection is never clobbered by filters; unmapped
series get an honest "Other eras" bucket. Verified on unowned neo2-13
Umbreon (Auto - Starlight WOTC) at 390px + both iPad viewports.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MY2totBB6u2Z3sjFdPy8bn

### `50906c4` — 2026-08-02 — foil: cited per-card pattern assignments across the whole catalog (resolver v3)

Chey's mlmwmp comment: the library was funneling to era defaults ("cosmos").
Full-catalog enumeration (20,964 cards / 37,627 variants, via the branch read
api) + an 18-lane Ringer research swarm (foil-card-assignments, GLM-5.2,
executed selector-integrity checks) produced:

- research/foil-card-assignments.json — 111 set/rarity/kind/card-level rows,
  19 catalog foil-facet mappings (holo-foil-cosmos, reverse-foil-masterball,
  normal-foil-galaxy...), 55 honest residuals; per-lane provenance + method.
- tools/foil/build-assignments-index.mjs -> apps/web/src/foil/assignments-index.json
  (trimmed for the bundle, duplicate-facet guard).
- resolver v3 (RESOLVER_VERSION=3): assignment tier above the v2 usage table;
  specificity cardIds > variantKinds > facet > rarities > set > v2 > heuristic;
  normal-kind variants with a declared foil facet now render window foil
  (previously scope none); FoilLab passes cardId.
- era-layouts: wotc seriesSlugs 'ecard' -> 'e-card', + 'legendary-collection'
  (both had fallen through to modern-sv rects and heuristics).

Coverage (foil-bearing variants): 79.5% set-cited / 20.4% era-token / 0.2%
heuristic -> 93.4% set / 4.3% facet-or-card / 2.4% era-token / 0 heuristic.
13 in-browser spot-checks in ~/.pokedex-dev-hub-legacy/foil-shots/assignments/.
Issue mlmwmp resolved. Weak spots + curation ledger in DECISIONS.md.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

### `55415d2` — 2026-08-02 — foil R2 stage 3: thirteen dedicated recipes (gap patterns + RC dots) + subset-commons resolver tier

- patterns.ts: real recipes for mirror, rainbow-mirror, vertical-sheen-rainbow
  (dark-mirror family on uDarken), pokeball-hologram, prism, water-web,
  energy-symbols, pinwheel, ex-emerald, tinsel, cosmos-ii-pixel, crosshatch,
  radiant-collection-dots — implemented: true, approx labels dropped, slugs
  stable. Unused plain SHEEN_V generator removed (last fallback users gone).
- resolver v4: card-level 'normal'-class assignment rows consulted before the
  scope-none early return — subset cards the catalog declares plain but which
  physically carry foil (RC commons dot overprint) resolve their subset's
  pattern with scope full.
- foil-card-assignments.json: two card-level rows (bw11-RC1..20, g1 25
  non-ultra RC ids) with video citation (non-holo RC Teddiursa keeps the dot
  overprint); builder enforces cardIds on 'normal' rows; index regenerated.

Verified in-browser: g1-RC1 + bw11-RC1 render the RC dot treatment via Auto
(guess card|medium). Gemini verdicts in research/foil-verification.md (R2
recipe-wave section, next commit).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

### `77b6646` — 2026-08-02 — foil R1: dedicated recipes for the twelve owned-era gap patterns (10/12 verified)

Chey's comment dml369 ("develop out the rest of the missing holofoil patterns"):
dedicated GLSL for fireworks, ace-spec, energy-symbols-ii, rainbow-glitter-sheen,
ex-starfoil, prismatic-pokeball, tinsel-ii, cosmos-iii-smooth, pokeball-masterball,
radiant, rainbow-glitter, confetti — implemented flags flipped, approx labels
dropped, slugs stable. Gemini-verified 10/12 match over 3 rounds (verdict table +
honest residuals in research/foil-verification.md R1 section). Honest nays:
tinsel-ii (procedural static plateaus at judge score 2) and prismatic-pokeball
(screen-only blend cannot darken a white reverse body — structural, Chey's call).

R0 residuals cleared in the same pass: cracked-ice anisotropic shattered-glass
metric (re-judged yay 14/20); starlight milky wash + per-layer visibility curves
with starlight-ii re-banked clean 20/20 through both shared-GLSL changes;
starlight parallax judged from a new 16-frame fine sweep and still scored flat —
verified real by eye, recorded as judge-blindness.

Field notes appended to foil-effects SKILL.md; dated DECISIONS entry; issue
dml369 resolved.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

### `798ed3d` — 2026-08-02 — foil R2b: four §40–43 vocabulary recipes (all match) + resolver v5 scope overrides

The last lane of the wave — dedicated recipes for the vocab-extension types:
gold-secret (warm-locked goldRamp field + chromatic glitter pops + SWSH burst
rays — 19/20 yay), vstar-pearl (near-white pearl on uDarken 0.3, warm-led
diagonal wash, frame-line streaks — 13/20 yay), shiny-vault (silvery field +
band-keyed sparkle-glyph amplifiers, uDarken 0.15 — 11 nay → 16/20 yay r2),
detective-pikachu (diagonal sheen × photo-luminance via the documented uFace
contract exception — 20/20 yay). 38/43 taxonomy types real, 34 hold match.

Resolver v5: assignment rows carry an optional per-row scope override (window/
full/sheet), honored by the set-row tier and the cls-'normal' tier — baby
shinies render window despite the 'Shiny rare' full-foil rarity, VSTARs full
despite plain holo kinds, det1 window despite 'ultra rare'.

Assignment research: +2 facet rows (gold, gold-jumbo → gold-secret; retires
both facet residuals, 1-card metal collateral flagged) and +10 cited rows —
sma 51 baby/35 GX/8 gold splits, swsh4.5sv 104 baby + 18 full-face (incl. the
black shiny Eternatus pair, name-verified not gold), sv04.5 rarity split,
VSTAR via the dedicated 'Holo Rare VSTAR' rarity, det1 ultra-rare + cls-normal
rows (all 18 cards window). Residuals annotated with resolutions.

build-usage-index.mjs: tolerate era-wide rows with no scope.sets (the vocab
gold rows crashed the build — the 122-row usage index never compiled until
now). Verdicts/frames under ~/.pokedex-dev-hub-legacy/foil-verify/ (verify-<p>-r2b*);
shots in foil-shots/r2b/. Docs: foil-verification.md R2b section, SKILL R2b
field notes, DECISIONS entry.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

### `7f2a101` — 2026-08-02 — foil R2: uDarken blend-model term — prismatic-pokeball 17/20 yay, tinsel-ii 16/20 yay

One opt-in substrate-darkening term in the shared composite (main()):
body = scan * (1 - uDarken * mask * gate) before the foil screen-blends.
Default 0 is bit-identical to the old render; absent canon/override keys
seed 0. Full 21-pattern regression sweep on provably identical renders:
no true regressions (and a measurement of Gemini single-roll noise, ±3-6;
diag-right + pokeball-masterball double-nays recorded as unstable
verdicts on geometry proof). prismatic-pokeball rebuilt on the term
(dark-mirror base, facet-quantized flash lobe, ball watermark as
ink-overprint suppression): structural nay -> 17/20 yay. tinsel-ii
one-line opt-in (uDarken 0.4): static plateau -> 16/20 yay. 20 of 21
implemented types now match; sole nay starlight (judge parallax
blindness).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

### `861404e` — 2026-08-02 — foil: workbench split — canon pattern lab (A) | card adjustment surface (B)

Chey's comment issues/foil/2026-08-02_12-59-52-368_4aq756 (resolved here):

- /pokedex/foil-lab/canon (CanonLab.tsx): bare holofoil pattern on a blank
  card (no ink; black/dark/silver/white flat-tone base via the normal texture
  path) beside the REAL reference tilt clip + 8 keyframes streamed from
  research/foil-video-reference/ by new env-gated dev routes (byte-range via
  res.sendFile for iOS Safari). Full 39-slug picker, sliders, tilt, and
  Save canon -> data/foil-canon/<patternId>.json (full uniform snapshot that
  replaces recipe code defaults as the baseline).
- /pokedex/foil-lab (FoilLab.tsx reframed): per-card masks/comments unchanged,
  plus per-card uniform overrides saved as a SPARSE diff vs the canon
  baseline -> data/foil-overrides/<cardId>/<variantId>.json (untouched
  uniforms keep tracking canon). Off-canon sliders get a dot; saving with
  sliders matching canon deletes the override.
- Layering model in foil/canon.ts (code defaults < canon < override < live);
  shared atoms + surface tabs in foil/ui.tsx; routes wired in main.tsx;
  AppShell chrome-free check widened to /foil-lab/*; both data dirs
  re-included in .gitignore; ports 5184/3713 recorded in ORCHESTRATION.md.

Verified in-browser at 390x844 / 744x1133 / 1133x744 (clip playing beside the
bare cosmos render; Machamp base1-8 hand mask still resolves) — shots in
~/.pokedex-dev-hub-legacy/foil-shots/canon-lab/. Typecheck + build green (web, api).
patterns.ts untouched (R0 re-tunes concurrently).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

### `9bdf318` — 2026-08-02 — foil R0: rounds 2-3 re-tunes + verification report, field notes, decisions

starlight: longer thin-armed 4-point glyphs + 8-point-burst subset, tighter
pop lobe (pow 11, floor .04), full-saturation star color, parallax default
2.4, gain 3.6 — best of 3 rounds 11/20 (still-frame judging cannot see the
parallax; recorded as honest residual with a video-judge recommendation).
starlight-ii: 20/20 (uP2 pinned so base-default drift can't invalidate it).
cracked-ice: facet gain 1.1 -> 0.55 (art visible through flashes), density
10, less whitening — 15/20 yay; shard-geometry uniformity queued for R1.
Verification report gains the R0 section (before->after per pattern, the
diag-left judge-noise event, diffuse-fix supersession note); foil-effects
SKILL.md gains the R0 field notes; DECISIONS entry for root cause + wave.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

### `b98e8f5` — 2026-08-02 — foil: sidecar v2 (prior+diff), artwork-keyed masks, comment linkage, codify ritual

- Every hand-mask save records its starting prior (era/scope/resolver rect +
  RESOLVER_VERSION) and the api renders <v>.prior.png + <v>.diff.png (green =
  human added, red = removed) + Jaccard agreement, server-side via a pure-JS
  PNG codec (no native addons). Saves without a parsable prior 400.
- Machamp mask backfilled (deterministic prior wotc/window/v1): agreement
  0.6409 — his correction is the subject silhouette, the rule's first lesson.
- Artwork keying: variants of one cardId provably share one scan, so mask GETs
  alias to a sibling variant's mask when prior.scope matches (X-Foil-Mask-
  Alias-Of). Cross-card reprints unprovable from the catalog -> per-card only.
- Comments auto-link the exact saved mask state (maskFile/maskSavedAt/
  maskAliasOf/maskHasPriorDiff).
- mask-pipeline SKILL: sidecar v2 storage, identity rule + limits, and the
  codify ritual; first worked example data/foil-masks/codified/wotc.md (n=1:
  WOTC window = art-window rect minus subject silhouette; noted in
  era-layouts.json wotc.notes).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MY2totBB6u2Z3sjFdPy8bn

### `dc8e2f8` — 2026-08-02 — foil: taxonomy integration — all 39 pattern types in the app, cited resolver

Mislabel corrections from the video-reference research, applied to apps/
(research docs untouched):
- sv-holo renamed vertical-sheen (it always rendered the HGSS-XY vertical
  bands, not SV's). PATTERN_ALIASES keeps old slugs resolving forever —
  sidecars, comment context.json, Copy-recipe JSON never orphan.
- Sheen family = ONE generator at four rotations + stripe option: five honest
  implemented slugs (vertical / horizontal=TRUE SV default "Mirage" /
  diagonal right "/" / diagonal left "\" / striped "Line").
- Cosmos label drops "/ Galaxy" (Galaxy is a starlight synonym; synonym moved
  to the starlight entry). reverse-sheet description notes it ≈
  pokeball-masterball stamped sheet.
- Vintage narrowed: starlight = Base/Jungle/Fossil only; Base Set 2 → Call of
  Legends holos = cosmos.

Pattern dropdown carries the FULL 39-slug vocabulary, grouped: implemented
recipes first, then every gap type rendering via its nearest recipe and
labeled "approx via ..." (amber note in the UI). Unimplemented != hidden.

Resolver v2: base guess reads the cited usage table (usage-index.json,
derived from research/foil-pattern-usage.json by
tools/foil/build-usage-index.mjs; set-name match -> era/series token match ->
era-default heuristics). The winning row's confidence + citation hosts
surface in the workbench ("Guess: set-level citation, high confidence
(bulbapedia..., collexy...)"). Reverse rows citing 'mirror' are deprioritized
per the research known-gap (ink-design evidence, not foil-pattern evidence).
RESOLVER_VERSION -> 2 (scope semantics unchanged from v1).

Verified: typecheck + build green; Playwright at 390/744x1133/1133x744
(~/.pokedex-dev-hub-legacy/foil-shots/w2/) — Machamp auto=starlight set-level-high
with his hand mask still resolving, SV holo auto=horizontal-sheen,
SV reverse auto=energy-symbols-ii, fireworks approx labeling.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MY2totBB6u2Z3sjFdPy8bn

### `eabb72a` — 2026-08-02 — foil R0: re-tune implemented recipes per Gemini verification notes

cosmos: full activation-model rewrite — dark field, smaller/denser orbs
mostly near-invisible, cluster pops via low-freq noise over cell ids,
pinprick 4-point twinkles (was: dense wall of large saturated orbs).
starlight (+ starlight-ii via shared GLSL): parallax architecture untouched;
tighter visibility lobe (pow 5->9, floor .18->.08), sharper glyph cores +
narrower flares, smaller blobs, saturated star color, galaxy wash halved;
starlight-ii art gate lowered for the mid-orange Evolutions field.
cracked-ice: authored intra-shard grain removed per Chey's accuracy ruling —
facets flash as solid smooth planes; whitening at peak reduced, uSat up.
sheen family: generator grows sharp/beam/barcode options. vertical-sheen ->
new barcode variant (thin spectral lines of varying width, CD-groove slide)
with tamed beam + art gate. diagonals: sharp 3.0, beam 0.55, specular 0.35
(center blow-out), diagonal-sheen-right uP0 2->7 (same-sheet consistency).
striped-vertical-sheen: stripes finer + more blended (90->130, floor .40).
horizontal-sheen: untouched (20/20).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

### `3bc5fe2` — 2026-08-03 — foil R4-COMPOSITE: the ink-density invariant — foil adds pop, never washes text or mutes ink

Chey's two me05 comments (7rtnzx mirror reverse "blows out the darks/text",
19mo4l holo "darkens/muddies the colors") ruled a CORE COMPOSITE INVARIANT,
engineered in shader.ts main(): ink density estimated from the scan
(inkDark = darker-than-local-8-tap-field average, exactly 0 on flat blank
bases; inkColor = chroma above the canon-lab-tone floor) now gates every
layer — dark ink blocks the flash + shields the specular (text crisp at
every tilt), ALL ink is exempt from uDarken substrate attenuation (printed
color never muted; the mirror stays dark only where the mirror is visible),
colored ink auto-tints its flash (max(uTint, inkColor)) and uInkPop pumps
chroma under the flash so colors read MORE saturated and metallic.

New core uniforms uInkGuard (default 1) / uInkPop (default 0.5), both 0 =
bit-exact legacy composite; sliders in both labs; canon files untouched
(absent keys inherit the new defaults — catalog-wide fix, zero migrations).

Proof: canon-lab blank-card pairs (mirror dark+silver, cosmos,
horizontal-sheen) pixel-identical (compare -metric AE 0) under a
frame-stepped rAF harness with a same-settings AE-0 control, plus a Gemini
sanity pass (all pairs "identical"). On-card before/after pairs across the
8-card sample (both issue cards, Victini, Pineco, Darkrai, Cetitan, Machamp
WOTC, Hydreigon SIR; 3 tilts, 390px + desktop) in
~/.pokedex-dev-hub-legacy/foil-shots/r4-composite/. Both issues resolved with
mechanism-mapped notes; composite contract documented in the foil-effects
SKILL; DECISIONS + research/foil-verification.md updated.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

### `73be25c` — 2026-08-03 — foil R3-MISC: the uTint ink-metallic blend term + Chey's twelve remaining canon-lab comments (12/12 yay)

The reverse-holo fix (his chat report): screen-blending achromatic foil light
over colored art compresses chroma — "dull and grayish, rather than making the
color look metallic." New core uniform uTint (default 0 = bit-exact legacy)
multiplies the foil layer + in-mask specular by the luminance-normalized scan
chroma SQUARED (the double ink pass of a real mirror reflection); neutral on
blank cards, so no canon-lab appearance moved. Reverse-family recipes opt in;
verified before/after at 5 tilt angles on Victini ball-reverse, Crystal Energy,
Pineco. uP4/uP5 param slots added in the same contract change.

The twelve comments, each mechanism-mapped in its issue frontmatter and the
verification doc: cracked-ice triangulated + half-off gate; fireworks grid
lattice + center-emanating radial hue; rainbow-mirror rebuilt as mirror +
hue-banded spotlight; tinsel-ii silver lines + vertical rainbow band (band
lives only on the line-work); prism rebuilt as pinwheel-kin from the
corpus-vs-corpus delta pass; cosmos-ii pixel-quantized stamp edges; crosshatch
thinned; gold-secret adjustable burst origin (uP4/uP5, center default,
per-card via overrides) + holographic grain; dedicated recipes for sequin
(glyph-family glints), tcg-classic (flat starlight + rainbow glitter),
acid-wash (water-web kin), disco (perfect disc lattice, galaxy ignition) —
zero approxVia fallbacks remain.

Canon migrations (appearance-preserving unless he asked otherwise): fireworks
uP0 3→4.5 (dead two-octave structure), gold-secret uP4/uP5 0.5 added, sequin
uP0-uP3 re-keyed to the new recipe. Verdicts: research/foil-verification.md
"R3-MISC" — 12/12 Gemini yay incl. the tcg-classic ink-scope re-roll.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

### `9223975` — 2026-08-03 — foil R3-MOTION: axis-split starlight, per-dot cosmos, hologram radiant, the rainbow-glitter-sheen delta

Chey's six motion-model canon-lab comments resolved (his eye = ground truth):

- starlight (+ starlight-ii via shared GLSL): top-to-bottom hue BANDING
  (soft-quantized bands; his canon 0.62/0.6 lands the reference order
  blue->green->red on the R->B->G cosine ramp) + AXIS-SPLIT tilt: vertical
  slides the whole field (~10% card height), horizontal drives the per-star
  random fade; his 3-layer uP1 parallax rides on top untouched.
  Judge: starlight 17/20 yay round 2 — the FIRST starlight yay (standing
  parallax nay broken); starlight-ii 20/20.
- cosmos: whole-field slide + per-dot random response (independent random
  tilt axes for brightness and hue per orb — no shared sweep axis); at
  tilt 0 his canon appearance is pixel-identical. Judge: 20/20.
- radiant: discrete hologram steps (half-cell up/down, 60% hold / 40%
  crossfade — one position fades out as the next fades in), uP1 wired as
  Hologram travel (canon migrated 0 -> 2.2; was an unused placeholder),
  grid lines ~45% thicker. Judge nay 13/20 across 3 rounds on a
  pixel-refuted "slides continuously" claim — recorded as still-frame
  motion blindness (same class as starlight parallax); adjacent-frame
  crops prove discrete positions + crossfade. Chey's live tilt is the
  tiebreak.
- rainbow-glitter-sheen: dedicated Gemini delta-articulation pass first
  (he couldn't name the difference), pixel-verified, then fixed: narrow
  laser-saturated striped chevron (sigma 0.010->0.0035, hue traversal
  5x->9x, pow-deepened at low gain), fainter +-0.8 repeats, chevron angle
  1.3->1.9, denser colored always-visible glitter, uDarken 0->0.4 (4th
  legibility-physics data point). Judge: 19/20 yay.

Docs: research/foil-verification.md R3-MOTION section, DECISIONS entry,
foil-effects SKILL field notes. Frames/verdicts in
~/.pokedex-dev-hub-legacy/foil-verify (jobs *-r3m*, manifest-r3m{,2,3},
delta-rainbow-glitter-sheen); gate shots in foil-shots/r3-motion.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

### `b3c4770` — 2026-08-03 — foil mask-refine: window handles → flatten → hand refine

Chey's requested workflow on the Card-adjust surface: draggable
corner/edge handles adjust the layout window rect per card
(WindowEditor.tsx, 44px touch targets, finger-drag allowed), the
adjusted geometry persists as artwork-keyed scope-agnostic sidecars
(data/foil-windows/<cardId>/<variantId>.json, /foil-lab/windows routes),
and Flatten bakes it through the STANDARD hand-mask save path (sidecar
prior stays the era rule; new optional prior.window records the
adjustment) then opens the existing paint tooling.

- rasterizeWindowRect shared by Flatten + loadLayoutRect (identical bakes)
- saveMask prior = layoutMask (rule), never the effective mask
- windows GET aliases across variants of the same scan, newest savedAt
- verified in-browser desktop + 390px: sma-SV1/sma-SV2 (SM baby shiny,
  borrowed modern-sv rect) and me01-034 (zero-coverage gap); base1-8 +
  base1-5 hand-mask regression clean; test artifacts deleted (corpus rule)
- ports: vite 5186 / api 3714 recorded in ORCHESTRATION.md

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

### `b8c3b4f` — 2026-08-03 — foil R3: sheen-family streak-field rework — all 8 of Chey's canon-lab comments resolved, 7/7 Gemini 20/20

sheenGlsl is now a streak field (Chey's critique = the spec): sparse irregular
streaks, per-streak lean following card tilt (crisscross; converging pairs
terminate where they meet), stretched-ellipse taper, hue running ALONG each
strip as well as across. striped-vertical-sheen rebuilt from a fresh Gemini
corpus re-spec run with Chey's description embedded (grouped reveal via wide
sweeping windows over a subtle bottom-converging fan; gemini-spec-r3.md);
ex-starfoil rebased on the reworked diagonal base + fine CD-line layer;
vstar-pearl rebuilt from the horizontal-sheen streak field, pearl kept.

Canon migrations (full-snapshot rule, DECISIONS): striped + horizontal uDarken
0 -> 0.32 (bright-substrate legibility, third confirmation). All other canon
values carry over; uniform semantics unchanged. validate_spec.py frame regex
single-digit fix (undercounted two-digit citations, failed an honest worker).

Verdicts (Chey's words folded into every judge prompt as acceptance criteria):
vertical/right/left/vstar-pearl 20/20 first roll; striped + ex-starfoil 20/20
round 2; horizontal 20/20 round 3. Table + residuals in
research/foil-verification.md R3.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

### `d547992` — 2026-08-03 — foil R3-GLYPH: glyph-pattern reworks per Chey's 7 comments + the drop-in glyph slot for his SVGs

Behavior (his notes verbatim = acceptance criteria): reverse-sheet rainbow
only on grainy glyphs over a neutral sheet; energy-symbols checkerboard
banks that swap with tilt; energy-symbols-ii sporadic random banks (~half
faint at any time); ace-spec diamonds grow/shrink with tilt + a touch of
blur; prismatic-pokeball ball never darkens (white-mixed pale response +
coherent plane flash, suppression deleted); radiant-collection-dots shapes
catch a traveling rainbow band (16/20 YAY — standing R2 nay broken).

Glyph slot: research/foil-glyphs/<slug>/glyph[-N].svg -> lab-gated api
routes -> atlas rasterizer (foil/glyphs.ts) -> uGlyphTex contract +
glyphTex() helper; ~2.5s auto-pickup on save, procedural fallback when
absent, README tells Chey exactly where his four promised files go.

Canon migration: reverse-sheet uP1 0 -> 0.6 (dead placeholder now drives
his requested glyph grain). Verdicts + pixel-refutations recorded in
research/foil-verification.md (R3-GLYPH); lessons in foil-effects SKILL.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

### `07eb483` — 2026-08-04 — foil R4b: scan-additive composite (rest parity by construction) + canon-lab card preview

Chey's Grubbin (me05-002, Pitch Black) review refuted R4's ink heuristics:
the reverse still muddied the card at rest (measured ΔC +32, green→yellow),
darkened the header under tilt (−22 L), and blew out text (glyph contrast
−26%). New law on real scans (uScanBase 1): the scan is a photograph of the
card at rest — foil is additive dynamic light only, tilt-gated to ZERO at
rest, luminance-headroom + per-channel clamped (text sacred at every angle,
uArtGate opens the clamp where dark scan pixels ARE the foil), chroma-
preserving with a pastel-safe tint ramp and an L²-gated chroma pump. Canon
lab blank bases run the classic composite textually unchanged: AE-0 proven
(CDP frame-stepped harness, control + knob pairs; Gemini pass agreed).
uInkGuard 0 still reproduces the pre-R4 composite exactly.

Canon-lab card preview (his request verbatim): blank/on-card/↻-another chips
render the live sliders on a random catalog card the resolver assigns the
pattern to — server-sampled from the baked inversion (tools/foil/
build-pattern-cards.mts → data/foil-pattern-cards.json, gitignored;
GET /foil-lab/pattern-cards/:patternId), honoring hand masks + adjusted
windows; empty-pool patterns say "no catalog cards". Also commits Chey's
live mirror-canon tweak from the Grubbin session. Full metrics + verdicts:
DECISIONS 2026-08-04.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

### `176cfe8` — 2026-08-04 — foil R4c: onset ease — the sheen leans in instead of switching on

Chey on R4b's rest gate: "it's like it isn't there at all until I've
tilted the card a tiny bit and then it's like it just suddenly appears."
Measured: the headroom clamp saturated R4b's smoothstep(.02,.28) gate, so
ALL added light arrived inside tilt 0.03-0.13 (0 -> 16.1 dL mean) then
froze flat to tilt 1.0 — a step smeared over 4% of the tilt range.

Now: one wide ease ramp = smoothstep(0, .45, |tilt|) (full at 0.45 —
every R4b tilt-0.5 metric unchanged), flash gated by ramp^1.5 (cubic-slow
start), specular by ramp^2.5 (the broad gloss band now trails the flash
instead of leading it), plus a REST=0.006 sub-JND living rest sheen
blended into both gates (rest +0.43 dL card-mean, max 2/255 — visually
still the scan). After-curve: smooth S over 0->0.25, no dead zone, no
knee; text clamp untouched (glyph contrast 33.6 -> 33.6 at flash peak);
blank-card canon lab bit-level unchanged (fuzz-1% AE 0 vs control floor).

Harness + curves + filmstrips: ~/.pokedex-dev-hub-legacy/foil-shots/r4c/.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

### `d8a8562` — 2026-08-04 — foil R4d: motion-first onset — tiny gestures move the sheen; glow arrives late; Chey gets the dials

Chey rejected R4c too ('It still lights up pretty noticeably when I tilt
the card a tiny bit. I don't like it.') — measured the gesture→tilt
mapping first this time: pointer is 0.0051 tilt/px at 390px and gyro is
0.036 tilt/deg, so a 30px thumb drag (tilt 0.154) was already getting
HALF the full glow under R4c. The curve was never the felt variable.

- shader.ts: onset gates now uniform-driven — uOnsetRange (glow full at
  |tilt|, default 0.5) and uOnsetCurve (flash exponent, default 3.5;
  specular trails at +1). (0.45, 1.5) reproduces R4c exactly (verified
  to the third decimal); defaults are strictly softer at every tilt and
  equal from 0.5 up, so all R4b/R4c peak metrics are unchanged
  (Grubbin 17.976 ΔL / text 34.02, Machamp 18.035 / text 45.6 — exact).
- FoilLab + CanonLab: 'Onset range' / 'Onset curve' sliders, canon-
  stored like every other uniform; absent canon keys inherit defaults.
- patterns.ts: CoreDefaults admits the two keys per recipe.

Pointer-path proof (real pointermove, 390px, 30px drag, first 300ms):
before mean ΔL climbs to 6.6 and rising; after stays within ±0.08 while
per-pixel movement reaches 6.1 mean / 18.9 p95 — moves, doesn't light
up. Blank canon lab at fuzz-1% AE 0 vs control. Artifacts in
~/.pokedex-dev-hub-legacy/foil-shots/r4d/.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

### `6b865c8` — 2026-08-05 — foil R5: the metallic composite — always on the card, energy redistributed, Chey's compositing dials

Chey's ruling (2026-08-05, verbatim in DECISIONS): no onset range at all —
the effect is ALWAYS on the card; dial in how it composites onto the ink;
metallic and spectral, not brightening.

- Onset machinery removed (R4c/R4d ramp, REST floor, uOnsetRange/uOnsetCurve
  sliders on both surfaces). No canon/override file ever stored the keys;
  CardViewer skips unknown uniforms, so stale keys anywhere are inert.
- R5 metalness law (scan path only): scan = albedo; the pattern field splits
  around PIVOT 0.40 — above = tinted-specular highlight, below = bounded
  multiplicative depth (mirror-turned-away darks, sqrt-concave). Energy
  redistributes; contrast + chroma carry the metallic read.
- Soft-knee headroom: the R4b hard clamp plateaued strong fields into a flat
  wash (the "brightened" read); the budget now compresses monotonically so
  pattern structure survives. Per-channel no-clip caps stay hard; glyph ink
  (inkDark) exempt from highlight AND depth — text contrast preserved
  (Grubbin 86->97 at peak, Machamp flat).
- New canon-stored dials on both surfaces: Metallic 0.6, Sheen strength 0.55,
  Sheen tint 0.5 (= the R4 chroma law exactly), Depth 0.55, Texture 1.
  uMetal 0 / uIntensity 0 / uInkGuard 0 all still yield the plain scan.
- Blank canon lab pixel-unchanged: CDP frame-stepped before/after AE 0 at
  fuzz 1% (mirror/cosmos/horizontal-sheen/starlight, tilted + rest); one
  Gemini vision pass agrees (all pairs identical). Shots + per-card rest
  pairs: ~/.pokedex-dev-hub-legacy/foil-shots/r5/.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

### `2baaf7e` — 2026-08-07 — foil R6: composite defaults re-derived from Chey's canons; the guard learns to tell text from artwork

Chey: "i re-adjusted cracked-ice. take a look at it, and then make the changes
based on everything you're observing to make all of this better - i want it so
that i have to do as little of work personally on all the rest as possible."

WHAT HIS CANONS TAUGHT

  uSheenTint  0 on all three non-mirror canons -> 0 for every non-mirror family
              (was 0.15/0.5/0.85/0.6). Ink-tinting a pattern's own highlight is
              exactly "it adds no rainbow color or anything to the card".
  uSheen      he raised all three -> families now 1.2-4.2 (were 1.0-2.6).
  uDepth      NOT universal: 0 on cracked-ice, 1 on tinsel-ii and rgs. It
              darkens the card WHERE THE PATTERN IS NOT, so its cost scales
              with 1 - duty. Measured every recipe's duty cycle; his three
              choices line up with it, and it predicted both dials for the only
              canon that exercises the defaults.
  uSat 1 + wide spread -> shipped on the 13 recipes with no canon.

Families are renamed for how light LANDS (flash / line / stamp / field / pearl
/ metal) and stated explicitly as FoilPattern.family. The stamp tier exists
because the first pass got it wrong: energy-symbols-ii lights 5.8% of the face,
so a field substrate darkened the other 94% and the card read "someone dimmed
this".

THE INK GUARD: SPLIT, DON'T WEAKEN

inkDark is a local-contrast measure, so it fired on every dark mark - including
every outline and shading edge in the ILLUSTRATION (measured: 86-89% of strong
hits inside the art window are artwork, not text). The additive law spends it as
a hard coverage multiply, so guard 1 punched the pattern full of holes. That is
why he kept pulling it to ~0.51/0.56 on sheet/wash patterns.

Now split by `glyphness` into inkGlyph (sacred, zero flash, unchanged) and
inkDetail (artwork darks keep the pattern on a tightened budget). `inkAny` is
byte-for-byte the old inkDark and every pre-R6 consumer still reads it.

Success test met: at guard 1 under R6, tinsel-ii and rgs look BETTER than his
0.51/0.56 do today - tinsel-ii's artwork is visible through the streaks instead
of greyed out. Both canons migrated to 1, reason recorded in each file's note;
every other value in them is his, untouched.

SLIDER RANGES (his second ask)

Four dials sat exactly on their cap: uIntensity 2->4, uSheen 3->6, uSat 1->2,
uHueSpread 1.5->3. Not extended: uInkGuard (his carve-out), uMetal (a law
selector), the 0..1 mix weights, and uDarken/uDepth (already fully spent at 1).

uSheen needed a shader change to be honest: the additive budget's ceiling was
reached at uSheen 2.0, so the top third of the slider bought almost nothing -
very likely why he parked two canons at the ceiling. It now resumes climbing
above 3, leaving every stored value <= 3 bit-for-bit identical.

The 19 duplicated <Slider> lines across the two surfaces are one CORE_SLIDERS
table; uGrain is dimmed and labelled "metal law only" where it does nothing.

NEW: "Apply composite -> family" copies only the on-card dials to siblings,
never pattern shape.

PROVEN, NOT ASSUMED (AE vs a base build compiled from the previous commit)
  - blank canon room: AE 0 across all 44 implemented recipes x 4 tones x 3 tilts
  - mirror: AE 0 on the card path too - pixel-frozen
  - text at flash peak: +0.1 to -1.1 points of glyph/paper contrast on every
    reverse whose foil covers the text box; the library's two largest costs
    (rainbow-glitter, water-web) toned down per-recipe and re-checked by eye
  - every implemented recipe eyeballed on 1-2 real assigned cards at rest and
    two tilts; shots in ~/.pokedex-dev-hub-legacy/foil-shots/r6/

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

### `8458ab1` — 2026-08-07 — foil R5b: metalness is MIRROR ONLY — every other pattern gets its own colour back

Chey: "You applied the metallic treatment to EVERY HOLO PATTERN when I only
wanted it for mirror. So now, every single holo pattern looks like mirror and
you can barely see the pattern at all, it's like every single one is being
applied in a way that it adds no rainbow color or anything to the card."

R5 shipped its metalness dials as GLOBAL_DEFAULTS, so all 43 recipes inherited
a law built for one of them. uMetal is now the scan-path LAW SELECTOR and
defaults to 0 — nothing can inherit metalness; mirror is the only recipe that
opts in, in its own patterns.ts defaults.

- Metalness branch is the R5 code textually unmoved, so mirror's arithmetic is
  unchanged by construction. Proven: his hand-tuned canon on Grubbin me05-002
  + Tropius me05-001, rest + tilt 0.2/0.35/0.5, 390px and desktop —
  16/16 frames AE 0 at fuzz 1%, same floor as the same-build control pair.
- uMetal 0 runs the ADDITIVE law: the pattern's own emission (uSheen gain)
  screen-combined per channel over a substrate-attenuated body, tinted toward
  the ink only as far as uSheenTint asks. Three fixes to what R5 broke — the
  scalar no-clip cap let the artwork's brightest channel throttle the whole
  flash; the quartic ink budget (shaped to starve mid-dark glyphs) starved
  ordinary mid-tone art instead; PIVOT ate the field before anything flashed.
  Cosmos measured 0.005% of art-window pixels changed >8% under R5.
- uDepth decoupled from uDarken: uDarken is the blank-canon substrate, frozen
  by 30 saved canon files, and 0 on exactly the pale reverse sheets that need
  one. The substrate follows the pattern's dark half so it buys contrast, not
  a uniform dim (a flat 0.34 cost mean dL -21.7 and 29% of text contrast).
- Per-recipe families in patterns.ts (PARTICLE / SHEET / WASH / PEARL) plus
  seven by-eye corrections, each judged on a card the resolver assigns.
- Onset machinery stays deleted. Text guarantee re-verified: glyphs matte and
  crisp at peak tilt on a reverse whose foil covers the text box.
- Blank-card canon appearance unchanged: 8 patterns AE 0 (6 direct; cracked-ice
  and tinsel-ii against the pre-R5b code with canon held constant, since Chey
  re-saved those two mid-wave).
- SKILL.md composite contract rewritten around per-recipe selection.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

### `92f52aa` — 2026-08-07 — Mask provenance: sidecar v3, the AI learning loop, and the collapse safeguard

Chey (2026-08-07): mark AI-generated masks, let an AI learn from his hand-done
ones, then let him correct the AI's mask so it "can observe the diff and continue
to improve without me having to hand-paint all the masks."

`derivation_method` existed in v2 but the API HARDCODED it to 'hand' — harmless
while only a Pencil touched the corpus, actively wrong once mask-refine's Flatten
started writing machine geometry through the same save path.

Taxonomy (5 values, 4 cases that must never blur):
  layout-flatten  machine geometry, unpainted   weight 0
  hand            human, from a layout prior    weight 1
  hand-refined    human, on an existing mask    weight 1
  ai              generator, UNREVIEWED         weight 0
  ai-corrected    AI proposed, human edited     weight 0.6

The label is never taken from the client. The client reports only what the canvas
was SEEDED with; writeMaskRecord derives the method by diffing saved pixels
against what that seed rasterizes to. A machine label needs a full
GeneratorIdentity, which HTTP callers cannot supply. One write path serves the
route and generators both.

- Anti-feedback-collapse enforced in selectExemplars(), not by convention:
  unreviewed `ai` is weight 0 at any corpus size. Codify now routes through it.
- Corrections keep the parent PNG + change map + metrics (incl. a 4x4 grid of
  where corrections land) — the supervised pairs a generator lane consumes via
  the self-describing tuples manifest.
- Seam rule, measured not guessed: canvas roundRect vs the server SDF disagree on
  389/330260 px, ALL in the 1px AA band. Without tolerating it every unpainted
  Flatten would stamp `hand`.
- Guard: if the file at the target path is an unreviewed `ai` mask it IS the
  parent, whatever the client claims — AI ancestry cannot be laundered. That
  guard caught a real bug during this build (ActionBtn passed React's MouseEvent
  into saveMask's optional arg, blanking `derivation`); `derivation` is now
  required on the PUT so it fails loudly instead.
- v1/v2 load forever (normalize-on-read); Chey's two masks migrated additively
  and still read HAND-PAINTED, agreement 0.641, pixels untouched.
- Trial batch `wotc-window-trial-1`: 6 WOTC Base holo rares from window-artgate@1,
  all ai/unreviewed, reversible. Leave-one-out on the human corpus beat the rect
  baseline (0.588 -> 0.688) — real, but n=2 same-set, so explicitly not validation.

Surfaces: provenance badge + detail in the workbench, Mask corpus panel,
GET /foil-lab/masks/corpus (+?tuples/?exemplars), artifact routes, and
corpus.ts report|exemplars|tuples|migrate. Pure tests added to CI (test:foil).
Browser-verified at 390px and desktop. See DECISIONS.md 2026-08-07 and the
mask-pipeline SKILL.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

### `116427d` — 2026-08-08 — Mask editor: pan + pinch-zoom that keeps the strokes honest, and no more "selected" card

Chey, before a batch of hand masks: "something that would be nice is to be able to
pan and pinch to zoom while editing masks. In addition, sometimes the card image gets
'selected' when I'm trying to draw which is annoying."

Zoom is a camera view offset, not a CSS scale. camera.setViewOffset(W*z, H*z, x, y, W, H)
re-rasterizes the card at the zoomed size, so 4x zoom is 4x real detail — the point of
zooming is tracing a printed edge, and a magnified 390px framebuffer would not help. The
overlays get the same transform on one wrapper div, written imperatively (no re-render per
frame). Because that is a pure crop of a linearly-scaled render, u lands at u*z - offset in
both places, so getBoundingClientRect already reports the truth and the pointer->texel math
is unchanged. Verified numerically: a 3.375x corner stroke lands at texels [84,180,108,196]
vs a predicted [85,180,109,196]; touch at 3x lands within one texel at 390 and 744.

Brush is constant in SCREEN px (lineWidth = brushSize / zoom): zooming in must buy finer
control, not a fatter-looking stroke. Two fingers pinch/pan; one finger pans unless it is a
drawing finger or on a window handle; a pen owns the surface (palm rejection); a second
finger mid-stroke aborts AND rolls the stroke back. Desktop gets wheel/trackpad zoom at the
cursor, middle- or Space-drag pan, and +/-/0. HUD shows the zoom and fits back in one tap.
Pan is clamped so the card cannot be lost. Zoom is live only while editing, resets on exit,
and never reaches the artifact — a mask saved at 3.375x round-trips as 490x674 with an
identical bbox. WindowEditor divides drag deltas by zoom and counter-scales its handles, so
they stay 44px on screen (44.0 -> 44.0 measured at 2.25x).

Selection fix: user-select/touch-callout/user-drag none, draggable=false, and preventDefault
on dragstart/selectstart and the paint pointerdown across both canvases and the viewer
column; touch-action stays none so the two fixes do not fight. iOS also needs the
gesturestart/change/end veto — touch-action alone does not stop Safari page zoom.

Cost the most time: window listeners registered in the controller factory were killed by
StrictMode's simulated unmount, so the first pinch started and never ended and every later
gesture and stroke was dead. They are now a symmetric attach()/detach() pair driven by an
effect. See DECISIONS.md.

44/44 browser checks at 1280 / 744 / 390 (touch via CDP), his committed masks still load,
scratch card artifacts removed. Shots in ~/.pokedex-dev-hub-legacy/foil-shots/mask-ux/.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

### `15af7c5` — 2026-08-08 — foil vector-template: make the emitted path actually analytic (two real bugs)

Writing the round-trip test found two things the IoU table was hiding.

1. JOINS WERE RAW CONTOUR POINTS. vectorizeLoop fitted lines, axis-snapped them,
   and then took each run's endpoint straight off the sampled contour, only
   substituting an intersection for line/line corners. So the emitted "vertical"
   left edge of a rounded rect ran from x=25.00 to x=25.66 — a polyline through
   contour samples with arcs bridging them, wearing a vector's clothes. The
   straightness this lane exists to deliver was measured but not emitted. Joins
   are now the actual intersection of the two primitives that meet there
   (line/line, line/arc, arc/arc all solved), with joinMaxMovePx rejecting a
   join that lands far from where the contour really turned.

2. ARC SWEEP WAS INVERTED. `cross < 0 ? 1 : 0` — with y down, a positive cross
   product is a clockwise turn on screen and sweep=1 is clockwise, so every
   fitted arc bulged the wrong way. Round-trip IoU on a rounded rect: 0.9482
   before, 0.9994 after. It only cost ~0.5% on the real template because that
   template is 56 lines and 2 arcs, which is exactly why a synthetic test found
   it and the corpus numbers did not.

Template refitted. Nothing moved much, because the bugs were small in this
geometry — but the artifact now says what it means:
  in-sample mean IoU 0.9908 -> 0.9911
  vector-ness prim/kpx      region-learn@1 33.72 | HIS 21.35 | mine 10.34
  long-primitive fraction   0.9047 | 0.9679 | 0.9861
  axis-aligned fraction     0.7875 | 0.8554 | 0.9321
  correction margin: closer to what he drew than to what he rejected on all 10.

test:foil 56/56.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

### `3f72b07` — 2026-08-08 — foil: rule-seeding measured and refused — the era rect is the bug, not the tracer

Chey: "Use it on the next 5 reverse holofoils in the same set."

The five: me05-002/37186, -003/37188, -005/37191, -006/37193, -007/37195 — every
me05 card after 001 with a REVERSE variant, in collector order. me05-004 (and 008,
016) skipped: Double rare ex, holo-only, no reverse variant.

STEP 3 CONTROL, on Tropius where his hand mask is ground truth: a rule seed scores
IoU 0.7084 against his intent, and edge-trace takes it to 0.7080 — it closed ZERO of
the gap. corridorPx 5/12/24/48 give byte-identical output (the corridor is not the
knob; anchorSnapPx is, and widening it to 20 makes the boundary hop between the
card's two parallel border edges and run off the card). 99.7% of the 70,520px gap is
REGIONS the rule over-claims — the silver border ring, the window-top band, the
species strip, the BASIC tag — and edge-trace crisps boundaries, never regions.

THE REAL BUG: modern-sv.artWindow.h = 0.315 puts the art window's top edge at y=106.
The printed edge is at y=65 on all six me05 cards measured. Chey's hand adjustment
(0.3749) lands within 1.1px on all six. Not changed here — era-wide blast radius, his
call. Every SV/Mega holo and reverse currently renders 41px of foil error.

The batch ran, all five failed identically (traced window top y=106 vs printed y=65),
and was REVERTED. Nothing shipped; the corpus is byte-identical to before.

Also found: adherence measures precision, not correctness — a rule line inside an
illustration finds edges to sit on and scores 38.9→84.7% while being 41px wrong.
Two tests now lock that. And modern-sv/sheet has ZERO eligible exemplars while the
edgetrace-tropius-1 proposal sits on his ai-corrected mask.

Kept (the capability is sound, the seeding is not):
  --seed rule       era rectangle as a refiner's source for unmasked cards; records
                    exemplars: [], halves confidence, notes open "RULE-SEEDED"
  --param k=v       per-run generator overrides, merged into the RECORDED params
  --dump <dir>      dry-run proposal + seed PNGs + report.json, for real review shots
  seed-neutral report wording in edge-trace ("the source boundary", "as given")
  revert bugfix     it left empty card dirs behind, so undo was not byte-for-byte

typecheck all workspaces clean, api+web builds green, test:foil 39/39 (4 new).
Visuals: ~/.pokedex-dev-hub-legacy/foil-shots/mask-edgetrace-batch/

---

### `6b61213` — 2026-08-08 — foil mask-straighten: read the INTENT out of Chey's hand mask, and make the undo real

Chey, 2026-08-08: "it's impossible to get the lines really straight so I'm hoping
you can get computer vision on the mask and card art in tandem to really see my
intent there, and make the mask nice and crisp and straight on the lines I was
trying to draw along. Will you try that? And then I can either approve or revert."

Smoothing a wobbly boundary gives a smoothly wobbly boundary. The premise here is
that a hand-drawn foil boundary is an ATTEMPT TO TRACE A PRINTED EDGE — frame, art
box, species strip, stage tag — and those are dead straight in the scan. So:
contour the mask, cut each loop into near-axis runs (PCA orientation, wobble gaps
bridged), robust-fit each, hunt the scan's directional gradient with a local Hough
over (angle, offset) plus a proximity prior, replace, intersect adjacent lines into
real corners, rasterize matching his own AA character.

The refusals are the feature, and each is a recorded param: weak evidence, or an
ambiguous band of comparable ridges, may nudge but never relocate; with no artwork
edge it straightens only to HIS own fit; short and curved runs pass through
untouched. A first cut "closed" the Tropius top-left corner — which turned out to
be him deliberately tracing around the BASIC stage tag. The stricter rules keep it.

- apps/api/src/foil/line-snap.ts     the geometry, pure, no I/O
- generator.ts                       `line-snap@1`, a REFINER (requiresSource)
- generate-masks.ts                  `run --refine`, `archives`, restoring `revert`
- provenance.ts                      `supersedes` + verbatim sha256 undo archive

A generator write onto an existing mask now THROWS without explicit
supersede { runId }; with it, every artifact the mask had is archived verbatim under
superseded/<variantId>.<runId>/ with a self-describing manifest, and `revert
--run-id` verifies the whole archive BEFORE deleting anything live, then restores
byte-for-byte. `supersedes` is deliberately NOT `correction`: one is a human
editing a machine (training signal), the other a machine replacing a human with
nobody's agreement. `--refine` also refuses a source with exemplar weight 0, so a
refiner can never eat its own unreviewed output.

Tropius me05-001/37184 (run straighten-tropius-1): 8 runs snapped to printed edges,
1 self-straightened, 13 left exactly as drawn, 8 corners closed, 2 specks dropped.
Max correction 3.74px, 1.06% of the face changed, Jaccard 0.9798, confidence 0.557.
Honest residual: the card's bottom border was too faint to accept, so that run
self-straightened and the report says so.

test:foil 25/25 (9 geometry + 5 supersede/restore, incl. byte-for-byte round trip,
a deliberate curve surviving, an ambiguous band refused, and a corrupt archive
aborting before deletion). Revert exercised twice end to end, sha256sum clean.
Shots: ~/.pokedex-dev-hub-legacy/foil-shots/mask-straighten/.

Undo: pnpm --filter pokedex-api exec tsx src/foil/generate-masks.ts revert --run-id straighten-tropius-1

### `782c096` — 2026-08-08 — foil vector-template@1: the layout is the artifact, and it is analytic geometry

Chey: "what I draw is intent... generated masks should feel like they're derived
from clean vectors" — and "we don't need 3,454 vector masks, all of these share
the same 2 layouts really."

Mined his 8 correction diffs first. They say the regions were nearly right (0.12%
to 2.23% changed) and that the errors were structural, not stylistic:
  - the coloured sliver pinched off between the evolution medallion and the border
    ring IS foil (he added it on all 4 Stage-1 cards). This was the open question
    flagged in codified/modern-sv.md as "Chey has never ruled on that sliver".
    It is ruled on now.
  - achromatic marks printed ON the coloured field carry foil: the colourless
    energy symbols, the retreat symbols, the regulation-mark box, the name text.
    region-learn@1 carved holes around all of them; he filled every one.
  - the left/right window edge sat on the bevel's INNER line; he moved it out.
  - and, decisively for this lane: where the print is straight, HIS line is
    straighter than region-learn@1's traced one. The machine was the thing that
    wobbled, so a smoother tracer was never the fix.

Geometry, measured over his 11 masks: 50.05% of the face is foil on ALL of them,
47.18% bare on all, 2.77% contested — and the Basic-vs-Stage1 difference is a
SINGLE 70x85 blob. So it is not 2 layouts, it is one layout plus one optional
element, which the fitter discovers from the corpus itself (bimodal split, 80.5pp
separation) rather than being told a medallion exists.

vector-template@1 fits lines + circular arcs + exact corners to the consensus of
his masks and rasterises that. 58 primitives, 13.2 KB of committed JSON, applied
at render time — instead of 3,454 rasters.

Leave-one-out vs the bar committed in a14a163 BEFORE any number existed
(mean >= 0.94, none below 0.90): mean 0.9904, worst 0.9838. PASS. region-learn@1
on the same 11: 0.9757 / 0.9519. Boundary p95 1px on 10 of 11 (was 2-72px).

Vector-ness at 0.35px tolerance on SUB-PIXEL contours (measuring on traceLoops is
a trap — crack following returns a rectilinear staircase and rates a hand blob as
perfectly axis-aligned):
  primitives/kpx   region-learn@1 33.7   HIS 21.3   vector-template@1 10.7
This is the finding: his hand masks are ALREADY more vector-like than the
generator that was supposed to be learning from them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

### `82b502c` — 2026-08-08 — foil edge-trace: the artwork holds the geometry, his mask says which of it to follow

Chey, after reviewing line-snap: "Really just 'straighten' isn't quite enough,
really just detecting edges and actually tracing accurately around them is the
real move." So the premise moves. line-snap treats his strokes as the geometry
and nudges near-axis runs onto printed lines. edge-trace treats his mask as a
STATEMENT OF INTENT and derives the boundary from the card's own edges.

apps/api/src/foil/edge-trace.ts (pure, no I/O):
  Di Zenzo colour structure tensor (Scharr per channel) -> NMS -> hysteresis;
  colour because a green field against a silver border reads 0.13 luminance/px
  and 44.3 tensor/px at the same edge. Then livewire: a corridor around his
  boundary (a hard bound, not a suggestion), anchors at fixed spacing PLUS every
  hard turn in his own line, Dijkstra on ridge + linked + proximity^2 +
  direction, sub-pixel refinement onto the |dI/dn| peak, and only THEN a
  straight fit where the traced path really is straight.

His own correction said the same thing before he did: 114 of his 627 correction
px sit in one 40x50 box around the species strip's swept tail, which line-snap
had squared off by intersecting two lines across it.

Two traps, both now locked by tests:
  - the MAD-trim trap: a robust fit discards a small feature as an outlier,
    reports "straight to 0.2px RMS", and crisping then flattens what it ignored.
    straightMaxDevPx requires every point in a run to be close.
  - the half-pixel frame: mask space centres pixels at x+0.5, a gradient array
    at integer x. All artwork lookups convert in one place.

Measured, not asserted. `generate-masks.ts adherence` scores any set of masks by
distance to the NEAREST printed edge maximum, with line-snap's own luminance
Sobel as the default probe so the incumbent gets the home field:
  his hand mask 50.7% within 1px / 0.847px mean
  line-snap@1   74.8% / 0.545px
  his correction 75.4% / 0.548px
  edge-trace@1  77.1% / 0.199px      (colour probe: 98.4% / 0.082px)

Applied to Tropius me05-001/37184 as run edgetrace-tropius-1, ai/unreviewed,
his ai-corrected mask preserved as parent + verbatim supersede archive. Revert
proven byte-identical twice before shipping.

test:foil 35/35 (10 new). Typecheck all workspaces, api+mcp+web builds green.
Visuals in ~/.pokedex-dev-hub-legacy/foil-shots/mask-edgetrace/.

Undo: pnpm --filter pokedex-api exec tsx src/foil/generate-masks.ts revert --run-id edgetrace-tropius-1

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

### `9127416` — 2026-08-08 — foil region-learn: the REGIONS come from his masks, the geometry from the artwork

The last lane measured why rule-seeded edge-trace failed on every me05 reverse:
99.7% of the gap between the layout rule and Chey's intent is REGION decisions,
and a tracer can only move a boundary, never add or remove a region. This is the
missing half.

region-learn@1 partitions a card face into five structural classes computed from
its OWN printing (border / furniture / frameBody / windowBackground /
windowSubject), reads off his masks WHICH of them carry foil, applies that to a
new card, and only then hands the boundary to edge-trace. Nothing about Pokemon
is hard-coded — the same code reads OPPOSITE policies from the two classes in the
corpus, and a test asserts the votes, not just the verdict.

The policy, in his pixels:
  modern-sv/sheet  foil = the COLOURED FRAME BODY, nothing else. Species strip
                   (tails included), stage tag, evolution medallion + its sprite,
                   "evolves from" bar, copyright footer: all excluded. And THE
                   SILVER BORDER RING IS NOT FOIL — 0.2/0.2/0.4% across his three
                   masks. That was flagged as "his call, not a measurement"; it is
                   now a measurement, and unanimous.
  wotc/window      foil = the illustration's own background, minus the subject
                   silhouette, minus the stage box where it overlaps. 4/4.

Bar written down before any number existed: mean IoU >= 0.90, no held-out card
below 0.85. Leave-one-out:
  modern-sv/sheet  0.7566 -> 0.9691 (worst 0.9519)  PASS -> batch of 8 shipped
  wotc/window      0.6146 -> 0.8971 (worst 0.8599)  FAIL by 0.0029 -> no batch

The two residuals differ in kind, and that is the finding: modern-sv's is a 1-2px
registration hairline; wotc's is 8,343px of Machamp's body read as background
because his blue-grey sits inside the colour distance of the teal holo field.
Every frame-level decision on WOTC is right. The subject silhouette is not.

Also found and NOT changed (era-wide, his call): wotc.artWindow is 11px too high
at the top and 6px too wide at the right — his four masks and each card's own
printed edge agree, and base1-8 is the card the era was "measured on". Same
pattern as me04-007 for modern-sv.

Also: the bevel side. An illustration box has TWO parallel printed edges; which
one the foil stops at is which side the foil is on, not which is strongest.
Picking the strongest put base1-6's window top 8px wrong and scored it 0.0001;
picking the foil side took it to 0.8789.

Batch regionlearn-me05-1 (8 cards, 5 frame colours, 4 with medallions, all ai /
unreviewed) applied and proven reversible byte-for-byte — including a revert bug
fixed here: it left the empty card directory behind, so a reverted card still
looked masked to anything that walks data/foil-masks.

Recommend reverting wotc-window-trial-1: those five base1 masks were made by
window-artgate@1, which scores 0.7694 mean / 0.7330 worst on this same test.

test:foil 46/46 (11 new, including the anti-collapse rule locked three ways).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

### `bb2765c` — 2026-08-08 — foil: serve the template as a mask, and write down what his corrections ruled

API: GET /foil-lab/masks/:cardId/:variantId?era=&scope=&evolves=1 now falls back
to the vector template when no hand mask resolves. A hand mask ALWAYS answers
first, so this cannot shadow Chey's work — it only fills what used to 404 — and
it is labelled X-Foil-Mask-Review-Status: unreviewed with the generator identity,
run id and exemplar count.

The cache is TWO PNGs, not 3,454. A template's rasterisation depends only on
(era, scope, hasOptionalElement, w, h) and not on the card, so every Basic
reverse gets byte-identical pixels. ~17 KB each under
IMAGE_CACHE_ROOT/foil-templates/, mirroring the image-cache contract: disk-only,
outside git, safe to delete, rebuilds in milliseconds. Committing per-card masks
would have been ~100-350 MB against the template's 13.3 KB.

`evolves` is an INPUT, not something the route detects, for two structural
reasons: these routes have no DB and the server never shells out, so the process
can neither read card.stage nor decode card art. The caller already knows. This
turned out to be the right call for a second reason — the artwork probe agrees
with the catalog on 89.3% of Pokemon but misfires on pale frames (it called
sv09-120 Dunsparce, a Basic, "medallion present" at 0.0% chroma).

codified/modern-sv.md pass 2 (n=11) records the three rulings his corrections
make, with numbers:
  - THE SLIVER IS FOIL. Pass 1 flagged it as "Chey has never ruled on that
    sliver". region-learn@1 scored 0.0% there on all four Stage-1 cards; he added
    it on all four. "Largest coloured component" was the wrong rule; the right one
    is every coloured region that reaches the border ring. The medallion's own
    sprite stays out because it is fully enclosed — topology, not size.
  - Achromatic ink printed ON the coloured field carries foil: colourless energy
    symbols, retreat symbols, the regulation box, the name text. Furniture is
    distinguished topologically, not by chroma.
  - The window edge sits on the bevel's OUTER line.

And what is NOT covered, said out loud: Trainer (431 variants) and Energy (104)
are a different layout with zero exemplars — visibly wrong, probe agrees with the
catalog on 0/49 of them. Pale frames cannot self-verify (45.5% of Lightning and
41.0% of Colorless flagged vs 0.0% of Fire/Psychic/Darkness) — a contrast effect,
calibrated against his own hand masks scoring 0.720 on the same probe.

Revert proven, not asserted: a 2-card run reverts to a byte-identical tree (git
sees nothing), and a supersede round-trip restores the earlier mask with matching
sha256 on both the PNG and the sidecar.

DECISIONS also records an operational gotcha I caused: pkill -f on
"apps/api/dist/index.js" matches the deployed pm2 pokedex-api too. pm2 healed it
in seconds (prod 200, unstable restarts 0), but kill dev instances by PID.

typecheck clean across all workspaces; test:foil 56/56; api + web builds green.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6

---

### `d627995` — 2026-08-08 — foil R7: his eye overturns two banked mechanisms; "no catalog cards" gets a reason

Chey's 15 canon-lab comments (2026-08-07), all resolved in issues/foil/.

Eleven shader verdicts. Two overturn mechanisms built from earlier corpus —
energy-symbols' parity CHECKERBOARD (R3-GLYPH, from his own words) and prism's
solid-facet grid (R3-MISC, from a Gemini delta pass). Having seen both rendered
he rejected them. A description is a hypothesis about the render, not a spec.

  cosmos              the 0.085 UV field slide he read as parallax is now uP4
                      "Surface drift" at 0.012; zero at rest, canon unchanged
  striped-v-sheen     grey lines: the unconditional silver term is gone AND the
                      second-order lobe cut 0.4 -> 0.16 (it drew a whole second,
                      near-achromatic line population on the far side)
  rainbow-mirror      hue axis is card X, blue -> green -> red, on BOTH the
                      sheen and the spotlight; core whitening 0.85 -> 0.32
  energy-symbols      checkerboard gone: per-symbol response AXIS + PHASE +
                      transition WIDTH over a low-freq cluster field
  energy-symbols-ii   same treatment (it shared the two-bank mechanism)
  pokeball-hologram   flat SDF icon -> shaded 3D sphere (hemisphere normal,
                      tilt-following light, belt, hub, two-tone shell)
  tinsel              the "blinds" were a literal full-card striation floor;
                      demoted to uP2, default 0 (his canon stores 0)
  tinsel-ii           line-work gated to the colour band, silver 0.60 -> 0.10,
                      band width exposed as uP4
  prism               pinwheel's spoke fan WITHOUT the per-wedge phase that
                      makes a pinwheel spin; density 33 -> 18
  radiant             hologram step 0.5 cell -> uP4 0.17, drive rescaled so
                      total travel per unit tilt is unchanged
  rainbow-glitter     invisible on card: bigger white-lifted flakes AND the
                      family fixed (flash -> field; no substrate, no contrast)

Canon policy held: shader.ts / canon.ts / CardViewer.tsx / data/foil-canon have
a ZERO diff, sheenGlsl() is byte-identical (all four sheen canons frozen), and
every new behaviour went into a NEW uniform old canon files inherit. No stored
value migrated. One recommendation left for him, not applied: tinsel-ii's
starkness is substantially his own canon (uDepth 1 at ~135 lines).

"Why are there no catalog cards?" — asked four times, three answers. The baked
inversion is now v2 and emits a machine-readable diagnosis the lab renders:
  outranked      diagonal-sheen-left — 1,818 SM reverses ARE cited for it, but
                 energy-symbols wins them (the emblem layer vs the sheet
                 rotation; both true). A capped SECONDARY pool is now baked via
                 a new citedFoilPatterns() export and served as via:'cited', so
                 the preview works. Never flip a winner to fill a pool.
  class-absent   pinwheel, pokeball-hologram — the catalog has reverse variants
                 for ex1-ex5 ONLY; the whole late-EX reverse era is missing
                 upstream. The UI now says so instead of "no catalog cards".
  fixed          vertical-sheen-rainbow 0 -> 12 cards. known_residuals recorded
                 twice that the 6 Holo Rare Energies of ex13/ex16 use Sheen but
                 could not be targeted without a card list; the catalog names
                 exactly six per set. Two cardId rows added citing the same
                 Collexy quotes, both residuals closed.

Typecheck (all workspaces) + web build + foil tests green; 14 recipes compile
clean; before/after shots on blank + assigned card at 390px and desktop in
~/.pokedex-dev-hub-legacy/foil-shots/r7/. SKILL R7 field notes + DECISIONS appended.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HE3n5mBRZUCv4oH1dWqPi6


---

## The remaining commits

Short entries — fixes, corpus saves, single-line corrections. Deprioritized,
not discarded. Deduplicated the same way; 25 distinct after collapsing the
rebased copies. 4 DeckPal-side housekeeping commits (rebases, the
personal-path privacy scrub, the deployment-reference strip) are not reproduced
here at all — they are DeckPal's history, not foilkit's, and DeckPal's archive
has them.


| SHA | Date | Subject |
|---|---|---|
| `31810c4` | 2026-08-01 | foil corpus: commit Chey's first hand mask + workbench comment, untouched |
| `afcb885` | 2026-08-02 | foil R2 stage 3 docs: verdict table (10/13 match), field notes, DECISIONS entry |
| `08cbeac` | 2026-08-02 | foil R3: diagonal-sheen slope swap — right is "\", left is "/" (Chey + frames; Gemini was right all along) |
| `cc04c62` | 2026-08-02 | foil corpus: Chey's canon pass — 29 pattern canons saved via canon lab |
| `836018a` | 2026-08-02 | foil corpus: hand mask for base1-5 v19 (sidecar v2, saved via workbench) |
| `d625d15` | 2026-08-02 | foil/vocab: four vocabulary-extension pattern types — gold-secret, vstar-pearl, shiny-vault, detective-pikachu |
| `29a5f91` | 2026-08-02 | foil/vocab: harvest checkpoint — keyframes+clips for the four vocabulary-extension patterns |
| `8c55380` | 2026-08-02 | foil: Gemini verification of all 33 catalog patterns + report + diagonal-sheen-left fix |
| `e84fcc4` | 2026-08-02 | foil: Starlight parallax rework from Chey's critique; resolve his comment |
| `8d1b9d8` | 2026-08-02 | foil: cosmos canon snapshot found saved via canon lab (uDarken 0.2, warm hue) |
| `21b6365` | 2026-08-02 | research/foil-pattern-usage.json: cited era->pattern map (7 Ringer lanes + editorial conflict rows, 113 rows) |
| `d1ab2d8` | 2026-08-02 | research/foil-patterns.md: canonical 39-pattern spec (video + Bulbapedia + vision pass reconciled) |
| `5a7c90d` | 2026-08-02 | video reference corpus, pre-synthesis checkpoint |
| `f068ef4` | 2026-08-03 | foil CLOSER: merge closeout — CHEY-REVIEW punch list + DECISIONS entry |
| `7c8e3be` | 2026-08-07 | foil canon: Chey's hand-tuned cracked-ice canon (saved 2026-08-07 04:35) |
| `8a62af3` | 2026-08-07 | foil canon: Chey's hand-tuned mirror canon (his words: "basically perfect") |
| `145359c` | 2026-08-07 | foil canon: Chey's re-adjusted cracked-ice (2026-08-07 12:11) |
| `723d63b` | 2026-08-07 | foil canon: Chey's tinsel-ii + rainbow-glitter-sheen, hand-tuned on the R5b additive law |
| `d34c3b5` | 2026-08-08 | foil analysis-source: honest provenance for the pixels a generator fits to |
| `c4c622f` | 2026-08-08 | foil corpus: Chey's Tropius me05-001 sheet mask (hand-refined), pokeball-hologram canon, 7 canon re-tunes, first window adjustment |
| `74e4949` | 2026-08-08 | foil corpus: Chey's correction of the line-snap Tropius mask (ai-corrected) |
| `49f4a86` | 2026-08-08 | foil corpus: Chey's corrections of all 8 regionlearn-me05-1 masks (modern-sv/sheet now 11 human-authored) |
| `2dca1be` | 2026-08-08 | foil corpus: Chey's mask batch — 2 new modern-sv sheet masks, base1-7 new, base1-5/6/8 refined |
| `8e4d7e2` | 2026-08-08 | foil/mask-vector: state the bar before the generator exists |
| `db4eb50` | 2026-08-08 | foil: fix modern-sv art window top edge (106px -> 66px) |

---

## Related

- [Foil Taxonomy](Foil-Taxonomy) — what the patterns in these commits actually are
- [Shader Contract](Shader-Contract) — the uniform contract these rounds converged on
- [Provenance Model](Provenance-Model) — the sidecar and exemplar rules argued out here
- DeckPal's [Foil Branch Log](https://github.com/cheyras/deckpal/wiki/Foil-Branch-Log) — the full archive, including everything this page left out

_Last updated by Claude Fable 5 on behalf of @cheyras — 2026-08-31_