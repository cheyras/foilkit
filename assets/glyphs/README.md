# The glyph slot — originals only, and the rule comes first

Four foil recipes carry a **glyph slot**: a place for real artwork to replace the
procedural stand-in the recipe draws today. This directory is where that artwork
lands. It is empty, and that is the shipping state, not a defect — the slot
exists so the work stays possible.

**Read the rule before dropping a file.** The drop is designed to have no review
step: a file appears, the renderer picks it up, and it is in the dataset. That
convenience is exactly why the rule has to be stated before the first asset
arrives rather than after.

---

## The rule

**Every asset in this directory must be an original, and must arrive with a
notice file.**

foilkit's dataset is dedicated to the public domain under CC0-1.0. A CC0
dedication is worth exactly what the dedicator's standing is worth, and one
traced trademark glyph makes the whole corpus's dedication unreliable — not just
that file's. This is `AGENTS.md` F2, and this directory is the case it was
written for.

Specifically, and without exception:

- **No traced or extracted trademark glyphs.** The nine TCG energy symbols and
  the Poké Ball are TPCi marks. Tracing one from a card scan, a game rip, a wiki
  image or a font produces a derivative of that mark; redrawing it "by eye"
  produces the same mark by a slower route. Neither may enter a CC0 dataset.
- **No third-party icon sets**, however permissively licensed, without the
  research trail in a notice file — and note that a permissive licence answers
  the copyright question and says nothing at all about the trademark.
- **An original geometric recreation is fine**, and is the intended path: shapes
  that read as "an energy symbol" the way a generic drop shape reads as water,
  authored here, owned outright.
- **Every file carries a notice**, in the shape `NOTICE-CONVENTIONS.md`
  specifies: what it covers and the claim, the research trail with its
  rejections and their evidence, who authored it, the licence, and what would
  change the analysis. A notice naming only the winner reads like a notice
  written after the fact to justify something already committed.

The template is DeckPal's `ENERGY-ICONS-NOTICE.md`, which documented original
geometric recreations with a full rejection trail — a bulk card API that 404s on
every type-symbol path, two MIT icon sets rejected for shipping the eighteen
video-game types rather than the TCG's distinct energy set, and a third rejected
for resolving to NOASSERTION. That is the standard of evidence.

**If an asset cannot meet this, it does not go here.** The slot stays empty and
the recipe renders its procedural fallback, which is a working state. Shipping
nothing is always available; un-shipping a trademark is not.

## The four slots

| Slot | Recipe | Files |
|---|---|---|
| `reverse-sheet/` | the stamped emblem sheet | `glyph.svg` — one emblem, stamped per grid cell. Several files (`glyph-1.svg`, `glyph-2.svg`, …) become a random per-cell mix. |
| `energy-symbols/` | EX Hidden Legends' art-window energy foil | `glyph-1.svg` … `glyph-9.svg` — any count from 1 to 16 works. |
| `energy-symbols-ii/` | EX FireRed & LeafGreen | Optional. Leave it empty and it automatically shares the `energy-symbols/` atlas. |
| `prismatic-pokeball/` | the Prismatic Evolutions overprint | `glyph.svg` — the ball watermark. |

## File contract

- **Names:** `glyph.svg` (single) or `glyph-1.svg` … `glyph-16.svg` (a set).
  `.png` is accepted, same names. Anything else is ignored.
- **Shape:** square-ish viewBox, glyph centred, filled. The **alpha channel is
  the stamp coverage** — opaque is glyph, transparent is background. No
  background rect.
- **Colour:** irrelevant for three of the four slots; the shader colours the
  glyph with the pattern's own hue ramp, so draw it white or any solid. The
  exception is **prismatic-pokeball**, which also reads the glyph's interior
  *luminance* as light-response detail: brighter interior areas catch the flash
  at a further phase offset, which is what makes the ball's structure read.
  Shading the belt and button lighter or darker than the body is useful there;
  flat works too, it just reads as one plane.

## How it is picked up

`@foilkit/three`'s `glyphs.ts` polls an index while a glyph-capable recipe is on
screen, rasterises the files into a texture atlas at 256 px per glyph, and binds
it to `uGlyphTex` / `uGlyphOn` / `uGlyphCount` / `uGlyphCols`. Each recipe's GLSL
branches on `uGlyphOn`: atlas present, sample the artwork through the
`glyphTex()` helper; absent, draw the procedural glyph. Everything else in the
recipe — checkerboard swap, banks, noise grain, the light-response ball — is
behaviour and runs identically either way.

The route is configurable and defaults to `/foil-glyphs`, so a host that simply
serves this directory needs no configuration:

```
GET <base>            -> { patterns: { <slug>: { files: string[], mtime: number } } }
GET <base>/<slug>/<f> -> the asset bytes
```

`configureGlyphSource(base)` points it somewhere else. A host that re-reads the
directory per request makes saving a file the whole deploy: the viewer
re-rasterises when `mtime` moves.

**With no assets, `uGlyphOn` is 0 everywhere and every slotted recipe renders its
fallback.** That is the current state of this repository.
