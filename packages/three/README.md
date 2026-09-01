# `@foilkit/three`

The three.js binding, and the React surfaces built on it.

```ts
import { buildFoilMaterial } from '@foilkit/three'
import { CardViewer, useTilt } from '@foilkit/three/react'
```

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
  shader alpha, and an rAF loop that eases tilt toward a mutable target and
  pushes live uniform values out of a ref, so slider changes and pointer motion
  never re-render React.
- `useTilt` — pointer and gyroscope tilt, `[-1, 1]` per axis.
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
