**Deep dive.** The narrative companion to the pattern library. When `docs/PATTERNS.md` lands with the extraction it becomes canonical for the API surface — ids, parameters, canon files — and this page stays as what the patterns physically *are*.

# Foil Taxonomy

This is the part of foilkit that makes the "dataset with a renderer attached"
framing legible. A foil shader with a few sample cards is a demo. What is here
instead is a catalogue of **43 distinct physical foil treatments** used on
Pokémon TCG cards between 1996 and 2025, each identified from real tilt footage
and owned scans, each with a recipe that reproduces its specific behaviour.

Bulbapedia names **eleven** foil patterns. This catalogue splits finer, because
eleven names cannot tell you which of three visually distinct cosmos generations
a 2013 promo carries, and that distinction is exactly what the resolver has to
get right.

## The counts

| | |
|---|---|
| Taxonomy types | **43** — 39 identified from the reference footage, plus four vocabulary extensions added 2026-08-02 |
| Entries in the pattern library | **45** — the 43, plus `none` (the plain-card baseline) and `reverse-sheet` (a coarse composite recipe, not its own taxonomy number) |
| Implemented | **44 of 45**. The one gap is `big-glitter`, approximated via cracked ice |
| Types with no catalog exemplar | **4** — `sequin`, `tcg-classic`, `acid-wash`, `disco`. Built to corpus frames and verified by eye only |

---

## The organizing axes

Four axes, and they are genuinely independent. Confusing them is the most common
way to get a card wrong.

### Taxonomy — what it physically is

The 43 types below. A property of the *printing process*: which foil stock, what
emboss, what overprint.

### Era — which frame generation the card belongs to

Three, each carrying a measured art-window rectangle and corner radius:

| Era id | Covers |
|---|---|
| `wotc` | Base through Skyridge — base, gym, neo, e-card, Legendary Collection |
| `modern-swsh` | Sword & Shield, 2020–2022 |
| `modern-sv` | Scarlet & Violet 2023 onward, including Mega Evolution. The default |

The WOTC window is the awkward one: it is the art-window rect **minus the subject
silhouette**, because Base-era holos let the foil stop at the character's
outline. That is not expressible as a rectangle, and it is currently approximated
by a luminance gate — an open work item, and the single largest source of error
in the corpus's WOTC coverage.

### Scope — where on the card the foil actually sits

| Scope | Meaning |
|---|---|
| `window` | The art-window rectangle. Standard holo rares |
| `sheet` | The art window **inverted** — foil everywhere *except* the art. Reverse holos |
| `full` | The whole card face, unmasked. Full-art, ultra-rare, secret-rare |
| `none` | No foil; renders the plain scan |

The base rule reads off the catalog variant: reverse → `sheet`, full-foil rarity
→ `full`, holo or declared foil facet → `window`, else `none`. But scope is
overridable per assignment row, because some treatments' physical extent simply
cannot be inferred from rarity: baby shinies are window-scope despite carrying a
full-foil rarity, VSTAR pearls are full-face despite a plain holo kind, and the
Detective Pikachu holos are window despite being catalogued ultra rare.

**Every scope stays eligible for a hand mask.** A shared rule is never provably
right until somebody looks at the card, and a `full`-scope card whose foil
actually stops at the text box is exactly the case only a human finds. Scope
changes the *leverage* of the work, never the permission to do it.

### Family — how the light lands on a real scan

Deliberately separate from taxonomy: `flash | line | stamp | field | pearl |
metal | none`. Two recipes modelling completely different physical processes can
share a family, because a family is keyed on **duty cycle** — the fraction of
the card face the recipe's own light covers.

The reasoning is worth stating, because it is not obvious. Sparse light wants
high gain and no substrate darkening: between the flashes you are looking at
cardstock. Dense light wants less gain and a real substrate: between the
highlights you are looking at foil, which is darker than paper. Getting this
backwards is what made an early build's reverse holos read "dull and grayish".

See [Shader Contract](Shader-Contract) for the per-family constants.

### "Facet" means two different things

Worth disambiguating, because both appear in the code:

- **Physical** — an individual flat micro-mirror in the foil, with its own
  grating angle. A cracked-ice shard, a confetti flake, a sequin, a prism cell.
  It lights only when its normal aligns with the tilt.
- **Catalog** — the foil name embedded in a catalog variant string, extracted by
  pattern match: `holo-foil-cosmos` → `cosmos`. A "facet row" is an assignment
  keyed on that declared foil. It outranks a set-level row and loses to an
  explicit card-id row.

---

## The catalogue

Grouped by physical mechanism rather than chronology, because the mechanism is
what the recipe models.

### Baseline

| id | What it physically is | Where it appears |
|---|---|---|
| `none` | No foil. Plain cardstock. The baseline for judging the scan itself | Non-holo printings |

### True holograms — multi-depth foil with real parallax

Only two treatments in the entire game have genuine layer parallax: the front
foil layer physically shifts against the back one as the card tilts. Everything
else that *looks* three-dimensional is a single plane doing something clever.

| id | What it physically is | Where it appears |
|---|---|---|
| `starlight` | Multi-depth holographic star foil — dots, four-point crosses and eight-point bursts over a dark milky field, with real depth between layers | Base, Jungle, Fossil — **international printings only**; the Japanese Base-era holos used cosmos |
| `starlight-ii` | The same star field reprinted as a **flat single plane**. Stars flash in place, no depth; sharper and more saturated than 1999 | XY Evolutions (2016) |
| `pokeball-hologram` | True multi-depth Poké Ball hologram; balls read at different optical depths and move relative to each other. Carries a visible horizontal manufacturing seam across mid-card | EX Unseen Forces |

### Cosmos family — embossed orbs, single plane, no parallax

The most-used pattern in the game's history, and three visually distinct
generations of it. Orb clusters brighten and dim **in place**; that absence of
parallax is what separates cosmos from starlight, and it is why "Galaxy" is a
synonym for *starlight*, not for cosmos.

| id | What it physically is | Where it appears |
|---|---|---|
| `cosmos` | Embossed circular orbs plus small four-point crosses on one plane over a dark cloudy field | Japanese Base-era holos; English Base Set 2 onward; decades of promos |
| `cosmos-ii-pixel` | Redesigned denser and more silvery: a continuous field of tiny "pixel" specks filling the gaps between sparser diamonds and orbs. Specks twinkle like fine static; the large shapes pop hard at fixed colours | Introduced at Platinum; became *the* default promo pattern — tins, blisters, order bonuses; SV cosmos borders |
| `cosmos-iii-smooth` | "HD" cosmos — perfectly smooth orbs and dots only, no pixels, no stars, a darker denser metallic field, with a sweeping specular band | Introduced at Legendary Treasures; modern promos ship pixel or smooth |

### Sheen family — one linear grating sheet at four rotations

The single most important structural claim in the taxonomy: `vertical-sheen`,
`horizontal-sheen`, `diagonal-sheen-right` and `diagonal-sheen-left` are **the
same physical product mounted at different rotations**. They are kept as separate
ids because distinct eras resolve to distinct rotations, and a resolver that
returned "sheen" would be unable to render any of them correctly.

The band always travels perpendicular to its own axis.

| id | What it physically is | Where it appears |
|---|---|---|
| `vertical-sheen-rainbow` | The sheet's debut: a mirror-smooth window with one soft vertical rainbow band, no particles at all | A few EX-era sets after Unseen Forces |
| `vertical-sheen` | Vertical linear grating — a curtain of sharp vertical "barcode" bands sweeping strictly horizontally with yaw. The same sheet underlies many visually different reverse designs; the ink mask does the rest | HGSS onward through Platinum, Call of Legends, BW, into XY |
| `horizontal-sheen` | The same sheet rotated 90°: a smooth horizontal prismatic band travelling vertically with pitch. Bulbapedia calls it **Mirage** | The default holo of Scarlet & Violet, and the Mega-era standard holos |
| `diagonal-sheen-right` | The sheet at 45°; the band **falls** left to right (`\`) | First on secret deck-exclusive variants, then the XY-era default holo. Japanese diagonals run the opposite way |
| `diagonal-sheen-left` | Mirror of the above; the band **rises** left to right (`/`) | Sun & Moon reverse holos, heavily |
| `striped-vertical-sheen` | The sheen sheet plus very fine **continuous** vertical stripes — as against tinsel's broken dashes — sitting on a subtle fan that converges below the card, lighting in groups as a window sweeps. Bulbapedia calls it **Line** | Sword & Shield regular holos; some Trick or Trade |

### Facet and flake foils — embossed shards that snap on and off

| id | What it physically is | Where it appears |
|---|---|---|
| `cracked-ice` | Faceted embossed foil with per-shard grating angle: irregular sharp polygonal shards on silver, flashing on and off abruptly. Also called Broken Glass, Shards | First on Skyridge box toppers; FRLG bird promos, POP; *the* theme-deck-exclusive holo from Diamond & Pearl through Sword & Shield; League promos |
| `confetti` | Dense irregular small **flakes** — explicitly not square pixels — popping chaotically. Bulbapedia calls this "Pixel", which collides with `cosmos-ii-pixel` | Celebrations (25th anniversary) and every English McDonald's promo set |
| `sequin` | Densely packed small overlapping discs with very narrow activation angles: they snap on and off with no travelling band | General Mills cereal-box promos only |
| `big-glitter` | Manufacturer stock dot-facet foil — a dense uniform field of small homogeneous circular glitter dots that twinkle and hue-shift. **The only unimplemented recipe** | Once: the e-series oversized box toppers |

### Smooth and mirror bases — the raw stock everything else is rolled onto

| id | What it physically is | Where it appears |
|---|---|---|
| `mirror` | Plain aluminium foil. No emboss, **no hue shift at all** — just a travelling white specular. On Shining cards the *subject* is the exposed foil, the inverse of a normal holo | Neo Shining subjects; the base stock under most later patterns |
| `rainbow-mirror` | Smooth unembossed holographic film — structureless, reflecting broad continuous rainbow bands by pure low-frequency diffraction | e-series reverses; a staple base sheet ever since |
| `water-web` | Large organic rippling-liquid contours with oil-slick colour pooling along the ridges; hues **flow along** fixed topography rather than sweeping across it | Sun & Moon standard holos and GX cards, through Cosmic Eclipse |
| `acid-wash` | Continuous fine mottled etched-metal texture — a frosted-sponge look — with broad soft iridescent washes crossing it | Pokémon League promos around 2006, **energy cards only** |

### Glyph and stamp foils — foil shaped into icons

| id | What it physically is | Where it appears |
|---|---|---|
| `energy-symbols` | Foil stamped as a field of distinct Energy symbols with dark unreflective gaps; illumination and a spatial hue gradient sweep across them. **The first bespoke Pokémon-designed pattern** — most of the others are manufacturer stock | EX Hidden Legends |
| `energy-symbols-ii` | The same idea with symbols varying in size and rotation, scattered rather than gridded, sparkle dots interspersed | EX FireRed & LeafGreen |
| `ex-emerald` | Scattered Poké Balls and starbursts **plus** a full-height vertical rainbow band sweeping across them | EX Emerald reverses only |
| `pokeball-masterball` | A staggered repeating grid of Poké Ball and Master Ball stamps on a mirror sheet | Black Bolt & White Flare (2025), which brought Japan's ball reverses to English |
| `reverse-sheet` | A library entry rather than a taxonomy type: mirror sheet plus stamped emblem grid, at a coarse tier. It conflates two things — the stamp grid is really `pokeball-masterball` and the sheet between stamps is plain mirror — and is flagged for splitting | SV and Mega-era reverse holos |

### Grid and lattice foils — cells cycling hue independently

| id | What it physically is | Where it appears |
|---|---|---|
| `pinwheel` | A strict square grid, each cell a pinwheel of radial wedges with per-wedge grating orientation; cells appear to spin | EX Deoxys reverses; revived on simplified-Chinese sets |
| `prism` | A rigid uniform micro-grid of tiny square/diamond cells acting as independent micro-prisms. **Pre-dates the TCG** by about a month | Carddass prism stickers (1996); in the TCG only on XY BREAK cards |
| `disco` | A strict uniform mosaic of small squares, each a different vivid colour — a disco-ball grid. **Never released**: a late-1990s factory test pattern, authenticated prototypes only | — |
| `radiant` | A large diagonal criss-cross diamond grid whose lines are themselves segmented; the grid flares rainbow where a sheen crosses it. Motion is in discrete hologram **steps**, not a slide | Radiant-rarity cards, Astral Radiance onward; full face |
| `ace-spec` | A bold diagonal square/diamond grid whose clusters form plus and cross motifs; thin sharp reflective lines on dark silver, covering the full face including the pink border | SV-era ACE SPEC cards only — the BW ACE SPECs used plain tinsel |

### Line-work foils — striations and weaves

| id | What it physically is | Where it appears |
|---|---|---|
| `tinsel` | Micro-embossed **horizontal** ridges with at least two interleaved grating-angle populations carrying short bright dashes; the dashes slide along their lines at different speeds and directions, giving a two-plane parallax bounce. Confusingly named — the *vertical* line pattern people mistake it for is `striped-vertical-sheen` | BW (2011) regular holos through Legendary Treasures; BW ACE SPECs |
| `tinsel-ii` | Denser, darker, more chaotic horizontal static covering the full face including borders; a smooth sheen sweeps it rather than dashes translating | Black Bolt & White Flare (2025) only |
| `crosshatch` | A fine uniform woven grid of intersecting diagonal lines, fabric-like, with rainbow riding **on** the lines under a sweeping band | Play! Pokémon and League promos exclusively |

### Glitter-over-base composites

| id | What it physically is | Where it appears |
|---|---|---|
| `rainbow-glitter` | Fine dense shapeless glitter layered **over a rainbow-mirror base**: broad bands sweep underneath while specks twinkle in place, with physical emboss ridges breaking it up further | SWSH VMAX and rainbow ("hyper") rares |
| `rainbow-glitter-sheen` | The same glitter, but the base is a distinct **shaped directional band** — a V-shaped arc on the raw sheet — that sweeps as one | Mega-era Mega ex cards |
| `tcg-classic` | Very fine dense glitter grain plus scattered slightly larger four-point stars, with a strong, sometimes curved, sweeping rainbow over both. Every card in the product is holo | Pokémon TCG Classic (2023) only |

### Overprints and radial gratings

An **overprint** is foil or shiny ink printed *above* the artwork ink rather than
beneath it, so it ignores the art mask entirely. Three patterns use one, and
recognising that is what stops a renderer masking them out of existence.

| id | What it physically is | Where it appears |
|---|---|---|
| `fireworks` | Radial-grating foil: large jagged overlapping bursts across the **whole face, artwork included**; each burst hue-rotates as its radial grating aligns, and edge bursts ignite in sequence | Legendary Collection (2002) only — the game's first parallel/reverse set |
| `ex-starfoil` | A diagonal-sheen sheet with a dense four-point-star **overprint** on top. The stars are visible even unlit and ignite in the colours of the passing band | SV-era ex cards, full face |
| `prismatic-pokeball` | A large Poké Ball watermark inside a dense mosaic of irregular polygons. **Not an emboss** — physical texture plus opaque ink printed over a plain rainbow-mirror foil | Prismatic Evolutions Poké Ball reverses |
| `radiant-collection-dots` | Not a unique foil at all: three stacked tricks — a shiny dot overprint above the ink, white-ink shape windows, and plain mirror foil beneath. Some cards in the subset are non-holo and still carry the dot overprint | Radiant Collection subsets (Legendary Treasures, Generations) |

### Vocabulary extensions §40–43

Added 2026-08-02 because they accounted for most of the residuals a
whole-catalog assignment pass could not place. Not present in the reference
footage's 39 types; sourced per-type from collector tilt footage plus written
references.

| id | What it physically is | Where it appears |
|---|---|---|
| `gold-secret` | The whole face — borders, text boxes, background — is gold-tinted metallized foil with a dense fine glitter grain; SWSH golds add embossed radial burst rays. The hue stays **warm-locked**: only intensity and warmth travel, never a full spectral band | Gold Secret Rares (SM), SWSH gold Secret/Hyper, SV gold Hyper Rares, Mega-era gold |
| `vstar-pearl` | Near-white pearlescent *interference* foil, full face, with etch relief, gold accents and a golden aura behind the subject; a broad diagonal pink-gold iridescent wash sweeps it | Regular-print VSTAR cards, Brilliant Stars → Crown Zenith |
| `shiny-vault` | Silvery-white **textured** interference foil with printed shiny-sparkle glyphs — the games' four-point stars and diamond outlines — bursting around the subject. The glyphs amplify a passing soft sheen rather than popping on their own | Hidden Fates and Shining Fates Shiny Vaults, Paldean Fates shinies |
| `detective-pikachu` | Not a patterned foil at all: photographic movie-still art printed translucently over a smooth high-gloss sheen sheet. Beams sweep **through** the photo's smoke and fire volumes, so the foil character follows the photographic texture | Detective Pikachu (2019) — all 18 cards, the only all-holo movie set |

`detective-pikachu` is the pattern library's one documented contract exception:
it is the single recipe permitted to sample the card scan, because its identity
*is* beam × photograph. The consequence is that it renders near-black on a blank
base, by design.

---

## Vocabulary

Terms that mean something specific here, listed because several of them are used
loosely elsewhere:

- **Galaxy** — a synonym for **starlight**, not for cosmos. The distinction is
  parallax.
- **Mirage** — Bulbapedia's name for `horizontal-sheen`.
- **Line** — Bulbapedia's name for `striped-vertical-sheen`.
- **Parallax** — front and back foil layers translating against each other,
  producing genuine depth. Only `starlight` and `pokeball-hologram` truly have
  it; `starlight-ii` deliberately does not.
- **Overprint** — shiny ink or foil above the artwork ink, therefore unmasked.
- **Etched** — physical surface relief in the foil, distinct from a printed
  pattern.
- **Duty cycle** — the fraction of the card face a recipe's own light covers.
  The measurement the composite families are keyed on.
- **Interference foil** — near-white pearlescent stock whose colour comes from
  thin-film interference rather than a diffraction grating. It reads pale, and
  it still needs mild substrate darkening even though it "stays light".

---

## What is unresolved

Recorded rather than quietly resolved, because a taxonomy that hides its
disagreements is not a measurement.

**Source conflicts**

1. **Cosmos end-date versus vertical-sheen start.** Bulbapedia has cosmos running
   from Base Set 2 through Call of Legends as the standard holo; the reference
   footage has vertical sheen as the default "through Platinum, Call of Legends,
   Black & White and XY". These overlap across Diamond & Pearl, Platinum and
   HGSS. Best current reading: cosmos remained the standard-*set* holo into HGSS
   while vertical sheen took over reverses first and then standard holos. **The
   exact per-set boundary is contested**, and the assignment rows carry per-set
   citations and confidence rather than pretending otherwise.
2. **The "Pixel" name collision.** Bulbapedia's "Pixel" is this catalogue's
   `confetti`; this catalogue's `cosmos-ii-pixel` is a different pattern
   entirely. Both names are in circulation and neither is going away.
3. **Confetti's shape.** Bulbapedia describes blocky, square elements; the
   footage and the frames both show irregular flakes.

**Low-confidence entries**

- `disco` — **no true tilt demo exists at all.** The animation is inferred across
  cuts of prototype b-roll.
- `pokeball-hologram` — the multi-depth claim is narration-led; only medium
  confidence from stills.
- `prism` — only two frames demonstrate the BREAK tilt.
- `vstar-pearl` — the fine etch-glint behaviour is not resolvable in 360p
  footage.
- `gold-secret` — the per-era emboss differences are written-source claims; the
  available footage is all SWSH.
- Several types had their demo card or set misidentified by the vision pass.
  **Set ids from that source are treated as untrusted; the visual descriptions
  check out.**
- One residual described `detective-pikachu` as "thick shattered raised foil".
  No source supports "shattered" and the footage shows smooth beams. Recorded
  honestly as unverified collector anecdote rather than propagated.

**Implementation gaps**

- `big-glitter` has no faithful recipe.
- `sequin`, `tcg-classic`, `acid-wash` and `disco` have **no catalog exemplar** —
  no owned or catalogued card resolves to them — so they were built to corpus
  frames and verified by eye.
- The WOTC `window` scope cannot be expressed as a rectangle and is approximated
  by a luminance gate. This is the largest known error source in the corpus.
- A catalog gap, not a resolver bug: the catalog carries reverse variants for the
  first five EX sets only, so the entire late-EX reverse era is absent and
  `pinwheel` and `pokeball-hologram` can never resolve to a real card.

---

## Related

- [Shader Contract](Shader-Contract) — the uniform contract every recipe is written against
- [Provenance Model](Provenance-Model) — how a pattern assignment records *why* it was made
- [Pre-History](Pre-History) — the rounds in which most of this was argued out

_Last updated by Claude Fable 5 on behalf of @cheyras — 2026-08-31_
