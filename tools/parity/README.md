# `tools/parity` — the pattern room, and the moving receipt

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 Chey Rasmussen -->

A minimal host page that renders one recipe on a blank card base, a headless
driver that steps it to a fixpoint and screenshots it deterministically, and two
scripts that turn "the extraction changed nothing" into a number.

The render half exists because a foil recipe is only meaningful relative to a
specific `main()`, and prose cannot compare two of those. The page is the
smallest thing that produces the real composite; it is also the seed of the
stress demo that subtask 6 builds.

## Determinism, and why each piece is there

Every one of these was a real failure first.

- **`requestAnimationFrame` is stubbed**, callbacks queued and driven by
  `window.__stepFrames(n)`. With real rAF the tilt easing (`x += (t-x)*0.12`)
  never settles; a residual of 2e-5 tilt still flips hundreds of 1-LSB pixels
  along pattern band edges, and a same-settings control pair one second apart
  diffed 15k px.
- **`performance.now()` is frozen**, so `uTime` is exactly 0 every frame —
  ambient drift is a clock read, not an animation.
- **~300 stepped frames** drive the easing to its float64 underflow fixpoint. 30
  frames is not converged and the difference is visible in a diff.
- **`page.screenshot({ clip })` only.** Element screenshots wait on real
  animation frames for their stability check and hang against the stub.
- **Every wait is interval-polled.** Playwright's `waitForFunction` defaults to
  polling on rAF, which this harness has stubbed and does not flush — an
  rAF-polled condition is evaluated once and then never again.
- **SwiftShader**, so rasterization does not vary with the GPU.
- **The viewer host is a fixed 1000 × 800 px box.** The clip is computed from
  those two numbers; a responsive host would make the receipt depend on the
  window manager.

## The page takes its modules as parameters

`shaderUrl`, `materialUrl`, `patternsUrl` and `canonUrl` are all query
parameters. That is the point: the SAME page can be pointed at foilkit's
packages or at any other build of the same modules, so a pixel difference is a
difference in the CODE and not in the page around it. Comparing two different
host pages would have proved nothing.

```
node tools/parity/serve.mjs --port 5199 --mount /origin=<dir-of-other-build>

# this repository
node tools/parity/run.mjs --out shots/foilkit

# the other build, through the identical page
node tools/parity/run.mjs --out shots/origin \
     --shaderUrl /origin/shader.js --materialUrl /origin/shader.js \
     --patternsUrl /origin/patterns.js --canonUrl /origin-canon

node --conditions source tools/parity/compare.mjs shots/origin shots/foilkit
```

`compare.mjs` reports byte identity per pattern and, where two PNGs differ, mean
and max absolute error over the card rect. Byte identity is the bar for a move:
the same code rendering the same uniforms through the same three.js on the same
rasterizer has no licence to differ by a bit. It is not the bar for a change —
under a composite-contract bump, run the harness once per law and rank on mean
AE, which is how contract 2 was measured (`docs/CANON-ASPECT-RECHECK.md`).

**Run a control pair first.** Two runs of the same build into different
directories, compared. If that is not byte-identical, nothing downstream of it
means anything.

## The other two receipts

`resolver-receipt.mjs` builds a probe out of the assignment corpus itself —
every set id, card id, rarity, variant kind and facet it names, crossed with
every series slug the era layouts declare — resolves each one, and digests the
sorted result. It needs no catalog, and two builds either produce the same
sha256 or they do not.

`data-receipt.mjs` asks whether the corpus still reads: canon files load, name a
real recipe, carry only contract uniforms, and stamp the law they are read
under; every live sidecar normalises through `normalizeSidecar`; every live mask
PNG is the canonical 504 × 704 and agrees with the size its sidecar claims. It
reads the PNGs, not just the JSON — a sidecar claiming a raster its pixels deny
is exactly what a file copy can introduce and a schema check cannot see. Masks
under `superseded/` are deliberately not size-checked: those are the
pre-migration originals, archived at the raster they were authored in.

## Playwright

Deliberately not a repository dependency — the library needs none and the test
suite needs none, and this is an instrument rather than a gate. Install it
anywhere and point `PW_ROOT` at that project's `package.json`, then
`npx playwright install chromium`.
