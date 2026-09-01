# `@foilkit/three`

The three.js binding, and the React surfaces built on it.

```ts
import { FoilStage, buildFoilMaterial } from '@foilkit/three'
import { CardViewer, useTilt } from '@foilkit/three/react'
```

## `FoilStage` — one canvas, one renderer, any number of cards

```ts
const stage = new FoilStage({ mode: 'underlay', tiltSource: 'pointer' })
const handle = stage.register(element, { pattern, imageUrl })
// …later
handle.unregister()
```

A host registers a DOM element plus a card config and unregisters on unmount.
**Nobody consuming foilkit constructs a renderer**, and card count stops being
something a host reasons about.

One `WebGLRenderer`, one material cache keyed by `patternId` (two cosmos cards
compile one program), one texture cache keyed by URL (two tiles of the same card
upload once), one rAF loop, one `IntersectionObserver`, one `ResizeObserver`.
The policy — the budget ladder, the tilt sources, the schedule — is
`@foilkit/stage`, which imports no renderer; this package is the binding.

`options.renderer` supplies an existing renderer, which the stage then never
restyles or disposes. A host already running its own three.js scene must not be
forced into a second context: that is the exact problem being solved.

Two presentation modes, both shipped:

| | |
|---|---|
| **`underlay`** (default) | One canvas fixed behind the page; scissor + viewport per card, every visible card in a single pass. The fast path. It asks the host for CSS discipline — anything opaque stacked over a card blocks the view, and page content must be positioned so it paints above the canvas. |
| **`blit`** | Each element gets its own canvas, blitted from the shared drawing buffer with `drawImage` inside the same frame — GPU-side, no readback. One operation per card per frame, total layout independence. The escape hatch for layouts the developer does not control, and what a tile with tappable chrome stacked over the art needs. |

`stage.stats()` reports the numbers the stress demo asserts: contexts (one),
compiled programs, cached textures, the engaged rung, measured work time.

## `@foilkit/three`

`buildFoilMaterial(pattern)` returns a `THREE.ShaderMaterial` with every uniform
seeded and two 1×1 `DataTexture` fallbacks bound, so `uMaskTex` and `uGlyphTex`
are always valid samplers. It is about sixty lines: everything else — the GLSL,
the uniform contract, the composite law — is in `@foilkit/core`, which imports
nothing.

`glyphs.ts` is the glyph slot. It fetches an index, rasterises dropped artwork
into a texture atlas, and hands it to the material. The asset route is
configurable (`configureGlyphSource`) and defaults to a relative `/foil-glyphs`,
so a host that simply serves `assets/glyphs/` needs no configuration. With no
assets, `uGlyphOn` stays 0 and every slotted recipe renders its procedural
fallback — the current and correct state. Read `assets/glyphs/README.md` before
adding one.

## `@foilkit/three/react`

`react` is an **optional peer dependency**; importing this subpath is what makes
it required.

- `CardViewer` — one card plane at the correct 63:88 aspect, rounded corners via
  shader alpha, live uniform values pushed out of a ref so slider changes and
  pointer motion never re-render React. Same public shape as it always had; it
  is now a **thin host** that registers one element with the shared stage in
  `blit` mode, so the canvas stays inside its box and every overlay above it
  keeps working.
- `useTilt` — pointer and gyroscope tilt, `[-1, 1]` per axis; a one-card wrapper
  over `@foilkit/stage`'s sources, which hold the mapping.
- `ViewTransform` — the pan/zoom controller. Zooming re-rasterises at the zoomed
  size rather than scaling pixels, which is what makes 4× zoom show 4× real
  detail — the whole point of the feature for edge tracing.
- `MaskEditor` — the raster brush: pressure-modulated width, a screen-constant
  tip, drawing in canonical space.
- `WindowEditor` — the art-window handles.

Not carried from the origin repository: the lab shell itself — its page layout,
its HTTP client and its slider chrome — which was bound to DeckPal's API and
router. The hosted contribution editor is its replacement.

MIT. See `REUSE.toml`.
