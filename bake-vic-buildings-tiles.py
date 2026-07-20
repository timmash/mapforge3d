#!/usr/bin/env python3
"""
MapForge 3D — bake statewide "gap-fill" building footprint tiles for Victoria.

Downloads building footprints from Overture Maps (theme=buildings, merges
Microsoft's ML building-footprint detections + OpenStreetMap), keeps ONLY the
ones Overture itself did NOT source from OpenStreetMap (checked via each
building's `sources` provenance field), and writes them out as a grid of small
GeoJSON tiles the app fetches on demand for whatever area is being generated —
in both Suburb and Custom mode.

WHY filter by source: OSM-sourced buildings would just duplicate what the app
already draws from live OSM data. Excluding them targets exactly the real
coverage gaps (Overture's Microsoft-ML-only buildings) and — as a big side
benefit — cuts the output from ~575MB (every VIC building) to ~370MB.

WHY tile + scope to localities: a bounding-box query against Overture's public
Parquet is NOT spatially prunable (the ~500MB-per-file shards aren't
geo-sorted — a single small-suburb query scans effectively the whole ~256GB
global dataset, ~76s in testing), so per-request live queries from the app
are not viable. Baking once, tiled into small static files, is. Tiles are
further scoped to a buffer around every named Victorian locality (own tile +
8 neighbours, ~16.5km x 16.5km per town) rather than the whole state, since
that's everywhere someone would realistically generate a model; remote
Custom-mode spots outside this scope just fall back to the existing
"unmapped buildings" address-node boxes.

At the app's live-generate step, tiles are also deduped against whatever OSM
already has AT THAT MOMENT (not just at this bake's Overture snapshot date),
so any building since added to OSM won't double-draw — see the footprint
check in buildBuildings() in app.js.

------------------------------------------------------------------------------
ONE-TIME SETUP (Python 3.9+, needs internet):

    pip install duckdb

RUN (from the repo root — takes several minutes, ~3-4GB of network transfer):

    python bake-vic-buildings-tiles.py

Re-run whenever you want to refresh against a newer Overture release (pass
--release to pin one, e.g. --release 2026-06-17.0 — omit to auto-detect the
latest available in the public bucket).

OUTPUT:  buildings-tiles/<tx>_<ty>.json   (one minified FeatureCollection per
         0.05-degree tile; only non-empty tiles are written)

The app computes which tile(s) a generate's bounding box needs and fetches
them directly — no manifest file, no per-suburb setup. A missing tile (404)
just means "no gap-fill data here", same as areas outside the baked scope.
------------------------------------------------------------------------------
"""
import sys, os, io, csv, json, math, argparse, urllib.request

TILE_DEG = 0.05
BUFFER_TILES = 1  # each locality's own tile + this many neighbours in every direction
BUCKET = "https://overturemaps-us-west-2.s3.amazonaws.com"
POSTCODES_CSV_URL = "https://raw.githubusercontent.com/matthewproctor/australianpostcodes/master/australian_postcodes.csv"
VIC_BBOX = (140.8, -39.3, 150.1, -33.8)  # west, south, east, north — matches app.js's Nominatim viewbox


def die(msg):
    print("ERROR:", msg); sys.exit(1)


def latest_release():
    import xml.etree.ElementTree as ET
    url = f"{BUCKET}/?list-type=2&delimiter=/&prefix=release/"
    with urllib.request.urlopen(url, timeout=30) as r:
        xml = r.read()
    ns = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
    root = ET.fromstring(xml)
    prefixes = [p.find("s3:Prefix", ns).text for p in root.findall("s3:CommonPrefixes", ns)]
    releases = sorted(p.split("/")[1] for p in prefixes if p.startswith("release/"))
    if not releases:
        die("couldn't find any Overture release in the bucket listing")
    return releases[-1]


def kept_tiles():
    print("Downloading Victorian locality list for scoping...")
    with urllib.request.urlopen(POSTCODES_CSV_URL, timeout=60) as r:
        text = r.read().decode("utf-8")
    reader = csv.DictReader(io.StringIO(text))
    kept = set()
    n = 0
    for row in reader:
        if row.get("state") != "VIC" or row.get("type") != "Delivery Area":
            continue
        try:
            lon, lat = float(row["long"]), float(row["lat"])
        except (TypeError, ValueError):
            continue
        tx, ty = math.floor(lon / TILE_DEG), math.floor(lat / TILE_DEG)
        for dx in range(-BUFFER_TILES, BUFFER_TILES + 1):
            for dy in range(-BUFFER_TILES, BUFFER_TILES + 1):
                kept.add((tx + dx, ty + dy))
        n += 1
    print(f"  {n} localities -> {len(kept)} scoped tiles (~{len(kept) * (TILE_DEG*111.32)**2:.0f} sq km)")
    return kept


def strip_closing_dup(ring):
    return ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring


def clean_geometry(geom):
    if geom["type"] == "Polygon":
        geom["coordinates"] = [strip_closing_dup(r) for r in geom["coordinates"]]
    elif geom["type"] == "MultiPolygon":
        geom["coordinates"] = [[strip_closing_dup(r) for r in poly] for poly in geom["coordinates"]]
    return geom


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--release", help="pin an Overture release (default: auto-detect latest)")
    ap.add_argument("--out", default="buildings-tiles", help="output directory")
    args = ap.parse_args()

    try:
        import duckdb
    except ImportError:
        die("`duckdb` not found. Run:  pip install duckdb")

    release = args.release or latest_release()
    print(f"Using Overture release: {release}")

    kept = kept_tiles()

    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute("SET s3_region='us-west-2';")
    con.execute("PRAGMA threads=16;")
    con.execute("CREATE TABLE kt(tx INTEGER, ty INTEGER)")
    con.executemany("INSERT INTO kt VALUES (?, ?)", list(kept))

    w, s, e, n = VIC_BBOX
    print("Querying Overture buildings for Victoria (non-OSM-sourced only)."
          " This scans most of the global dataset — several minutes, no shortcuts available.")
    rows = con.execute(f"""
        SELECT floor(b.bbox.xmin/{TILE_DEG})::INTEGER AS tx, floor(b.bbox.ymin/{TILE_DEG})::INTEGER AS ty,
               b.height, b.num_floors,
               ST_AsGeoJSON(ST_ReducePrecision(b.geometry, 0.00001)) AS geom_json
        FROM read_parquet('s3://overturemaps-us-west-2/release/{release}/theme=buildings/type=building/*',
                           hive_partitioning=1) b
        JOIN kt k ON floor(b.bbox.xmin/{TILE_DEG})::INTEGER = k.tx
                  AND floor(b.bbox.ymin/{TILE_DEG})::INTEGER = k.ty
        WHERE b.bbox.xmin <= {e} AND b.bbox.xmax >= {w}
          AND b.bbox.ymin <= {n} AND b.bbox.ymax >= {s}
          AND len(list_filter(b.sources, x -> x.dataset = 'OpenStreetMap')) = 0
    """).fetchall()
    print(f"  {len(rows)} gap-fill buildings found")

    tiles = {}
    for tx, ty, height, num_floors, geom_json in rows:
        geom = json.loads(geom_json)
        if not geom or not geom.get("coordinates"):
            continue
        geom = clean_geometry(geom)
        h = height
        if h is None and num_floors:
            h = round(num_floors * 3.2 + 1.5, 1)
        props = {"h": round(float(h), 1)} if h is not None else {}
        tiles.setdefault((tx, ty), []).append({"type": "Feature", "properties": props, "geometry": geom})

    os.makedirs(args.out, exist_ok=True)
    # clear stale tiles from a previous run so removed/renamed cells don't linger
    for f in os.listdir(args.out):
        if f.endswith(".json"):
            os.remove(os.path.join(args.out, f))
    total = 0
    for (tx, ty), feats in tiles.items():
        out = json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":"))
        with open(os.path.join(args.out, f"{tx}_{ty}.json"), "w", encoding="utf-8") as f:
            f.write(out)
        total += len(out)

    print(f"\nDone: {len(tiles)} tile files in {args.out}/, {total/1e6:.1f} MB total")
    print("Commit these with git normally (they're plain small JSON files, no LFS needed).")


if __name__ == "__main__":
    main()
