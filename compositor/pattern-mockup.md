# pattern-mockup.html

Dev tool: tile a pattern image onto garment mockups (flatlay + on-model) in the browser. Single-file HTML, no build, no server. Sister file [`zum_prd_form.html`](zum_prd_form.html) is the production form; both share one byte-identical compositor engine (see [Shared block](#shared-block)).

## What it does

Pick a garment, load a pattern PNG/JPG/WebP, pick a trim colour, set motif size → **Generate** composites the pattern into every fabric panel of each view and renders the shots. **Download PNGs** saves them.

Nothing hits the network except loading the mock photos + panel maps from the Shopify CDN.

## UI controls

| Control | Effect |
|---|---|
| **Garment** | `romper` / `pajama` / `menPajama` / `womenPajama`. Selects the `GARMENTS` entry. |
| **Pattern file** | The tile image. Decoded once; feeds swatch scan + every compose. |
| **Trim color** | Colour picker + hex box. Empty → keep the mock's own trim. Auto-filled from the pattern's dominant hue on load. |
| **Gender** | boy / girl / neutral. Filters which model photos show. Auto-derived from trim hue until the user picks manually. Disabled+greyed for men/women pajama (all models unisex). |
| **Motif size** | 0.5×–2× slider, multiplies each view's `r`. |
| **Generate / Download PNGs** | Compose + render, then export. |

## Garment data (page-local)

`GARMENTS`, the `V()` helper, `FLAT_KEYS`, `CDN`, and the model-pick helpers live in the `// ===== GARMENT DATA =====` block, **not** the shared block. This dev tool lists more garments (second pajama flatlay + men/women pajama) than the production form, which keeps romper + kids pajama only.

Structure:

```js
garment: { flats:[ V(mock, map, r), ... ], models:[ V(mock, map, r), ... ] }
```

- `flats` = flatlay view(s); `models` = on-model photos.
- `V(mock, map, r)` → `{ mock: CDN+mock, map: CDN+map, r }`.
- **`mock`** = original photo. **`map`** = panel map (traced on the photo pixels via SAM + colour threshold, so it aligns exactly). Both on the Shopify CDN with `?v=` cache-bust.
- **`r`** = pattern raster width as a fraction of the mock width (`pattern px = r × mock W`), multiplied by the slider. Within a garment, `r` keeps checks-per-chest equal across views (scales with the top's torso width on the map). Derive new ones with `python motif-r.py --ref <map with known r> --ref-r <its r> <new maps...>`.
- Filename gender: `-boy-` / `-girl-` in the model name → that gender; else unisex (`null`). `modelsFor(g, sel)`: neutral → all; boy/girl → that gender + unisex.

## Compose pipeline (per view)

1. `analyzeGarment(spec, model)` — one pass over the map, cached (LRU 6). Yields: panel id per pixel, garment + per-panel bbox, per-panel centroid + grain angle (PCA or drawn axis), curved limb axes (drawn strokes), fan frames (blue corner dots), perspective quads (cyan corner dots), fabric white `Fref` (p95 per channel), and the edge coverage `cov` / edge panel `eid` for every panel incl. the trim.
2. `compose(G, pat, ratio, trim, opt)` — raster the pattern to `ratio × mockW`; build the fold-displacement field (box blur of the mock luminance, `DISP_BLUR` 8 px) over the garment box; for each fabric pixel, shift the sample point along the luminance gradient (up to `DISP_AMP` 12 px, print compressed on fold flanks), map it through the panel's local frame (fan / curved axis / rotation), bilinear-sample the tile, multiply by `mock/Fref`, keep the mock for the non-fabric share of an edge pixel (coverage `cov` measured in `analyzeGarment` from a smoothed raster of the map: R / (id×20) where the 3×3 neighbourhood touches id 0; inside the fabric coverage is exactly 1, so no halo next to a white cord or a hand); the trim (id 9) goes through the same path with the flat trim colour as its "print"; downscale by `SS`. `opt` is optional: `{quads:false}` ignores the map's cyan dots, `{showQuad:true}` draws them (v2 page). Returns a canvas.

### Map encoding

Red channel `/ 20` → panel id:
- `0` = background (incl. skin/hair)
- `1..8` = fabric panels
- `9` = trim
- `6` = collar inside (wrong side of a one-sided print): mirrored + faint bleed-through. Model maps never use id 6.
- **Green channel `≥ AXIS_MIN` (250), blue off** = a hand-drawn grain axis for the panel under it (R still carries the id). A straight stroke sets the panel's grain angle; a stroke that bends (`curve ≥ AX_CURVE`) becomes a curved limb axis: the frame's normal is interpolated continuously along the stroke (swept frame, no sawtooth at the joints), its rotation capped so the bend radius stays ≥ `AX_RMIN` (2) × the local half-width (no fan on a tight hip), held fixed past the stroke's ends. Model views add the tube-wrap (`v` compressed toward a silhouette edge). Draw the stroke the full length of the limb. Strokes baked offline in `zum-prd/prompt-test/model-map`.
- **Blue channel `≥ 250`, green off** = a fan corner dot. Four such dots on one panel (TL/TR on the top edge, BL/BR on the bottom) turn it into a fan: centre = where the side edges meet, tile x = arc length at the top radius, tile y = radius (a skirt). A fan replaces the panel's axis / rotation.
- **Green + blue `≥ 250`** = a perspective corner dot. Four on one panel → a homography maps the panel onto a flat rectangle (the wide end keeps the flat motif size). No production map has them yet; the v2 page's twirl-dress test map does.

The map must be fetched as **PNG** (`loadPng`), never let the CDN serve WebP — 4:2:0 chroma subsampling bleeds sharp id edges and corrupts panel ids.

### Trim rendering

Since 2026-09-17 the trim has no rules of its own. Every mock's trim was re-shot as the same plain white fabric as the body (the coloured rib trim erased offline, see the `image gen` project), so the chosen trim colour is simply multiplied by `mock/Fref` like the print on a fabric panel, with the same sub-pixel edge coverage. An edge pixel touching fabric and trim samples the fabric (the print reaches the seam); only a pixel touching trim alone takes the trim colour. Trim colour empty → the mock's own (white) trim stays. The old `Lref` / low-pass `tlo` / knee / floor / ceiling machinery, built for coloured glossy rib, is gone.

### Key constants

`OUT_AREA` ~1900px wide · `SS` 1.3 supersample · `OFFX`/`OFFY` per-panel tile phase (seam decorrelation) · `DISP_AMP` 12 / `DISP_BLUR` 8 / `DISP_GREF` 3 fold displacement · `AX_RMIN` 2 curved-axis fold guard. Edge softness has no constant: it is the map's own sub-pixel coverage.

## Pipeline vs Photoshop

Every step in run order, with the closest Photoshop operation. Three steps have no direct equivalent (3, 8, 12), which is why the engine cannot be rebuilt as an action / PSD. (Updated 2026-09-17 for the trim-as-panel engine; the old rows 13–14 with `Lref` / frequency separation are gone.)

| # | Engine step | Photoshop equivalent | Difference |
|---|---|---|---|
| 1 | Raster the mock at `OUT_AREA × SS²` (SS 1.3) | Image Size up before working, back down at the end | Edge anti-aliasing only, not a sharpen |
| 2 | Read the map PNG: R/20 = panel id (9 = trim), G ≥ 250 = grain stroke, B ≥ 250 = fan corner dot, G+B ≥ 250 = perspective corner dot | One layer mask / selection per panel (Color Range on the map); strokes and dots = Warp / Puppet Warp anchors | PS has no 3-channel map: every mask is drawn by hand |
| 3 | PCA per panel → grain angle | Free Transform > Rotate on that panel's pattern layer | PS picks the angle by eye; the engine derives it from the panel shape or a straight G stroke |
| 4 | Bent G stroke → curved axis (u along the stroke, v across), `AX_RMIN` fold guard, tube wrap on model views | Puppet Warp, or Warp (Arc / Custom) on the pattern layer | The engine keeps the print continuous along the axis; PS warp ripples at the joints |
| 5 | Four blue dots → fan (x = arc length, y = radius); four cyan dots → homography onto a flat rectangle | Filter > Distort > Polar Coordinates, or Warp > Arc; Free Transform > Distort / Perspective | Skirts; a panel seen at an angle |
| 6 | `Fref` = p95 fabric white per channel | Levels: "Set White Point" eyedropper on the brightest fabric | Normalises the mock to white before Multiply, so a warm/pink photo does not tint the print |
| 7 | Raster the pattern at `r × W`, per-panel phase `OFFX`/`OFFY` | Define Pattern + Pattern Overlay (Scale); phase = move the pattern layer | The engine also shifts the phase so a tile boundary lands outside a panel smaller than one tile |
| 8 | Displace along the **gradient** of the mock luminance blurred 8 px, up to 12 px | Filter > Distort > Displace with a map = mock desaturated + Gaussian Blur 8 | PS Displace shifts by the luminance **value**; the engine shifts by its **slope**, because a value-driven shift slid the whole print diagonally |
| 9 | Bilinear sample | Bilinear / Bicubic interpolation in Transform | — |
| 10 | Collar id 6: mirror + `×0.4 + 126` | Flip Horizontal + ~40 % opacity over 50 % grey | Wrong side of a one-sided print, flatlay only |
| 11 | Tone: `print × mock/Fref`, capped at 1 | Blend mode **Multiply** (after the Levels in step 6) | Multiply only, nothing else |
| 12 | Soft edge: blend the mock in by `cov` read from the smoothed map raster, only where a pixel touches background / skin (fabric and trim alike) | Anti-aliased mask, **no** Feather | A feathered / blurred mask caused a bright rim next to a white cord; dropped |
| 13 | Trim: chosen colour × `mock/Fref`, same edge coverage as a fabric panel | Solid Color fill layer, Multiply, clipped to the trim mask (after the Levels in step 6) | Works because the mock's trim is now the same white fabric as the body; no Levels / Curves on the trim any more |
| 14 | Downscale to `W/SS` | Image Size down, Bicubic | — |

Measured and dropped on 2026-09-16: a Photoshop-style shadow layer (Linear Burn 0.25) and a high-pass Soft Light 0.8. They moved 6–13 levels in the folds and 2 levels for the Soft Light, invisible at normal size, so tone stays a plain Multiply.

## Shared block

Between `// ===== SHARED BLOCK` and `// ===== END SHARED BLOCK =====` is the compositor engine, **byte-identical** in this file and `zum_prd_form.html`.

- Edit the engine **only here** → `.\sync-shared.ps1 -Push` copies it into the form → commit **both files**.
- `.\sync-shared.ps1` (no flag) diffs the two copies, exit 1 if they differ. Run before committing either file.
- The block never touches the DOM or page state: it reads images and returns pixels.
- Page-local UI (controls, generate loop, download) lives after `// ===== END SHARED BLOCK =====`.

## Verify

Do not screenshot / self-test in the preview — the preview auto-refreshes on the user's machine.

- Refactor with no intended output change: `node regress-engine.js run <page> before.json` on the committed version → edit → `run ... after.json` → `compare before.json after.json` must print `IDENTICAL`. Baseline for the current engine: commit `3d15218`.
- Render a shot to inspect: `node regress-engine.js render <page> <outdir> [key] [overrides.json]`.

## Related files

- [`zum_prd_form.html`](zum_prd_form.html) — production form, same engine.
- [`pattern-mockup-v2.html`](pattern-mockup-v2.html) — testing page: this engine + perspective homography from cyan corner dots; renders production and testing side by side. **Not** synced, copy engine edits by hand.
- [`sync-shared.ps1`](sync-shared.ps1) · [`regress-engine.js`](regress-engine.js) · [`motif-r.py`](motif-r.py)
