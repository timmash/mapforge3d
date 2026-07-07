#!/usr/bin/env python3
"""
MapForge 3D — pre-bake building footprints for one council (LGA).

Downloads real building footprints for a council's area from Overture Maps
(open data: ODbL / CC BY 4.0), trims them to just geometry + height, and writes
a compact minified GeoJSON the web app can load. One metro council fits in a
single ~15-25 MB file — small enough to drag-and-drop onto GitHub.

WHY: OpenStreetMap doesn't have every house drawn in many suburbs (e.g. Ashwood).
Overture's buildings (which merge Microsoft's ML footprints + OSM) do.

------------------------------------------------------------------------------
ONE-TIME SETUP (Windows / Mac / Linux, needs Python 3.9+ and internet):

    pip install overturemaps

RUN (example: City of Monash, which contains Ashwood):

    python bake-council-buildings.py monash 145.06 -37.95 145.20 -37.85

  Arguments:  <name> <west> <south> <east> <north>
  - <name>  : short slug used for the output filename + the app's council list
  - bbox    : a generous lon/lat box AROUND the council (the app masks the
              buildings to the exact council boundary, so err on the LARGE side)

OUTPUT:  buildings/<name>.buildings.json   (minified FeatureCollection)

Then drag that file into the repo's  buildings/  folder on GitHub and commit.
The app auto-loads  buildings/<council>.buildings.json  when you pick that
council. Repeat for any other councils you want covered.
------------------------------------------------------------------------------
"""
import sys, os, json, subprocess, tempfile

def die(msg):
    print("ERROR:", msg); sys.exit(1)

def main():
    if len(sys.argv) != 6:
        die("usage: python bake-council-buildings.py <name> <west> <south> <east> <north>")
    name = sys.argv[1].strip().lower().replace(" ", "-")
    west, south, east, north = (float(x) for x in sys.argv[2:6])
    bbox = f"{west},{south},{east},{north}"

    raw = os.path.join(tempfile.gettempdir(), f"{name}_overture_raw.geojson")
    print(f"Downloading Overture buildings for {name} bbox {bbox} ...")
    print("(this can take a few minutes and a few hundred MB of transfer)")
    try:
        subprocess.run(
            ["overturemaps", "download", "--bbox=" + bbox,
             "-f", "geojson", "--type=building", "-o", raw],
            check=True,
        )
    except FileNotFoundError:
        die("`overturemaps` not found. Run:  pip install overturemaps")
    except subprocess.CalledProcessError as e:
        die(f"overturemaps download failed ({e}). Check your internet / bbox.")

    print("Trimming + minifying ...")
    with open(raw, "r", encoding="utf-8") as f:
        fc = json.load(f)

    out_features = []
    for ft in fc.get("features", []):
        geom = ft.get("geometry")
        if not geom or geom.get("type") not in ("Polygon", "MultiPolygon"):
            continue
        props = ft.get("properties", {}) or {}
        # Overture height field is "height" (metres); fall back to levels*3.2
        h = props.get("height")
        if h is None:
            lv = props.get("num_floors") or props.get("levels")
            if lv:
                try: h = round(float(lv) * 3.2 + 1.5, 1)
                except (TypeError, ValueError): h = None
        # round coordinates to ~0.1 m to shrink the file
        def round_ring(ring):
            return [[round(x, 6), round(y, 6)] for x, y in ring]
        if geom["type"] == "Polygon":
            g = {"type": "Polygon", "coordinates": [round_ring(r) for r in geom["coordinates"]]}
        else:
            g = {"type": "MultiPolygon",
                 "coordinates": [[round_ring(r) for r in poly] for poly in geom["coordinates"]]}
        p = {}
        if h is not None:
            try: p["h"] = round(float(h), 1)
            except (TypeError, ValueError): pass
        out_features.append({"type": "Feature", "properties": p, "geometry": g})

    os.makedirs("buildings", exist_ok=True)
    out_path = os.path.join("buildings", f"{name}.buildings.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": out_features},
                  f, separators=(",", ":"))

    mb = os.path.getsize(out_path) / 1e6
    print(f"\nDone: {out_path}")
    print(f"  {len(out_features):,} buildings, {mb:.1f} MB")
    if mb > 25:
        print("  NOTE: over 25 MB — too big for GitHub drag-drop. Use a tighter")
        print("        bbox, or split the council, or push with git instead.")
    try: os.remove(raw)
    except OSError: pass

if __name__ == "__main__":
    main()
