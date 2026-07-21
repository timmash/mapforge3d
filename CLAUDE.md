# MapForge 3D — project guide

Original, single-page web app that turns a real place into a 3D model from
OpenStreetMap data (buildings, terrain, roads, water, green space), inspired by
halfmaps.io/3d-map-exporter but an independent implementation on open data.

- **Live:** https://timmash.github.io/mapforge3d/  (GitHub Pages)
- **Repo:** https://github.com/timmash/mapforge3d  (branch `main`, served from repo root)
- **This folder** is a git clone of that repo. Deploy = commit + `git push origin main`.
- **Current version: 1.045** (shown as a badge in the header).

## Files
- `app.js` — the entire app (one ES module, ~2500 lines). All logic lives here.
- `index.html` — markup + CSS + import map; loads `app.js` as `<script type="module">`.
- `README.md` — public-facing repo readme (GitHub landing page). Somewhat stale re:
  suburb/circle modes and colour-3MF export — update alongside major feature work.
- `bake-vic-buildings-tiles.py` — bakes statewide "gap-fill" building footprints from
  **Overture Maps** (merges Microsoft's ML building-footprint detections + OSM), keeping
  only buildings Overture did NOT source from OSM (checked via each building's `sources`
  provenance — see the script's docstring for why: live per-request Overture queries
  aren't viable, ~76s+ for even a tiny bbox since the public Parquet isn't spatially
  sorted). Writes `buildings-tiles/<tx>_<ty>.json`, a 0.05° grid scoped to a buffer around
  every named locality (~370MB, ~4,200 tiles). The app fetches whichever tiles cover the
  current bbox — Suburb AND Custom mode, no manifest, no per-suburb setup — and merges
  them in via `buildBuildings()`'s `extraPolys`, deduping anything that overlaps a
  *currently* OSM-mapped footprint (OSM keeps getting edited after Overture's snapshot).
  This is the answer to "how do I get more accurate outlines than OSM alone." Requires
  `pip install duckdb`; run locally, not part of the live app; re-run occasionally against
  newer Overture releases (auto-detects latest).
- `bake-council-buildings.py` — superseded by the above (same Overture source, but baked
  one suburb at a time into `buildings/<slug>.buildings.json`, and didn't filter out
  OSM-sourced buildings — would double-draw in well-mapped areas). Kept for reference.
- `index_standalone.html` — a single-file build (index.html with app.js inlined) for
  double-click local preview. Gitignored / not committed (regenerate locally, see below).
- `.gitignore`, `todo.txt`, `COMMIT_MSG.txt` (legacy, see below).

Only `app.js` and `index.html` are the deployable app. GitHub Pages serves them directly.

## No build step
Pure CDN: three.js 0.160 (+ addons), MapLibre GL 4.7.1, polygon-clipping, jspdf,
fflate — all via import map / esm.sh. To preview: regenerate and open
`index_standalone.html` (see below), or `python -m http.server` in this folder and open
index.html.

After editing `app.js`/`index.html`, rebuild the standalone:
```
python - <<'PY'
h=open('index.html').read();a=open('app.js').read()
t='<script type="module" src="app.js"></script>'
open('index_standalone.html','w').write(h.replace(t,'<script type="module">\n'+a+'\n</script>'))
PY
```
And sanity-check syntax: `node --check app.js`.

## Conventions (please keep)
- **Version badge:** every change that edits app.js or index.html must bump the version
  by 0.001 in index.html's `<h1>` (`<span class="ver">vX.YYY</span>`), then rebuild the
  standalone. Don't bump for non-file/chat-only turns.
- British English, metric units (user preference).
- Commit messages: short title line (include the version, e.g. "v1.037: …") + a few
  bullet points. (The old Cowork workflow wrote these into COMMIT_MSG.txt for a local
  auto-push watcher; in Claude Code just commit + push directly and COMMIT_MSG.txt is
  no longer needed — it and the *-autopush.* scripts can be deleted.)

## Architecture quick-map (all in app.js)
- **cfg** object = every layer's live settings; **MATS** = one MeshStandardMaterial per
  coloured layer. **INSPECTOR** array drives the sidebar layer UI (accordion; items can
  target another cfg key via a trailing `{ck:'base'}`; a layer can co-toggle siblings via
  `toggleAlso`; group subtitles via `group`).
- **Modes:** top toggle Suburb (searchable combobox of ~3,300 Victorian localities, derived
  from the matthewproctor/australianpostcodes VIC "Delivery Area" rows, title-cased with a
  couple of manual fixups for Mc-names/depot artifacts; Nominatim boundary, viewbox-bounded
  to all of Victoria, MAX_SPAN_KM=35 guards against a wrong match) vs Custom (address search
  + Square/Circle shape + area size). state.uiMode /
  state.council / state.mode('suburb'|'square') / state.areaShape('square'|'circle').
  Internal misnomer: "council" == the selected suburb; state.mode stays 'square' for both
  Custom shapes. Circle reuses the whole suburb-mask pipeline: `circleRing()` builds a
  96-gon and is dropped straight into `EXT.mask`, so terrain shaping and
  building/road/water clipping need no shape-specific code at all.
- **Data:** Overpass (buildings/roads/water/green + address nodes + waterway lines),
  AWS terrarium elevation tiles, Nominatim geocode/boundary. 30-day Cache Storage cache
  with a Clear-cache button.
- **Geometry:** roads & waterways = draped ribbon tubes (already closed tubes, incl. end
  caps); terrain, base block, water, green, and buildings (mapped footprints + unmapped
  address-node boxes, all merged into one mesh) are built with `closedDrapedSolid()` /
  `appendClosedSolid()` — top + bottom + boundary walls sharing one vertex set, watertight
  regardless of input triangulation quality. Deliberately NOT `THREE.BoxGeometry`/
  `ExtrudeGeometry` for anything printable — both duplicate a vertex per face (fine for
  shading, but not index-shared, so Bambu's 3MF checker flags them as open edges even though
  they look solid). Suburb mode clips everything to the boundary (polygon-clipping,
  split-at-line).
- **A3 backing map:** greyscale flat map on an A3 sheet (297×420mm), 3D model centred in the
  lower two-thirds at 1:1; preview-only + PDF export. Constants A3_W/A3_H/MODEL_PRINT_MM(200)/
  MODEL_CX_MM/MODEL_CY_MM. Optional big title (none/postcode/suburb/custom — free text up to
  30 chars via `cfg.backing.customTitle`, defaults to "custom" on entering Custom mode since
  there's no suburb name), matched flat + 3D via a shared font layout, all funnelled through
  `backingTitleText()` so both renders always agree. "Frame" and "Environment" (floor) layers
  are preview-only decoration.
- **Inspector `showWhen`:** an item's trailing options object can carry
  `showWhen: [prop, value]` to only display that row while a sibling item (e.g. Title) holds
  that value — see `customTitle`. `buildInspectorUI()` gives every `select` a
  `ctl_<ck>_<prop>` id and calls `refreshShowWhen()` on change; set a value programmatically
  by updating `cfg` then dispatching a `change` event on that id (see `setMode()`'s
  Custom-mode default) rather than writing `cfg` directly, or the dropdown and dependent rows
  drift out of sync with it.
- **Exports:** colour 3MF (one named+coloured object per layer, for Bambu), STL/OBJ/GLB,
  A3 PDF, separate 3D-title 3MF. Reached via the floating "Download" button on the 3D view.
  The 3MF's colour is **Face Coloring** (3MF Materials and Properties Extension:
  `<m:colorgroup>` + per-triangle `pid`/`p1`), NOT `basematerials`/object-level `pid` —
  Bambu Studio's "Standard 3MF" importer only recognises Vertex or Face Coloring for
  third-party files, so an object-level default colour silently doesn't carry through.
  See `writeColour3MF()`.
- **Filaments:** a top "Filaments" section holds up to 5 real Bambu colours
  (`state.filaments`, `FILAMENT_TYPES` — official hex tables per type, except PETG
  Translucent which Bambu doesn't publish one for, so those are estimated from product
  photos). Every layer's colour control is a swatch button restricted to picking from
  those 5 (`createLayerColorButton()`), not a free colour picker — so the exported
  face colour is always an exact filament hex, letting Bambu Studio's colour-matching
  land on a zero-delta match.

## Gotchas (learned the hard way)
- **Module-init order / TDZ:** app.js is one module evaluated top-to-bottom. Any top-level
  CALL (`loadTitleFont()` preload, `$('id').addEventListener`, `buildInspectorUI()`) that
  reads a `let`/`const` must appear AFTER that declaration, or you get
  "Cannot access 'X' before initialization" at load — which then surfaces as a confusing
  error inside generate(). Keep shared vars (A3_*/MODEL_*/_titleFont) declared near the top;
  null-safe top-level DOM wiring with `$('id')?.addEventListener`.
- **Watertight geometry (Bambu "open edges"):** everything solid (terrain, base, water,
  green, buildings) is built with `closedDrapedSolid()` / `appendClosedSolid()` — top +
  bottom + boundary walls sharing one vertex set, derived from actual triangle adjacency so
  it's manifold no matter how messy the input polygon is (self-touching rings, sliver clips,
  etc). Terrain is a thin `TERRAIN_SKIN`-thick colour layer that extrudes DOWNWARD from the
  draped surface (surface → surface-ε), NOT upward — extruding upward buries the
  buildings/roads (that mistake was v1.035, reverted in v1.036). The base block is the full
  depth (surface → cfg.base.depth), independently watertight and deliberately overlapping the
  terrain skin by `TERRAIN_SKIN` so there's never a gap. No export-time vertex welding needed
  — each object is closed by construction. Road/waterway ribbons were already closed tubes.
  **Bambu's 3MF checker is index-based, not position-based**: it does NOT weld coincident
  vertices before checking, so `THREE.BoxGeometry`/`ExtrudeGeometry` — which duplicate a
  vertex per face for flat shading — read as full of open edges even though every corner is
  spatially closed. This bit the unmapped-building address-node boxes in v1.038 (fixed in
  v1.039: rebuilt via `appendClosedSolid()`, merged into the same mesh as mapped buildings).
  Any new printable geometry must share vertex indices explicitly — don't rely on a slicer to
  weld by position for you.
- Gap-fill building footprints (`buildings-tiles/*.json`, see `bake-vic-buildings-tiles.py`)
  load automatically for whatever bbox is being generated, both Suburb and Custom mode —
  no per-suburb setup needed. A missing tile (404) just means no gap-fill data for that
  area (outside the baked locality scope, or OSM/Overture both have nothing there); the
  "Unmapped buildings" address-node boxes are the last-resort fallback under that.

## Deploy from Claude Code
```
node --check app.js
# rebuild standalone (snippet above)
git add -A && git commit -m "v1.0XX: <summary>" && git push origin main
```
GitHub Pages redeploys automatically. Confirm the version badge on the live site updates.
