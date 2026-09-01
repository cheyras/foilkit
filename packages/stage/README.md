# `@foilkit/stage`

The stage's policy, with no renderer in it.

```ts
import {
  STAGE_DEFAULTS,
  createLadder,
  createTiltSource,
  scheduleFrame,
  scissorBox,
  faceTextureWidth,
} from '@foilkit/stage'
```

Rendering three hundred foil cards is an **architecture** problem, not a shader
problem. This package is the architecture's decision-making half: which cards
animate, at what resolution, at what cadence, from which tilt source. All of it
is arithmetic over rectangles and frame times, so it lives here — where
`node --test` checks it without a GPU — and `@foilkit/three` binds it to a
`WebGLRenderer` in `FoilStage`.

It imports **nothing**, and `tools/check-independence.mjs` proves it on every
push, for the same reason it proves it of `@foilkit/core`: a future `webgl2` or
custom-element adapter should inherit "one renderer, any number of cards"
rather than reimplement it.

## The budget ladder

`createLadder()` watches measured frame time and steps down in exactly this
order, climbing back as headroom returns:

1. **Render resolution** — stage pixel ratio first, then per-card render scale.
   Foil is low-frequency light: the cheapest thing to give, the last thing an
   eye notices.
2. **Frame rate, uniformly** — every card drops together. A page where
   everything runs at 30 reads as deliberate; a mixed-cadence page reads as
   broken.
3. **Freeze the excess mid-tilt** — a still foil card is a resting state.
4. **Stop the cards farthest from viewport centre.**

Measured, not configured: no tuning table, no device list, no per-phone
constant, so it lands correctly on hardware that does not exist yet.
`LADDER_STEPS` is a declared table rather than a computed one precisely so the
order is readable and testable.

Two details that are easy to get wrong and are therefore load-bearing:

- The signal is the stage's own **work** time, not the gap between frames.
  Rung 2 lengthens that gap on purpose; a ladder reading its own cadence as
  evidence of load could never climb back.
- Dropping is judged against the cadence being run; climbing against the
  cadence being aimed at. The gap between them is the hysteresis.

## Tilt sources

A tilt source answers one question: given a card's registration and its current
screen rect, what is its tilt vector right now? **Per-card by construction** —
a single shared `{x, y}` cannot express pointer-follow across a grid.

`pointer`, `gyro`, `scroll`, `sweep`, `manual`, `none`. A custom one is an `id`
and a `tiltFor`:

```ts
stage.setTiltSource({
  id: 'wobble',
  tiltFor: ({ time, index }) => ({ x: Math.sin(time + index * 0.3), y: 0 }),
})
```

`pointer` and `gyro` are the workbench hook's mappings intact: the same −1..1
range, the same first-reading gyro baseline so however the phone was held is
neutral, the same iOS 13+ `requestPermission` gate, the same reduced-motion
default of a source that never moves on its own.

## Scheduling, geometry, textures

- `scheduleFrame(cards, plan, viewport)` decides draw / animate / park per card.
  Offscreen cards get no uniform update and no draw; a card under
  `minAnimateWidth` (default **150 CSS px** on the short edge — a host number,
  not a rule) renders one static frame.
- `scissorBox(rect, viewport, pixelRatio)` crosses the one coordinate boundary
  in the whole system: CSS rects grow down from the top-left, scissor boxes grow
  up from the bottom-left, in device pixels.
- `faceTextureWidth(cssWidth)` caps a face by its on-screen size and buckets to
  powers of two, so a scrollbar appearing does not re-decode the screen. KTX2 is
  deliberately out of scope; capping plus a URL-keyed cache is measured first.
- `maskTextureWidth(cssWidth)` is the same policy at half the budget: `uMaskTex`
  is low-frequency alpha with a 0.008 UV feather, so a mask matched to face
  resolution spends memory on detail the shader immediately blurs away. It is
  also what makes a **vector** mask the right stored form — the stage picks a
  size and the geometry is rasterised to it, so mask resizing never becomes a
  question and no stored raster is ever wrong for the box it lands in.

MIT. See `REUSE.toml`.
