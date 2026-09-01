# The stress demo

Several hundred foil cards, one WebGL context.

```bash
pnpm run build          # the demo loads packages/*/dist, not src
pnpm run demo           # http://127.0.0.1:5200
```

This page is simultaneously **the test, the benchmark, and the reason someone
adopts the library**. Rendering one foil card was never the hard part; the
workbench viewer built a `WebGLRenderer` per card, and browsers cap contexts
somewhere between ~8 (three.js's own guidance) and 16 (Chrome) before silently
losing the oldest — so a grid was not slow, it was impossible. The claim this
page exists to make true is that the count stopped mattering.

## What it shows

- **300 cards** (`?n=`), virtualized the way a real host virtualizes, with
  mounting and unmounting churning continuously underneath.
- **Mixed patterns** (`?patterns=`, `?patternIds=`) — the shipped recipes, with
  their real canon snapshots out of `data/foil-canon`.
- **Both presentation modes**, switchable live: `underlay` (one canvas behind
  the page, scissor per card) and `blit` (a canvas per element). The tiles carry
  a tappable counter box and an opaque footer over the art — exactly the
  condition `blit` is the escape hatch for.
- **Every tilt source**, switchable live: pointer, gyro, scroll, sweep, manual,
  none.
- **Both mask tiers at once.** Two thirds of the cards carry no mask texture —
  the layout-rect tier is a `rectMask` in the shader and uploads nothing. Every
  third card (marked ▣) carries a **vector** art-window mask instead,
  rasterised client-side at whatever size the stage picked for that card's box;
  they share one id, so the whole screen's worth rasterises once per size.
- **A ladder readout**: the engaged rung and its label, measured work time, fps,
  pixel ratio, compiled programs against distinct patterns, cached textures
  against distinct URLs, and the context count.
- **A forced-load slider**, which busy-waits inside the stage's measured frame
  so the ladder engages on a fast machine. That is the only honest way to
  demonstrate "engages and recovers" without a slow phone in the room: the
  ladder reads work time and has no idea where the work came from.

Query parameters: `n`, `faces`, `patterns`, `patternIds`, `tile`, `mode`,
`source`, `minAnimateWidth`, `virtualize=0` (mount every card at once).

## No card imagery, here or anywhere

The faces are drawn in a canvas, from arithmetic — the standing ownership rule
(`AGENTS.md` F2) applies to a demo exactly as it applies to the dataset. Nothing
is lost by it: the texture budget is a function of size and count, and these are
the same size and count real scans would be. What *is* real is everything the
claim depends on — the shipped recipes, the shipped canon, the shipped
composite, the shipped stage.

## The CSS discipline `underlay` asks for

The page background lives on `<html>`. `#app` is positioned, so it paints above
the fixed canvas the stage prepends to `<body>`. Tiles have no background, which
is what makes each card slot a hole through to the canvas; the chrome that must
sit *over* the art is opaque and `z-index`ed above it. That is the whole
contract, and this page is its worked example.

## Acceptance

```bash
pnpm run demo &                                  # or in another terminal
PW_ROOT=<somewhere>/package.json pnpm run acceptance
```

Playwright is deliberately **not** a repository dependency — the library and the
test suite need none, and this is an instrument rather than a gate. Install it
anywhere, point `PW_ROOT` at that `package.json`, and run
`npx playwright install chromium` once.

The run asserts, in both modes:

| | |
|---|---|
| one WebGL context | counted by instrumenting `getContext` from an init script, before any page code runs — and context **loss** counted separately, because past the cap the browser loses one silently |
| one program per pattern | read from three's `renderer.info.programs`, not from the stage's material map: the map is what the stage intended, `info.programs` is what the GPU was asked to compile |
| one texture per URL | after scrolling the whole grid, so every card has mounted and unmounted |
| vector masks per size, not per card | a per-card rasterisation would show as dozens |
| 300 simultaneous registrations | with the virtualizer switched off, which is the shape the old per-card renderer could never take |
| the ladder engages and recovers | forced by the synthetic-load knob; required to spend resolution first, and to give back at least a whole rung. Recovery is watched on a clock (a frame count measures how fast the machine renders, not whether the ladder recovers) and asserted in RUNGS, because the exact step a machine can hold is a property of the machine and moves during a run — asserting it would be asserting the runner's hardware |
| both modes render | the screenshot goes back into the page, is decoded by the browser and measured for distinct colours and luma range — "it did not throw" is not evidence of pixels |
| both modes render at a reduced pixel ratio | the ladder pinned to rung 1. A bug invisible at full quality is not caught by a test that only ever runs at full quality — this is where the ratio-applied-twice bug lived, green on four other checks in the same run |

Output lands in `apps/demo/.acceptance/` (gitignored): a PNG per mode and
`acceptance.json` with every number.
