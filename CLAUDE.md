# MapForge 3D — project guide

Original, single-page web app that turns a real place into a 3D model from
OpenStreetMap data (buildings, terrain, roads, water, green space), inspired by
halfmaps.io/3d-map-exporter but an independent implementation on open data.

- **Live:** https://timmash.github.io/mapforge3d/  (GitHub Pages)
- **Repo:** https://github.com/timmash/mapforge3d  (branch `main`, served from repo root)
- **This folder** is a git clone of that repo. Deploy = commit + `git push origin main`.
- **Current version: 1.036** (shown as a badge in the header).

## Files
- `app.js` — the entire app (one ES module, ~2500 lines). All logic lives here.
- `index.html` — markup + CSS + import map; loads `app.js` as `<script type="module">`.
- `index_standalone.html` — a single-file build (index.html with app.js inlined) for
  double-click local preview. REGENERATE it after any change (see below). Not deployed.
- `.gitignore`, `todo.txt`, `COMMIT_MSG.txt` (legacy, see below).

Only `app.js` and `index.html` are the deployable app. GitHub Pages serves them directly.

## No build step
Pure CDN: three.js 0.160 (+ addons), MapLibre GL 4.7.1, polygon-clipping, jspdf,
fflate — all via import map / esm.sh. To preview: open `index_standalone.html`, or
`python -m http.server` in this folder and open index.html.

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
- **Modes:** top toggle Suburb (searchable combobox of 222 Melbourne suburbs; Nominatim
  boundary) vs Custom (address search + area size square). state.uiMode / state.council /
  state.mode('suburb'|'square'). Internal misnomer: "council" == the selected suburb.
- **Data:** Overpass (buildings/roads/water/green + address nodes + waterway lines),
  AWS terrarium elevation tiles, Nominatim geocode/boundary. 30-day Cache Storage cache
  with a Clear-cache button.
- **Geometry:** terrain draped grid/slab; roads & waterways = draped ribbon tubes; water &
  green = `closedDrapedSolid()` watertight slabs; buildings = ExtrudeGeometry + address-node
  boxes. Suburb mode clips everything to the boundary (polygon-clipping, split-at-line).
- **A3 backing map:** greyscale flat map on an A3 sheet (297×420mm), 3D model centred in the
  lower two-thirds at 1:1; preview-only + PDF export. Constants A3_W/A3_H/MODEL_PRINT_MM(200)/
  MODEL_CX_MM/MODEL_CY_MM. Optional big title (suburb/postcode), matched flat + 3D via a shared
  font layout. "Frame" and "Environment" (floor) layers are preview-only decoration.
- **Exports:** colour 3MF (one named+coloured object per layer, for Bambu), STL/OBJ/GLB,
  A3 PDF, separate 3D-title 3MF. Reached via the floating "Download" button on the 3D view.

## Gotchas (learned the hard way)
- **Module-init order / TDZ:** app.js is one module evaluated top-to-bottom. Any top-level
  CALL (`loadTitleFont()` preload, `$('id').addEventListener`, `buildInspectorUI()`) that
  reads a `let`/`const` must appear AFTER that declaration, or you get
  "Cannot access 'X' before initialization" at load — which then surfaces as a confusing
  error inside generate(). Keep shared vars (A3_*/MODEL_*/_titleFont) declared near the top;
  null-safe top-level DOM wiring with `$('id')?.addEventListener`.
- **Watertight geometry (Bambu "open edges"):** water/green use `closedDrapedSolid()` (top +
  underside + boundary walls sharing one vertex set — verified manifold). Buildings, node
  boxes, roads and the terrain still export with open edges. To fix terrain, build a base
  block (surface top → flat bottom) plus a terrain-colour cap that extrudes DOWNWARD from the
  surface (surface → surface-ε), NOT upward — extruding upward buries the buildings/roads
  (that mistake was v1.035, reverted in v1.036). Weld other objects with
  BufferGeometryUtils.mergeVertices (position-only) at export.
- Pre-baked real building footprints per suburb load from `buildings/<slug>.buildings.json`
  if present (see bake script referenced in git history); OSM covers many suburbs already.

## Deploy from Claude Code
```
node --check app.js
# rebuild standalone (snippet above)
git add -A && git commit -m "v1.0XX: <summary>" && git push origin main
```
GitHub Pages redeploys automatically. Confirm the version badge on the live site updates.
