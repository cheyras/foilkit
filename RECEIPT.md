# The moving receipt

**2026-09-01.** foilkit's library packages, authoring stack and corpus were
extracted from DeckPal's `foil/main` (`b803b43`). This document is the evidence
that nothing changed in transit.

It is a **one-time artifact, not a permanent standard.** It exists so the origin
branches can be deleted safely. Once it has been read, the harness goes back to
being a tool rather than a gate, and the repository is free to change — the real
work happens by using this, not by finishing it.

Evidence files: [`docs/receipt/`](docs/receipt/).

---

## 1. Render parity — 45 / 45 byte-identical

All 45 recipes rendered on the blank card base (`uScanBase 0`, where the classic
composite runs unchanged and renders are bit-identical) through the
frame-stepped zero-delta harness: `requestAnimationFrame` stubbed and stepped,
`performance.now` frozen, 300 frames to the easing's float64 fixpoint,
SwiftShader, `page.screenshot({ clip })` on the card rect.

| | |
|---|---|
| Control pair (two runs of the same build) | **byte-identical**, so the instrument is sound before it measures anything |
| DeckPal `foil/main` vs foilkit | **45 / 45 byte-identical**, 0 differing |
| Re-run after the canon freeze | **45 / 45 byte-identical** against the same origin baseline |

The last row is the one that carries the freeze. Twenty-two canon files gained
explicit values for uniforms they had been inheriting, and the renders did not
move by a bit.

**A deviation from the plan, and it is a strengthening one.** The plan called for
running DeckPal's harness in DeckPal and foilkit's harness in foilkit. That
compares two different host pages as much as it compares two builds. Instead,
`tools/parity/` takes its modules as URL parameters, and **one page rendered
both sides** — foilkit's `packages/*/dist`, and a plain `tsc` build of DeckPal's
`shader.ts` + `patterns.ts` served at `/origin`. Same page, same three.js
(0.185.1), same camera, same geometry, same rasterizer, same canon files. The
only variable is the code, so byte identity means what it is supposed to mean.

Per-pattern sha256: [`render-origin.json`](docs/receipt/render-origin.json),
[`render-foilkit.json`](docs/receipt/render-foilkit.json). Comparison:
[`render-parity.json`](docs/receipt/render-parity.json).

## 2. Tests — 177 pass, 0 fail

| | |
|---|---|
| Ported from DeckPal | **111** — 99 in `@foilkit/forge`, 12 in `@foilkit/core` |
| Already here (`tools/rectifier`) | 66 |
| **Total** | **177 pass, 0 fail** |

`node:test`, no dependencies, no build step.

The count survives a real structural change. DeckPal's canonical-space suite
guarded three files for typed-in raster numbers: two canonical-space modules
(one per app, because its api could not import its web sources) and the mask
editor. The two modules collapsed into one here, which would have made it 110.
The third guard now watches `@foilkit/forge`'s `generate-masks.ts`, whose
`MASK_W`/`MASK_H` are the same number seen from the authoring side and which
DeckPal never guarded at all.

## 3. Data — the corpus reads, and the resolver answers identically

**Canon.** 32 files load, name a real recipe, carry only uniforms the contract
declares, and stamp contract 2. All 32 are now full snapshots; all 32 carry a
`frozen` record. 0 problems.

**Sidecars.** 20 live sidecars normalise through `normalizeSidecar` to v4, all
resolving to the `canonical` frame — inferred from the mask PNG's own header,
not from the width and height the JSON claims. Every one agrees with its pixels.
By derivation method: 2 `hand`, 3 `hand-refined`, 10 `ai-corrected`, 5 `ai`.

**Masks.** 86 live PNGs, every one 504 × 704. The pre-migration originals under
`superseded/` are deliberately exempt — they are archives, at the raster they
were authored in. The whole `data/foil-masks` tree is `diff -r` clean against
its origin: 248 files, unchanged byte for byte.

**Windows.** 1 record. **Overrides.** 0, as ever — that layer has code and has
never had data.

[`data.json`](docs/receipt/data.json)

**Resolver.** The catalog the resolver runs against is a database, and there is
none here — so the probe was built from the corpus itself: every set id, card
id, rarity, variant kind and facet the assignment file names, crossed with all 8
series slugs the era layouts declare. **10,312 distinct inputs**, sorted,
resolved, digested.

| | |
|---|---|
| DeckPal `foil/main` resolver + its `research/foil-card-assignments.json` | `8541aa1b389d5a8b04508aa237189dce196ef470f358dc913c8c9584beafc367` |
| `@foilkit/resolver` + `data/foil-card-assignments.json` | `8541aa1b389d5a8b04508aa237189dce196ef470f358dc913c8c9584beafc367` |

Identical, and the two output files diff clean line for line. `RESOLVER_VERSION`
5 on both sides. Every match tier is exercised: 4,160 `facet`, 2,664 `set`,
2,520 `series`, 880 `card`, 88 `heuristic`, across 31 distinct patterns.

[`resolver-origin.json`](docs/receipt/resolver-origin.json),
[`resolver-foilkit.json`](docs/receipt/resolver-foilkit.json)

## 4. Independence — core builds and runs with three.js absent

`tools/check-independence.mjs`, three checks, because the first two only look at
declarations:

1. **Source scan** — no `three`, `react` or `react-dom` import in
   `packages/core` or `packages/patterns`.
2. **Compile** — both packages typecheck in a sandbox whose `node_modules`
   contains exactly `typescript` and `@types` and nothing else. No three, no
   `@types/three`.
3. **Execute** — the modules are loaded and `buildFoilShader()` assembles a
   30,389-character fragment shader for `cosmos` with no renderer in the
   process. A dynamic `await import('three')` would pass the first two and fail
   here.

This runs in CI, because it is what keeps a WebGL2 or custom-element adapter a
later *addition* rather than a later rewrite.

---

## Content compliance

The extraction had to satisfy the purge's content rules before the origin
branches could be deleted.

| Rule | Result |
|---|---|
| No `frame-*.jpg` / `clip.webm` reference media | **387 media files skipped** (344 JPG + 43 WebM). `git ls-files` carries zero of either. |
| Strip the transcript section from all 44 `notes.md` | **44 of 44 stripped.** Everything above the heading — chapter timestamps, cards shown, usage claims, verification notes — kept. |
| Reword the 4 `gemini-spec.md` files with inline transcript quotes | **All 4 reworded to attribute by chapter timestamp**: cracked-ice (3 edits), tinsel-ii (1), prism (1), prismatic-pokeball (2). Analysis kept, quotation gone. |
| `research/frontend-shots` never comes | Never referenced, never copied. |
| `data/foil-masks` carries clean | 248 files, `diff -r` clean against origin, all live PNGs 504 × 704. |

**One finding beyond the rules.** 39 of the 44 `pipeline/jobs/*.json` prompts
embedded the full auto-caption block for their video segment — considerably more
transcript than the notes carried, and not named in the original rule. The
rule's reason covers it exactly, so all 39 were stripped and each carries a note
saying what was there and how `fetch-reference.sh` puts it back locally. The
prompt rubric itself, which is the part that is ours, is untouched.

## Reference corpus and `MANIFEST.json`

`MANIFEST.json` was **built and validated against the offline archive**
(`foil-video-reference-archive-2026-08-31`): 43 directories with media, 8 frames
each, all 480 × 270, clip present, every second-range parsed out of the notes.
44 of 44 notes carry the source URL; 43 of 44 have parseable ranges and the 44th
says "No media extracted" and means it. Structural tier: OK.

**Two honest gaps, both recorded in the file rather than papered over.**

The **source tier is unmeasured on all five videos**. The archive holds the
derived frames and clips; it never held the source videos, which were fetched,
cut from and discarded under the media budget. `durationSec` and `sha256` are
present, `null`, and flagged `"measured": false`.
`fetch-reference.sh --record` fills them from a real download.

**Five source videos, not six.** A sixth id (`TjlU_WKhS8w`) appears in the
resolver evidence as a citation for a usage claim; no frames or clip were ever
cut from it, so it is not a source of this corpus.

`fetch-reference.sh` was **authored, not recovered** — the reference README
claimed the yt-dlp procedure was "recorded in DECISIONS.md" and it was not. The
frame width (480 px) and clip format (360p, silent) were recorded; **the
keyframe selection rule was not**. The script uses even spacing across each
recorded range, which is the most likely reading of "8 keyframes spanning" and
matches the archived frames — but it is a reconstruction, and after two
re-encodes no comparison can distinguish "wrong rule" from "different decoder".
That is precisely why the derived tier is structural rather than exact.

## What did not come across

Recorded so it is a decision rather than an omission.

- **The lab shell** — DeckPal's `FoilLab.tsx`, `CanonLab.tsx`, `MaskProvenance.tsx`,
  `ui.tsx` and the `api.ts` HTTP client. Bound to DeckPal's router and API
  surface; the hosted contribution editor is their replacement. The reusable
  half — the card viewer, the tilt hook, the pan/zoom controller, the mask brush
  and the window handles — did come, in `@foilkit/three/react`.
- **`canon-harness.mjs` and `canon-aspect-recheck.mts`** — superseded rather than
  carried. Both drove DeckPal's React canon lab through a routed dev server;
  `tools/parity/` is the general form of the same instrument, and the measured
  result of the contract 1 → 2 recheck ships as
  [`docs/CANON-ASPECT-RECHECK.md`](docs/CANON-ASPECT-RECHECK.md).
- **`data/foil-overrides`** — nothing to carry. It has never existed as data.

## Reproducing this

```
pnpm install
pnpm test                     # 177
pnpm run build && pnpm run typecheck
node tools/check-independence.mjs
node --conditions source tools/parity/data-receipt.mjs
node --conditions source tools/parity/resolver-receipt.mjs

# the render half needs playwright (deliberately not a dependency)
node tools/parity/serve.mjs &
node tools/parity/run.mjs --out shots/a
node tools/parity/run.mjs --out shots/b
node --conditions source tools/parity/compare.mjs shots/a shots/b
```

The last three are the control pair. Comparing against DeckPal additionally
needs a build of its `shader.ts` and `patterns.ts` mounted at `/origin` — see
[`tools/parity/README.md`](tools/parity/README.md).
