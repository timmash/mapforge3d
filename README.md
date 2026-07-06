# MapForge 3D

Generate 3D models of any real place on Earth — buildings, terrain, roads and water — and export them for Blender, Rhino, SketchUp or 3D printing.

**Live app:** enable GitHub Pages on this repo and open the URL it gives you.

## How it works

Everything runs in your browser — there is no backend.

1. Search for a place (or pan the map) and pick an area size (250 m – 2 km).
2. **Generate** fetches building footprints, roads and water from [OpenStreetMap](https://www.openstreetmap.org) via the Overpass API, and real elevation from the open [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) dataset on AWS.
3. The model is built with [three.js](https://threejs.org): a solid terrain block with a plinth, extruded buildings (real heights where OSM has them), road ribbons draped on the terrain, green space, and water surfaces. Every layer is clipped exactly to the selection boundary.
4. Each layer has an inspector (click its name): colour, metallic and roughness apply instantly; building default/extra/minimum height, height scale and ground fit, road width scale and lift, terrain vertical exaggeration and level of detail, and base depth all rebuild the model live from cached data — no refetch needed.
5. Export as:
   - **.GLB** (binary glTF) — real-world metres; opens in Blender, and most modern 3D tools
   - **.STL** — pre-scaled to 200 mm across, ready for a 3D-printer slicer
   - **.OBJ** — universally supported (Rhino, SketchUp Pro, Maya, …)

## Running locally

Serve the folder with any static server, e.g.:

```
python -m http.server 8000
```

then open http://localhost:8000 — opening `index.html` directly from disk won't work because ES modules require HTTP.

## Data & licences

- Map data © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright). Models you generate from it inherit ODbL attribution requirements.
- Elevation: Terrain Tiles on AWS (Mapzen terrarium tiles) — see the [dataset licence](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).
- Basemap style © [CARTO](https://carto.com/attributions), tiles © OpenStreetMap contributors.
- Geocoding by [Nominatim](https://nominatim.org) (please keep usage light — it's a free community service).
- This app's code: MIT licence.
