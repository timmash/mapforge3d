// MapForge 3D — generate 3D models of real places from OpenStreetMap data.
// Original implementation. Data: © OpenStreetMap contributors (ODbL);
// elevation: Terrain Tiles on AWS (Mapzen terrarium encoding).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import polygonClipping from 'https://esm.sh/polygon-clipping@0.15.7';
import { jsPDF } from 'https://esm.sh/jspdf@2.5.1';
import { zipSync, strToU8 } from 'https://esm.sh/fflate@0.8.2';

/* ============================================================ state & layer config */

const state = {
  sizeMeters: null,  // side length of the selection square (null = nothing chosen yet)
  model: null,       // THREE.Group of the last generated model
  modelName: 'queens-parade-ashwood',
  last: null,        // cached fetch: {bbox, elements, sampleElev, minElev}
  mode: 'square',    // 'square' | 'suburb'
  council: null,     // selected area: { name, slug, bbox, maskRings } when mode==='suburb'
  uiMode: 'suburb',  // top toggle: 'suburb' | 'custom'
  baseData: null,    // cached inputs for rebuilding the backing map: {bbox, elements, prebaked, M}
  placeLabels: null, // { suburb, postcode } for the backing-map title (best-effort)
  frame: null,       // THREE.Group of the decorative frame (preview only)
  backdrop: null,    // THREE.Group of the backdrop wall/floor (preview only)
  titleObj: null,    // THREE.Mesh of the raised 3D title (preview + separate export)
  maxGround: 0,      // highest terrain elevation of the map, relative metres
};

// Greater-Melbourne suburbs. The slug matches the optional pre-baked footprints
// file the app looks for: buildings/<slug>.buildings.json
const SUBURBS = [
  'Abbotsford','Aberfeldie','Airport West','Albert Park','Alphington','Altona','Altona Meadows','Altona North',
  'Armadale','Ascot Vale','Ashburton','Ashwood','Aspendale','Attwood','Avondale Heights','Balaclava','Balwyn',
  'Balwyn North','Bayswater','Beaumaris','Bellfield','Bentleigh','Bentleigh East','Berwick','Blackburn',
  'Blackburn North','Blackburn South','Bonbeach','Boronia','Botanic Ridge','Box Hill','Box Hill North',
  'Box Hill South','Braybrook','Brighton','Brighton East','Broadmeadows','Brooklyn','Brunswick','Brunswick East',
  'Brunswick West','Bulleen','Bundoora','Burnley','Burwood','Burwood East','Cairnlea','Camberwell','Canterbury',
  'Carlton','Carlton North','Carnegie','Caroline Springs','Carrum','Caulfield','Caulfield East','Caulfield North',
  'Caulfield South','Chadstone','Cheltenham','Chelsea','Clayton','Clayton South','Clifton Hill','Coburg',
  'Coburg North','Collingwood','Craigieburn','Cranbourne','Cremorne','Croydon','Dandenong','Dandenong North',
  'Deer Park','Diamond Creek','Dingley Village','Docklands','Doncaster','Doncaster East','Donvale','Eaglemont',
  'East Melbourne','Edithvale','Elsternwick','Eltham','Elwood','Emerald','Endeavour Hills','Epping','Essendon',
  'Essendon North','Fairfield','Fawkner','Ferntree Gully','Fitzroy','Fitzroy North','Flemington','Footscray',
  'Forest Hill','Frankston','Gardenvale','Glen Huntly','Glen Iris','Glen Waverley','Glenroy','Gowanbrae',
  'Greensborough','Hadfield','Hampton','Hampton East','Hawthorn','Hawthorn East','Heidelberg','Heidelberg Heights',
  'Highett','Hoppers Crossing','Hughesdale','Huntingdale','Ivanhoe','Ivanhoe East','Kealba','Keilor','Keilor East',
  'Kensington','Kew','Kew East','Keysborough','Kings Park','Kingsbury','Kingsville','Knoxfield','Kooyong',
  'Lalor','Laverton','Lower Plenty','Macleod','Maidstone','Malvern','Malvern East','Maribyrnong','McKinnon',
  'Melbourne','Mentone','Mernda','Middle Park','Mill Park','Mitcham','Mont Albert','Montmorency','Moonee Ponds',
  'Moorabbin','Mordialloc','Mount Waverley','Mulgrave','Murrumbeena','Narre Warren','Newport','Niddrie','Noble Park',
  'North Melbourne','Northcote','Notting Hill','Nunawading','Oak Park','Oakleigh','Oakleigh East','Oakleigh South',
  'Ormond','Pakenham','Parkdale','Parkville','Pascoe Vale','Point Cook','Port Melbourne','Prahran','Preston',
  'Princes Hill','Reservoir','Richmond','Ringwood','Ringwood East','Ripponlea','Rosanna','Rowville','Roxburgh Park',
  'Sandringham','Scoresby','Seaford','Seddon','South Melbourne','South Yarra','Southbank','Spotswood','Springvale',
  'St Albans','St Kilda','St Kilda East','Strathmore','Sunbury','Sunshine','Sunshine North','Sunshine West',
  'Surrey Hills','Templestowe','Templestowe Lower','Thomastown','Thornbury','Toorak','Truganina','Vermont',
  'Vermont South','Viewbank','Wantirna','Wantirna South','Watsonia','Werribee','West Footscray','West Melbourne',
  'Wheelers Hill','Williamstown','Windsor','Yarraville',
].map(name => ({ name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') }));
const MAX_SPAN_KM = 12; // sanity guard on a fetched boundary's bounding box

// Everything the layer inspector can change lives here.
const cfg = {
  terrain:    { on: true,  color: '#ffffff', metal: 0.0,  rough: 1.0,  exag: 1.0, res: 96 },
  base:       {            color: '#ffffff', metal: 0.0,  rough: 1.0,  depth: 36 },
  backing:    { on: true,  title: 'suburb', outline: 2, title3d: true },
  frame:      { on: true,  material: 'black', thickness: 10, height: 10 },
  backdrop:   { on: true,  style: 'brick' },
  buildings:  { on: true,  color: '#c9d4e4', metal: 0.1,  rough: 0.85, defH: 8, scale: 1, extra: 0, minH: 0, fit: 'terrain', nodes: true, nodeSize: 10 },
  majorRoads: { on: true,  color: '#2e3947', metal: 0.0,  rough: 1.0,  widthScale: 1, lift: 2.5 },
  minorRoads: { on: true,  color: '#2e3947', metal: 0.0,  rough: 1.0,  widthScale: 1, lift: 2.0 },
  paths:      { on: true,  color: '#c9d4e4', metal: 0.0,  rough: 1.0,  widthScale: 1, lift: 0.3 },
  green:      { on: true,  color: '#40653c', metal: 0.0,  rough: 1.0,  lift: 1.8 },
  water:      { on: true,  color: '#3d6fa8', metal: 0.25, rough: 0.35, lift: 1.6 },
};

// One material per layer, updated live by the inspector.
const MATS = {};
for (const key of Object.keys(cfg)) {
  if (!cfg[key].color) continue;   // layers without a colour (e.g. backing map) have no material
  MATS[key] = new THREE.MeshStandardMaterial({
    color: new THREE.Color(cfg[key].color),
    metalness: cfg[key].metal,
    roughness: cfg[key].rough,
    side: THREE.DoubleSide,
  });
}

// reverse lookup: material → layer key (used to name/colour 3MF objects by layer)
const MAT2KEY = new Map();
for (const key of Object.keys(MATS)) MAT2KEY.set(MATS[key], key);

// human-readable layer names for exported 3MF objects
const LAYER_LABELS = {
  buildings: 'Buildings', majorRoads: 'Major roads', minorRoads: 'Minor roads',
  paths: 'Paths & tracks', green: 'Green space', water: 'Water',
  terrain: 'Terrain', base: 'Base block',
};

// A3 base sheet layout (portrait, north up, mm). The 3D model prints at 200 mm on
// its widest side and sits centred in the lower two-thirds of the sheet. Declared
// early so nothing downstream can hit them before initialisation.
const A3_W = 297, A3_H = 420;
const MODEL_PRINT_MM = 200;             // model's widest side, printed
const MODEL_CX_MM = A3_W / 2;           // 148.5 — model centred horizontally
const MODEL_CY_MM = A3_H * 2 / 3;       // 280 — middle of the bottom two-thirds

// title font cache — declared early so the startup preload can't hit a TDZ
let _titleFont = null, _titleFontPromise = null;

const $ = (id) => document.getElementById(id);

/* ============================================================ request cache

   A 30-day client-side cache (Cache Storage API) for the heavy, repeat-friendly
   network resources: AWS terrain-elevation tiles, Overpass results and Nominatim
   lookups. Cuts repeat downloads on revisits and is a good citizen towards the
   free community servers. Cleared on demand from the sidebar. (The Carto 2D
   basemap is cached separately by MapLibre / the browser HTTP cache.)            */

const CACHE_NAME = 'mapforge-cache-v1';
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;   // 30 days
const CACHE_OK = (typeof caches !== 'undefined');

async function cachedResponse(key, doFetch) {
  if (!CACHE_OK) return doFetch();
  let cache;
  try { cache = await caches.open(CACHE_NAME); } catch (e) { return doFetch(); }
  try {
    const hit = await cache.match(key);
    if (hit && Date.now() - Number(hit.headers.get('x-cached-at') || 0) < CACHE_TTL) return hit.clone();
  } catch (e) { /* fall through to network */ }
  const resp = await doFetch();
  try {
    if (resp && resp.ok) {
      const buf = await resp.clone().arrayBuffer();
      const h = new Headers();
      h.set('x-cached-at', String(Date.now()));
      const ct = resp.headers.get('Content-Type'); if (ct) h.set('Content-Type', ct);
      await cache.put(key, new Response(buf, { status: 200, headers: h }));
    }
  } catch (e) { /* over quota etc — ignore, still return the live response */ }
  return resp;
}
const cachedFetch = (url, opts) => cachedResponse(url, () => fetch(url, opts));

async function clearRequestCache() {
  if (!CACHE_OK) { setStatus('Caching isn’t available in this context.', true); return; }
  try { await caches.delete(CACHE_NAME); setStatus('Cached map data cleared.'); }
  catch (e) { setStatus('Could not clear the cache: ' + (e.message || e), true); }
}

/* ============================================================ 2D map */

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  center: [145.0960, -37.8695],   // Queens Parade, Ashwood VIC
  zoom: 15,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');

function metersPerPixel() {
  const lat = map.getCenter().lat;
  return 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, map.getZoom());
}
function updateSelBox() {
  const el = $('selBox');
  // Only show the square in Custom mode once an area size has been chosen.
  if (state.uiMode !== 'custom' || !state.sizeMeters) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  const px = state.sizeMeters / metersPerPixel();
  const maxPx = Math.min(window.innerWidth, window.innerHeight) * 0.9;
  el.style.width = el.style.height = Math.min(px, maxPx) + 'px';
  const km = state.sizeMeters >= 1000 ? (state.sizeMeters / 1000) + ' km' : state.sizeMeters + ' m';
  $('selLabel').textContent = `${km} × ${km}`;
}
map.on('move', updateSelBox);
map.on('load', updateSelBox);
window.addEventListener('resize', updateSelBox);

document.querySelectorAll('.size-grid button').forEach(btn => {
  btn.addEventListener('click', () => {
    // choosing a square size returns to square mode
    clearArea();
    document.querySelectorAll('.size-grid button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.sizeMeters = Number(btn.dataset.size);
    updateSelBox();
    updateLayersVisibility();
  });
});

/* ---------- suburb picker ---------- */

function drawAreaOutline(ll) {
  const fc = { type: 'FeatureCollection', features: ll.map(r => ({
    type: 'Feature', geometry: { type: 'LineString', coordinates: r } })) };
  if (map.getSource('area-bd')) { map.getSource('area-bd').setData(fc); return; }
  map.addSource('area-bd', { type: 'geojson', data: fc });
  map.addLayer({ id: 'area-bd', type: 'line', source: 'area-bd',
    paint: { 'line-color': '#4f8cff', 'line-width': 2.5, 'line-dasharray': [2, 1] } });
}
function clearAreaOutline() {
  if (map.getLayer('area-bd')) map.removeLayer('area-bd');
  if (map.getSource('area-bd')) map.removeSource('area-bd');
}
function clearArea() {
  state.mode = 'square';
  state.council = null;
  clearAreaOutline();
  $('selBox').style.display = (state.uiMode === 'custom' && state.sizeMeters) ? 'block' : 'none';
  const sel = $('councilSelect'); if (sel) sel.value = '';
}

// Show the Layers + Generate controls only once there's something to build:
// a chosen suburb, or (in Custom mode) a chosen area size.
function updateLayersVisibility() {
  const ready = !!state.council || (state.uiMode === 'custom' && !!state.sizeMeters);
  $('layersSection').style.display = ready ? 'block' : 'none';
}

function initSuburbPicker() {
  const sel = $('councilSelect');
  for (const s of SUBURBS) {
    const o = document.createElement('option');
    o.value = s.slug; o.textContent = s.name;
    sel.appendChild(o);
  }
  sel.addEventListener('change', async () => {
    const slug = sel.value;
    if (!slug) { clearArea(); if (state.uiMode === 'suburb') $('selBox').style.display = 'none'; else updateSelBox(); updateLayersVisibility(); return; }
    const suburb = SUBURBS.find(s => s.slug === slug);
    setStatus('');
    setLoading(true, `Finding the ${suburb.name} boundary…`);
    try {
      const b = await fetchSuburbBoundary(suburb.name);
      // sanity guard: reject an unexpectedly huge match
      const wkm = (b.bbox.east - b.bbox.west) * 111.32 * Math.cos(b.bbox.lat0 * Math.PI / 180);
      const hkm = (b.bbox.north - b.bbox.south) * 111.32;
      if (Math.max(wkm, hkm) > MAX_SPAN_KM) throw new Error(`matched area is too large (${Math.max(wkm, hkm).toFixed(1)} km across)`);
      state.council = { name: suburb.name, slug: suburb.slug, bbox: b.bbox, maskRings: b.maskRings, postcode: b.postcode };
      state.mode = 'suburb';
      state.modelName = suburb.slug;
      updateLayersVisibility();
      drawAreaOutline(b.ll);
      $('selBox').style.display = 'none';
      map.fitBounds([[b.bbox.west, b.bbox.south], [b.bbox.east, b.bbox.north]], { padding: 40, duration: 800 });
    } catch (e) {
      setStatus('Could not load that suburb boundary: ' + (e.message || e), true);
      clearArea();
      updateLayersVisibility();
    } finally {
      setLoading(false);
    }
  });
}
initSuburbPicker();

/* ---------- mode toggle (Suburb / Custom) ---------- */

state.uiMode = 'suburb';
function setMode(mode) {
  state.uiMode = mode;
  const suburb = mode === 'suburb';
  $('suburbPanel').style.display = suburb ? 'block' : 'none';
  $('customPanel').style.display = suburb ? 'none' : 'block';
  $('modeSuburb').classList.toggle('active', suburb);
  $('modeCustom').classList.toggle('active', !suburb);
  if (suburb) {
    // Suburb mode: no square selection on the map.
    $('selBox').style.display = 'none';
    if (state.council) state.mode = 'suburb';
  } else {
    // Custom mode: reset to a square selection the user pans over the map.
    clearArea();          // → square mode, clears any suburb
    updateSelBox();
  }
  updateLayersVisibility();
}
$('modeSuburb').addEventListener('click', () => setMode('suburb'));
$('modeCustom').addEventListener('click', () => setMode('custom'));
setMode('suburb');        // default view

/* ============================================================ search */

async function doSearch() {
  const q = $('searchInput').value.trim();
  if (!q) return;
  const box = $('searchResults');
  box.innerHTML = '<div class="search-result">Searching…</div>';
  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=5&q=' + encodeURIComponent(q);
    const res = await cachedFetch(url, { headers: { 'Accept': 'application/json' } });
    const results = await res.json();
    box.innerHTML = '';
    if (!results.length) {
      box.innerHTML = '<div class="search-result">No results found.</div>';
      return;
    }
    for (const r of results) {
      const div = document.createElement('div');
      div.className = 'search-result';
      div.textContent = r.display_name;
      div.addEventListener('click', () => {
        map.flyTo({ center: [Number(r.lon), Number(r.lat)], zoom: 15 });
        state.modelName = (r.display_name.split(',')[0] || 'map')
          .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        box.innerHTML = '';
        showViewer(false);
      });
      box.appendChild(div);
    }
  } catch (e) {
    box.innerHTML = '<div class="search-result">Search failed — try again.</div>';
  }
}
$('searchBtn').addEventListener('click', doSearch);
$('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

/* ============================================================ geo helpers */

function makeProjector(lat0, lon0) {
  const mLat = 111320;
  const mLon = 111320 * Math.cos(lat0 * Math.PI / 180);
  return (lat, lon) => [ (lon - lon0) * mLon, (lat - lat0) * mLat ];
}

function currentBBox() {
  if (state.mode === 'suburb' && state.council) return state.council.bbox;
  const c = map.getCenter();
  const half = state.sizeMeters / 2;
  const dLat = half / 111320;
  const dLon = half / (111320 * Math.cos(c.lat * Math.PI / 180));
  return { south: c.lat - dLat, north: c.lat + dLat, west: c.lng - dLon, east: c.lng + dLon, lat0: c.lat, lon0: c.lng };
}

/* ============================================================ council mask */

// Even-odd point test over a set of rings (outer islands; holes flip parity).
function pointInRings(x, y, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// Clip a polyline to the inside of an arbitrary polygon mask (concave OK).
// Returns an array of runs (each ≥ 2 points) that lie within the mask.
function clipLineToMask(pts, rings) {
  const runs = [];
  let run = [];
  const push = () => { if (run.length > 1) runs.push(run); run = []; };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    // collect crossing parameters t along segment a→b against every mask edge
    const ts = [0, 1];
    for (const ring of rings) {
      for (let k = 0, m = ring.length - 1; k < ring.length; m = k++) {
        const p = ring[m], q = ring[k];
        const d1x = b[0] - a[0], d1y = b[1] - a[1];
        const d2x = q[0] - p[0], d2y = q[1] - p[1];
        const den = d1x * d2y - d1y * d2x;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((p[0] - a[0]) * d2y - (p[1] - a[1]) * d2x) / den;
        const u = ((p[0] - a[0]) * d1y - (p[1] - a[1]) * d1x) / den;
        if (t > 1e-9 && t < 1 - 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) ts.push(t);
      }
    }
    ts.sort((m, n) => m - n);
    for (let s = 0; s < ts.length - 1; s++) {
      const t0 = ts[s], t1 = ts[s + 1];
      if (t1 - t0 < 1e-9) continue;
      const mt = (t0 + t1) / 2;
      const mx = a[0] + (b[0] - a[0]) * mt, my = a[1] + (b[1] - a[1]) * mt;
      const p0 = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
      const p1 = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
      if (pointInRings(mx, my, rings)) {
        if (run.length === 0) run.push(p0);
        else if (Math.hypot(run[run.length - 1][0] - p0[0], run[run.length - 1][1] - p0[1]) > 1e-6) { push(); run.push(p0); }
        run.push(p1);
      } else {
        push();
      }
    }
  }
  push();
  return runs;
}

// Fetch a suburb boundary polygon from Nominatim (returns the geometry directly,
// far more reliable than guessing OSM admin levels). Returns projected mask rings
// (local metres around the suburb centroid) + lon/lat rings + a bbox.
async function fetchSuburbBoundary(name) {
  // bounded to a Greater-Melbourne viewbox so same-named suburbs elsewhere don't match
  const url = 'https://nominatim.openstreetmap.org/search?format=json&polygon_geojson=1&addressdetails=1'
    + '&limit=8&viewbox=144.30,-38.55,145.90,-37.35&bounded=1&q='
    + encodeURIComponent(name + ', Victoria, Australia');
  const res = await cachedFetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error('Nominatim HTTP ' + res.status);
  const results = await res.json();
  if (!results.length) throw new Error('suburb "' + name + '" not found');

  let outerLL;
  const cand = results.find(r => r.geojson && (r.geojson.type === 'Polygon' || r.geojson.type === 'MultiPolygon'));
  const postcode = (cand && cand.address && cand.address.postcode)
    || (results[0].address && results[0].address.postcode) || '';
  if (cand) {
    const gj = cand.geojson;
    const polygons = gj.type === 'Polygon' ? [gj.coordinates] : gj.coordinates;
    outerLL = polygons.map(p => p[0]); // outer ring of each polygon ([lon,lat] pairs)
  } else {
    // no boundary polygon in OSM — fall back to the result's bounding rectangle
    const bb = (results[0].boundingbox || []).map(Number); // [south, north, west, east]
    if (bb.length !== 4) throw new Error('no boundary found for "' + name + '"');
    const [s, n, w, e] = bb;
    outerLL = [[[w, s], [e, s], [e, n], [w, n], [w, s]]];
  }

  let west = 180, east = -180, south = 90, north = -90;
  for (const r of outerLL) for (const [lon, lat] of r) {
    west = Math.min(west, lon); east = Math.max(east, lon);
    south = Math.min(south, lat); north = Math.max(north, lat);
  }
  const lat0 = (south + north) / 2, lon0 = (west + east) / 2;
  const project = makeProjector(lat0, lon0);
  const maskRings = outerLL.map(r => r.map(([lon, lat]) => project(lat, lon)));
  return { bbox: { west, south, east, north, lat0, lon0 }, maskRings, ll: outerLL, postcode };
}

// Reverse-geocode the area centre to a suburb name + postcode for the backing-map
// title. Best-effort: in suburb mode we already have both, so skip the request.
async function ensurePlaceLabels(bbox) {
  if (state.council && state.council.name && state.council.postcode) {
    state.placeLabels = { suburb: state.council.name, postcode: state.council.postcode };
    return;
  }
  try {
    const url = 'https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1&zoom=14'
      + '&lat=' + bbox.lat0 + '&lon=' + bbox.lon0;
    const res = await cachedFetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error('reverse HTTP ' + res.status);
    const a = (await res.json()).address || {};
    state.placeLabels = {
      suburb: (state.council && state.council.name)
        || a.suburb || a.neighbourhood || a.city_district || a.town || a.village || a.city || '',
      postcode: (state.council && state.council.postcode) || a.postcode || '',
    };
  } catch (e) {
    console.warn('Place labels unavailable', e);
  }
}

/* ============================================================ boundary clipping */

// Clip a polygon ring to the square [-half, half]² (Sutherland–Hodgman).
function clipRingToSquare(ring, half) {
  let out = ring;
  for (const [axis, dir] of [[0, 1], [0, -1], [1, 1], [1, -1]]) {
    const inp = out;
    out = [];
    if (!inp.length) return [];
    const inside = p => p[axis] * dir >= -half;
    const bound = -half * dir; // p[axis] value on this clip edge
    for (let i = 0; i < inp.length; i++) {
      const prev = inp[(i + inp.length - 1) % inp.length];
      const cur = inp[i];
      const curIn = inside(cur), prevIn = inside(prev);
      if (curIn !== prevIn) {
        const t = (bound - prev[axis]) / (cur[axis] - prev[axis]);
        out.push([
          prev[0] + t * (cur[0] - prev[0]),
          prev[1] + t * (cur[1] - prev[1]),
        ]);
      }
      if (curIn) out.push(cur);
    }
  }
  return out.length >= 3 ? out : [];
}

// Clip a polyline to the square; returns an array of runs (each ≥ 2 points).
function clipLineToSquare(pts, half) {
  const runs = [];
  let run = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const dx = x2 - x1, dy = y2 - y1;
    let t0 = 0, t1 = 1, ok = true;
    for (const [p, q] of [[-dx, x1 + half], [dx, half - x1], [-dy, y1 + half], [dy, half - y1]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
      else       { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
    }
    if (!ok) { if (run.length > 1) runs.push(run); run = []; continue; }
    const a = [x1 + t0 * dx, y1 + t0 * dy];
    const b = [x1 + t1 * dx, y1 + t1 * dy];
    if (run.length === 0) run.push(a);
    else {
      const last = run[run.length - 1];
      if (Math.hypot(last[0] - a[0], last[1] - a[1]) > 1e-6) {
        if (run.length > 1) runs.push(run);
        run = [a];
      }
    }
    run.push(b);
    if (t1 < 1) { runs.push(run); run = []; }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

/* ---------- generalized extent (rectangle + optional council mask) ---------- */

// The active build extent, set by buildModel(). Square mode: hx=hy=size/2,
// mask=null. Council mode: hx/hy from the council bbox, mask = its rings.
let EXT = { hx: 1000, hy: 1000, mask: null };

// Rectangle ring clip [-hx,hx]×[-hy,hy] (Sutherland–Hodgman, per-axis).
function clipRingToRect(ring, hx, hy) {
  let out = ring;
  for (const [axis, dir] of [[0, 1], [0, -1], [1, 1], [1, -1]]) {
    const h = axis === 0 ? hx : hy;
    const inp = out; out = [];
    if (!inp.length) return [];
    const inside = p => p[axis] * dir >= -h;
    const bound = -h * dir;
    for (let i = 0; i < inp.length; i++) {
      const prev = inp[(i + inp.length - 1) % inp.length];
      const cur = inp[i];
      const curIn = inside(cur), prevIn = inside(prev);
      if (curIn !== prevIn) {
        const t = (bound - prev[axis]) / (cur[axis] - prev[axis]);
        out.push([prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])]);
      }
      if (curIn) out.push(cur);
    }
  }
  return out.length >= 3 ? out : [];
}

function clipLineToRect(pts, hx, hy) {
  const runs = [];
  let run = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const dx = x2 - x1, dy = y2 - y1;
    let t0 = 0, t1 = 1, ok = true;
    for (const [p, q] of [[-dx, x1 + hx], [dx, hx - x1], [-dy, y1 + hy], [dy, hy - y1]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
      else       { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
    }
    if (!ok) { if (run.length > 1) runs.push(run); run = []; continue; }
    const a = [x1 + t0 * dx, y1 + t0 * dy];
    const b = [x1 + t1 * dx, y1 + t1 * dy];
    if (run.length === 0) run.push(a);
    else {
      const last = run[run.length - 1];
      if (Math.hypot(last[0] - a[0], last[1] - a[1]) > 1e-6) { if (run.length > 1) runs.push(run); run = [a]; }
    }
    run.push(b);
    if (t1 < 1) { runs.push(run); run = []; }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

const clampX = v => Math.max(-EXT.hx, Math.min(EXT.hx, v));
const clampY = v => Math.max(-EXT.hy, Math.min(EXT.hy, v));
const insideExtent = (x, y) => Math.abs(x) <= EXT.hx && Math.abs(y) <= EXT.hy
  && (!EXT.mask || pointInRings(x, y, EXT.mask));

// Clip a polyline to the active extent (rectangle then, if present, the mask).
function clipLineToExtent(pts) {
  let runs = clipLineToRect(pts, EXT.hx, EXT.hy);
  if (!EXT.mask) return runs;
  const out = [];
  for (const r of runs) for (const rr of clipLineToMask(r, EXT.mask)) out.push(rr);
  return out;
}

/* ============================================================ Overpass */

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function fetchOSM(bbox) {
  const bb = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const parts = [
    `way["building"](${bb});`,
    `relation["building"]["type"="multipolygon"](${bb});`,
    `node["addr:housenumber"](${bb});`,
    `node["building"](${bb});`,
    `way["highway"](${bb});`,
    `way["natural"="water"](${bb});`,
    `relation["natural"="water"]["type"="multipolygon"](${bb});`,
    `way["waterway"="riverbank"](${bb});`,
    `way["waterway"~"^(river|stream|canal|drain)$"](${bb});`,
    `way["leisure"~"^(park|garden|pitch|golf_course)$"](${bb});`,
    `relation["leisure"~"^(park|garden|golf_course)$"]["type"="multipolygon"](${bb});`,
    `way["landuse"~"^(grass|meadow|forest|recreation_ground|village_green|cemetery)$"](${bb});`,
    `relation["landuse"~"^(grass|meadow|forest|recreation_ground|village_green|cemetery)$"]["type"="multipolygon"](${bb});`,
    `way["natural"~"^(wood|scrub|heath|grassland)$"](${bb});`,
    `relation["natural"~"^(wood|scrub|heath|grassland)$"]["type"="multipolygon"](${bb});`,
  ];
  const query = `[out:json][timeout:60];(${parts.join('')});out geom;`;

  // cache by the query (bbox-derived) so re-generating the same area is instant
  const key = 'https://mapforge.cache/overpass?v=1&q=' + encodeURIComponent(query);
  const res = await cachedResponse(key, async () => {
    let lastErr;
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const r = await fetch(endpoint, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(query),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        if (!r.ok) throw new Error('Overpass HTTP ' + r.status);
        return r;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Overpass unavailable');
  });
  return await res.json();
}

/* ============================================================ terrain */

const TERRAIN_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

function lonLatToTile(lon, lat, z) {
  const n = Math.pow(2, z);
  const x = (lon + 180) / 360 * n;
  const latRad = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return [x, y];
}

async function buildElevationSampler(bbox) {
  let z = 14;
  while (z > 9) {
    const [x1] = lonLatToTile(bbox.west, bbox.lat0, z);
    const [x2] = lonLatToTile(bbox.east, bbox.lat0, z);
    if (x2 - x1 <= 3) break;
    z--;
  }
  const [txMinF, tyMinF] = lonLatToTile(bbox.west, bbox.north, z);
  const [txMaxF, tyMaxF] = lonLatToTile(bbox.east, bbox.south, z);
  const txMin = Math.floor(txMinF), tyMin = Math.floor(tyMinF);
  const txMax = Math.floor(txMaxF), tyMax = Math.floor(tyMaxF);

  const cols = txMax - txMin + 1, rows = tyMax - tyMin + 1;
  const T = 256;
  const canvas = document.createElement('canvas');
  canvas.width = cols * T; canvas.height = rows * T;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const jobs = [];
  for (let tx = txMin; tx <= txMax; tx++) {
    for (let ty = tyMin; ty <= tyMax; ty++) {
      jobs.push((async () => {
        // cached (30-day) fetch → bitmap, so repeat generations don't re-download tiles
        const resp = await cachedFetch(TERRAIN_URL(z, tx, ty));
        if (!resp || !resp.ok) throw new Error('elevation tile ' + z + '/' + tx + '/' + ty);
        const bmp = await createImageBitmap(await resp.blob());
        ctx.drawImage(bmp, (tx - txMin) * T, (ty - tyMin) * T);
        if (bmp.close) bmp.close();
      })());
    }
  }
  await Promise.all(jobs);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const W = canvas.width, H = canvas.height;

  const elevAt = (px, py) => {
    px = Math.max(0, Math.min(W - 1, px));
    py = Math.max(0, Math.min(H - 1, py));
    const i = (py * W + px) * 4;
    return (data[i] * 256 + data[i + 1] + data[i + 2] / 256) - 32768;
  };

  return (lat, lon) => {
    const [fx, fy] = lonLatToTile(lon, lat, z);
    const px = (fx - txMin) * T, py = (fy - tyMin) * T;
    const x0 = Math.floor(px), y0 = Math.floor(py);
    const dx = px - x0, dy = py - y0;
    return elevAt(x0, y0)     * (1 - dx) * (1 - dy)
         + elevAt(x0 + 1, y0) * dx * (1 - dy)
         + elevAt(x0, y0 + 1) * (1 - dx) * dy
         + elevAt(x0 + 1, y0 + 1) * dx * dy;
  };
}

/* ============================================================ geometry helpers */

function ringFromGeometry(geom, project) {
  return geom.map(pt => project(pt.lat, pt.lon));
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function shapeFromRings(outer, holes) {
  const shape = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const h of holes || []) {
    shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
  }
  return shape;
}

function taggedHeight(tags) {
  if (!tags) return null;
  const h = parseFloat(tags['height'] || tags['building:height']);
  if (!isNaN(h) && h > 0) return Math.min(h, 500);
  const lv = parseFloat(tags['building:levels']);
  if (!isNaN(lv) && lv > 0) return Math.min(lv * 3.2 + 1.5, 500);
  return null;
}

function centroidOf(ring) {
  let x = 0, y = 0;
  for (const [px, py] of ring) { x += px; y += py; }
  return [x / ring.length, y / ring.length];
}

// Stitch multipolygon member ways (often fragments of a ring) into closed rings.
function stitchRings(members) {
  const frags = members.map(m => (m.geometry || []).slice()).filter(g => g.length >= 2);
  const rings = [];
  const same = (a, b) => Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7;
  while (frags.length) {
    let ring = frags.pop();
    let extended = true;
    while (!same(ring[0], ring[ring.length - 1]) && extended) {
      extended = false;
      for (let i = 0; i < frags.length; i++) {
        const f = frags[i];
        const end = ring[ring.length - 1], start = ring[0];
        if (same(f[0], end))                 { ring = ring.concat(f.slice(1)); }
        else if (same(f[f.length - 1], end)) { ring = ring.concat(f.slice(0, -1).reverse()); }
        else if (same(f[f.length - 1], start)) { ring = f.slice(0, -1).concat(ring); }
        else if (same(f[0], start))          { ring = f.slice(1).reverse().concat(ring); }
        else continue;
        frags.splice(i, 1);
        extended = true;
        break;
      }
    }
    if (ring.length >= 4) {
      if (!same(ring[0], ring[ring.length - 1])) ring = ring.concat([ring[0]]);
      rings.push(ring);
    }
  }
  return rings;
}

function collectPolygons(elements, match) {
  const polys = [];
  for (const el of elements) {
    if (!match(el.tags || {})) continue;
    if (el.type === 'way' && el.geometry && el.geometry.length >= 4) {
      polys.push({ tags: el.tags, outer: el.geometry, holes: [] });
    } else if (el.type === 'relation' && el.members) {
      const outers = stitchRings(el.members.filter(m => m.role === 'outer'));
      const inners = stitchRings(el.members.filter(m => m.role === 'inner'));
      for (const o of outers) {
        const oxy = o.map(p => [p.lon, p.lat]);
        const holes = inners.filter(inn => pointInRing(inn[0].lon, inn[0].lat, oxy));
        polys.push({ tags: el.tags, outer: o, holes });
      }
    }
  }
  return polys;
}

// Insert interpolated points so long edges follow the terrain when draped.
function densifyRing(ring, maxLen) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
    out.push([x1, y1]);
    const d = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.ceil(d / maxLen);
    for (let s = 1; s < steps; s++) out.push([x1 + (x2 - x1) * s / steps, y1 + (y2 - y1) * s / steps]);
  }
  return out;
}

// Subdivide a 2D triangulation until no edge exceeds maxLen, so draped
// surfaces gain interior vertices and follow the terrain instead of
// letting bumps poke through large triangles. Midpoints are shared via a
// cache so neighbouring triangles stay stitched together (no cracks).
function subdivideTriangulation(verts, tris, maxLen) {
  const max2 = maxLen * maxLen;
  for (let iter = 0; iter < 8; iter++) {
    const midCache = new Map();
    const newTris = [];
    let changed = false;
    const midpoint = (a, b) => {
      const k = a < b ? a + '_' + b : b + '_' + a;
      let m = midCache.get(k);
      if (m === undefined) {
        m = verts.length;
        verts.push([(verts[a][0] + verts[b][0]) / 2, (verts[a][1] + verts[b][1]) / 2]);
        midCache.set(k, m);
      }
      return m;
    };
    const long = (a, b) => {
      const dx = verts[a][0] - verts[b][0], dy = verts[a][1] - verts[b][1];
      return dx * dx + dy * dy > max2;
    };
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t], b = tris[t + 1], c = tris[t + 2];
      const ab = long(a, b), bc = long(b, c), ca = long(c, a);
      const count = (ab ? 1 : 0) + (bc ? 1 : 0) + (ca ? 1 : 0);
      if (count === 0) { newTris.push(a, b, c); continue; }
      changed = true;
      if (count === 3) {
        const p = midpoint(a, b), q = midpoint(b, c), r = midpoint(c, a);
        newTris.push(a, p, r,  p, b, q,  r, q, c,  p, q, r);
      } else if (count === 2) {
        // rotate so the two long edges are ab and bc
        let A = a, B = b, C = c;
        if (!ab && bc && ca)      { A = b; B = c; C = a; }
        else if (ab && !bc && ca) { A = c; B = a; C = b; }
        const p = midpoint(A, B), q = midpoint(B, C);
        newTris.push(A, p, C,  p, B, q,  p, q, C);
      } else {
        // rotate so the long edge is ab
        let A = a, B = b, C = c;
        if (bc)      { A = b; B = c; C = a; }
        else if (ca) { A = c; B = a; C = b; }
        const p = midpoint(A, B);
        newTris.push(A, p, C,  p, B, C);
      }
    }
    tris = newTris;
    if (!changed) break;
  }
  return tris;
}

function densifyLine(pts, maxLen) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i - 1], [x2, y2] = pts[i];
    const d = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(1, Math.ceil(d / maxLen));
    for (let s = 1; s <= steps; s++) out.push([x1 + (x2 - x1) * s / steps, y1 + (y2 - y1) * s / steps]);
  }
  return out;
}

// Project → clip to the square → normalise winding. Returns {outer, holes} or null.
// Normalise winding: outer ring positive area (CCW), holes negative (CW).
function normaliseRings(outer, holes) {
  if (ringArea(outer) < 0) outer = outer.slice().reverse();
  const hs = (holes || []).map(h => ringArea(h) > 0 ? h.slice().reverse() : h);
  return { outer, holes: hs };
}

// Intersect a subject polygon (outer + holes) with the suburb mask, so features
// straddling the boundary are split at the line rather than dropped. Returns an
// array of {outer, holes} pieces.
function clipPolyToMask(outer, holes) {
  const close = r => (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) ? r.concat([r[0]]) : r;
  const subject = [close(outer), ...holes.map(close)];
  const maskMP = EXT.mask.map(r => [close(r)]);
  let result;
  try { result = polygonClipping.intersection(subject, maskMP); }
  catch (e) { return []; }
  const out = [];
  for (const p of (result || [])) {
    if (!p.length || p[0].length < 4) continue;
    const o = p[0].slice(0, -1);                       // drop closing duplicate
    if (o.length < 3) continue;
    const hs = p.slice(1).map(r => r.slice(0, -1)).filter(r => r.length >= 3);
    out.push(normaliseRings(o, hs));
  }
  return out;
}

// Returns an array of clipped {outer, holes} pieces (empty if nothing remains).
function clippedRings(poly, project) {
  let outer = clipRingToRect(ringFromGeometry(poly.outer, project), EXT.hx, EXT.hy);
  if (outer.length < 3 || Math.abs(ringArea(outer)) < 1) return [];
  const holes = [];
  for (const h of poly.holes || []) {
    const r = clipRingToRect(ringFromGeometry(h, project), EXT.hx, EXT.hy);
    if (r.length >= 3) holes.push(r);
  }
  if (!EXT.mask) return [normaliseRings(outer, holes)];

  // suburb mode: fast path for fully-inside/outside, split only the straddlers
  let inCount = 0;
  for (const [x, y] of outer) if (pointInRings(x, y, EXT.mask)) inCount++;
  if (inCount === outer.length) return [normaliseRings(outer, holes)];       // fully inside
  if (inCount === 0) {
    // fully outside unless the (small) mask sits within a large subject polygon
    const maskTouches = EXT.mask.some(r => r.some(([mx, my]) => pointInRing(mx, my, outer)));
    if (!maskTouches) return [];
  }
  return clipPolyToMask(outer, holes);
}

/* ---------- terrain block (closed solid: displaced top, skirt, bottom) */

function buildTerrainBlock(groundAt) {
  if (EXT.mask) return buildCouncilTerrain(groundAt);

  const hx = EXT.hx, hy = EXT.hy;
  const N = Math.max(16, Math.round(cfg.terrain.res / 16) * 16);
  const stepX = (2 * hx) / N, stepY = (2 * hy) / N;

  const hz = [];
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      hz.push(groundAt(-hx + i * stepX, -hy + j * stepY));
    }
  }

  const positions = [], indices = [];
  const V = (i, j) => j * (N + 1) + i;
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const x = -hx + i * stepX, y = -hy + j * stepY;
      positions.push(x, hz[V(i, j)], -y);
    }
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = V(i, j), b = V(i + 1, j), c = V(i + 1, j + 1), d = V(i, j + 1);
      indices.push(a, b, c, a, c, d);
    }
  }
  const topGeo = new THREE.BufferGeometry();
  topGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  topGeo.setIndex(indices);
  topGeo.computeVertexNormals();
  const top = new THREE.Mesh(topGeo, MATS.terrain);
  top.name = 'terrain';

  const bot = -Math.max(0.5, cfg.base.depth);
  const sp = [], si = [];
  const edgeLoop = [];
  for (let i = 0; i <= N; i++) edgeLoop.push([ -hx + i * stepX, -hy ]);
  for (let j = 1; j <= N; j++) edgeLoop.push([ hx, -hy + j * stepY ]);
  for (let i = N - 1; i >= 0; i--) edgeLoop.push([ -hx + i * stepX, hy ]);
  for (let j = N - 1; j >= 1; j--) edgeLoop.push([ -hx, -hy + j * stepY ]);
  const hAt = (x, y) => {
    const i = Math.round((x + hx) / stepX), j = Math.round((y + hy) / stepY);
    return hz[V(Math.max(0, Math.min(N, i)), Math.max(0, Math.min(N, j)))];
  };
  for (let k = 0; k < edgeLoop.length; k++) {
    const [x, y] = edgeLoop[k];
    sp.push(x, hAt(x, y), -y);
    sp.push(x, bot, -y);
  }
  const M = edgeLoop.length;
  for (let k = 0; k < M; k++) {
    const a = k * 2, b = k * 2 + 1, c = ((k + 1) % M) * 2, d = ((k + 1) % M) * 2 + 1;
    si.push(a, b, c, b, d, c);
  }
  const baseIdx = sp.length / 3;
  sp.push(-hx, bot, hy,  hx, bot, hy,  hx, bot, -hy,  -hx, bot, -hy);
  si.push(baseIdx, baseIdx + 2, baseIdx + 1, baseIdx, baseIdx + 3, baseIdx + 2);
  const skirtGeo = new THREE.BufferGeometry();
  skirtGeo.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  skirtGeo.setIndex(si);
  skirtGeo.computeVertexNormals();
  const skirt = new THREE.Mesh(skirtGeo, MATS.base);
  skirt.name = 'base';

  const g = new THREE.Group();
  g.add(top, skirt);
  return g;
}

// Offset a closed ring outward by d metres (average-of-adjacent-edge normals).
// Keeps the terrain slightly larger than the clipped features so road ribbons
// that hug the boundary always land on the base rather than floating.
function bufferRingOutward(ring, d) {
  let r = ring.slice();
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r = r.slice(0, -1);
  const m = r.length;
  if (m < 3) return ring;
  const ccw = ringArea(r) > 0;               // outward normal side depends on winding
  const out = [];
  for (let i = 0; i < m; i++) {
    const p = r[(i + m - 1) % m], c = r[i], n = r[(i + 1) % m];
    const nrm = (ax, ay, bx, by) => { let dx = bx - ax, dy = by - ay; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l; return ccw ? [dy, -dx] : [-dy, dx]; };
    const n1 = nrm(p[0], p[1], c[0], c[1]), n2 = nrm(c[0], c[1], n[0], n[1]);
    let mx = n1[0] + n2[0], my = n1[1] + n2[1];
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) { out.push([c[0] + n1[0] * d, c[1] + n1[1] * d]); continue; }
    mx /= ml; my /= ml;
    const cosA = Math.max(0.3, mx * n1[0] + my * n1[1]); // miter length d/cos, clamped at sharp corners
    out.push([c[0] + mx * d / cosA, c[1] + my * d / cosA]);
  }
  out.push(out[0].slice());
  return out;
}

// Terrain shaped to the council boundary: a thick draped slab per mask ring.
function buildCouncilTerrain(groundAt) {
  const bot = -Math.max(0.5, cfg.base.depth);
  const group = new THREE.Group();
  const topPos = [], topIdx = [];        // draped top surface (terrain material)
  const wallPos = [], wallIdx = [];      // skirt walls + flat bottom (base material)
  for (const ringXY of EXT.mask) {
    let ring = bufferRingOutward(ringXY, 12); // ~ widest road half-width, so roads sit on the base
    if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring = ring.slice(0, -1);
    if (ring.length < 3) continue;
    const dense = densifyRing(ring, 40);
    // triangulate + subdivide the interior so bumps inside the council show
    const shapeGeo = new THREE.ShapeGeometry(new THREE.Shape(dense.map(([x, y]) => new THREE.Vector2(x, y))));
    const pos = shapeGeo.getAttribute('position');
    const rawIdx = shapeGeo.getIndex() ? shapeGeo.getIndex().array : null;
    if (!rawIdx) continue;
    const verts = [];
    for (let i = 0; i < pos.count; i++) verts.push([pos.getX(i), pos.getY(i)]);
    const tris = subdivideTriangulation(verts, Array.from(rawIdx), 60);
    const base = topPos.length / 3;
    for (const [x, y] of verts) topPos.push(x, groundAt(x, y), -y);
    for (let t = 0; t < tris.length; t += 3) topIdx.push(base + tris[t], base + tris[t + 1], base + tris[t + 2]);
    // flat bottom cap: reuse the (concave-correct) triangulation, reversed winding
    const bb = wallPos.length / 3;
    for (const [x, y] of verts) wallPos.push(x, bot, -y);
    for (let t = 0; t < tris.length; t += 3) wallIdx.push(bb + tris[t], bb + tris[t + 2], bb + tris[t + 1]);
    // skirt wall around the dense outer ring
    const wb = wallPos.length / 3;
    for (const [x, y] of dense) { const g = groundAt(x, y); wallPos.push(x, g, -y); wallPos.push(x, bot, -y); }
    const m = dense.length;
    for (let k = 0; k < m; k++) {
      const a = wb + k * 2, b = a + 1, cc = wb + ((k + 1) % m) * 2, d = cc + 1;
      wallIdx.push(a, b, cc, b, d, cc);
    }
  }
  const topGeo = new THREE.BufferGeometry();
  topGeo.setAttribute('position', new THREE.Float32BufferAttribute(topPos, 3));
  topGeo.setIndex(topIdx); topGeo.computeVertexNormals();
  const top = new THREE.Mesh(topGeo, MATS.terrain); top.name = 'terrain';
  const wallGeo = new THREE.BufferGeometry();
  wallGeo.setAttribute('position', new THREE.Float32BufferAttribute(wallPos, 3));
  wallGeo.setIndex(wallIdx); wallGeo.computeVertexNormals();
  const walls = new THREE.Mesh(wallGeo, MATS.base); walls.name = 'base';
  group.add(top, walls);
  return group;
}

/* ---------- buildings */

// Ray-casting point-in-polygon test.
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function buildBuildings(elements, project, groundAt, extraPolys) {
  const c = cfg.buildings;
  const group = new THREE.Group();
  group.name = 'buildings';
  const footprints = []; // unclipped projected outer rings, used to detect mapped buildings
  const polys = collectPolygons(elements, t => t['building'] !== undefined);
  if (extraPolys && extraPolys.length) polys.push(...extraPolys);
  for (const poly of polys) {
    try {
      footprints.push(ringFromGeometry(poly.outer, project));
      let h = taggedHeight(poly.tags);
      h = (h === null ? c.defH : h) * c.scale + c.extra;
      h = Math.max(h, c.minH, 1);
      for (const rings of clippedRings(poly, project)) {   // may be split at the boundary
        // ground reference + how far the base must sink to sit into the terrain everywhere
        let minG = Infinity;
        for (const [x, y] of rings.outer) minG = Math.min(minG, groundAt(x, y));
        let ground;
        if (c.fit === 'flat') {
          ground = minG;
        } else {
          const [cx, cy] = centroidOf(rings.outer);
          ground = groundAt(cx, cy);
        }
        const sink = Math.max(1.5, ground - minG + 0.5);
        const geo = new THREE.ExtrudeGeometry(shapeFromRings(rings.outer, rings.holes), { depth: h + sink, bevelEnabled: false });
        geo.rotateX(-Math.PI / 2);
        const mesh = new THREE.Mesh(geo, MATS.buildings);
        mesh.position.y = ground - sink; // top ends up at ground + h, base below the lowest corner
        group.add(mesh);
      }
    } catch (e) { /* skip malformed footprints */ }
  }

  // Unmapped buildings: place a default box at OSM address / building nodes
  // that have no building outline (way) drawn yet.
  if (c.nodes) {
    const seen = new Set();
    const cell = Math.max(2, c.nodeSize * 0.8);
    for (const el of elements) {
      if (el.type !== 'node' || !el.tags) continue;
      if (el.tags['addr:housenumber'] === undefined && el.tags['building'] === undefined) continue;
      if (el.lat === undefined || el.lon === undefined) continue;
      const [x, y] = project(el.lat, el.lon);
      if (!insideExtent(x, y)) continue;
      // skip nodes that fall inside an already-mapped building footprint
      let covered = false;
      for (const ring of footprints) {
        if (pointInRing(x, y, ring)) { covered = true; break; }
      }
      if (covered) continue;
      // dedupe clusters of address nodes (e.g. multiple units on one lot)
      const key = Math.round(x / cell) + ':' + Math.round(y / cell);
      if (seen.has(key)) continue;
      seen.add(key);
      let h = taggedHeight(el.tags);
      h = (h === null ? c.defH : h) * c.scale + c.extra;
      h = Math.max(h, c.minH, 1);
      const s = c.nodeSize;
      // keep the box fully inside the extent
      const bx = Math.max(-EXT.hx + s / 2, Math.min(EXT.hx - s / 2, x));
      const by = Math.max(-EXT.hy + s / 2, Math.min(EXT.hy - s / 2, y));
      const ground = groundAt(bx, by);
      let minG = ground;
      for (const [ox, oy] of [[-s / 2, -s / 2], [s / 2, -s / 2], [-s / 2, s / 2], [s / 2, s / 2]]) {
        minG = Math.min(minG, groundAt(bx + ox, by + oy));
      }
      const sink = Math.max(1.0, ground - minG + 0.5);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(s, h + sink, s), MATS.buildings);
      mesh.position.set(bx, ground - sink + (h + sink) / 2, -by); // top at ground + h
      group.add(mesh);
    }
  }
  return group;
}

/* ---------- roads (flat ribbons draped on terrain, split by class) */

const ROAD_WIDTHS = {
  motorway: 18, motorway_link: 10, trunk: 16, trunk_link: 9,
  primary: 13, primary_link: 8, secondary: 11, secondary_link: 7, tertiary: 9,
  unclassified: 7, residential: 7, living_street: 6, service: 4.5,
  pedestrian: 5, track: 3.5, cycleway: 2.5, footway: 2, path: 1.8, steps: 2,
};
const MAJOR = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link']);
const PATHS = new Set(['footway', 'path', 'cycleway', 'steps', 'track', 'pedestrian']);

function roadClass(kind) {
  if (MAJOR.has(kind)) return 'majorRoads';
  if (PATHS.has(kind)) return 'paths';
  return 'minorRoads';
}

function buildRoadClass(elements, project, groundAt, layerKey) {
  const c = cfg[layerKey];
  const group = new THREE.Group();
  group.name = layerKey;
  for (const el of elements) {
    if (el.type !== 'way' || !el.tags || !el.tags.highway || !el.geometry) continue;
    if (el.tags.area === 'yes') continue;
    const kind = el.tags.highway;
    if (roadClass(kind) !== layerKey) continue;
    const width = (ROAD_WIDTHS[kind] || 5) * c.widthScale;
    const runs = clipLineToExtent(ringFromGeometry(el.geometry, project));
    const EMBED = 1.0; // how far the ribbon's underside sinks into the terrain
    for (const rawPts of runs) {
      if (rawPts.length < 2) continue;
      const pts = densifyLine(rawPts, 12); // follow the terrain closely
      const positions = [], indices = [];
      for (let i = 0; i < pts.length; i++) {
        const [x, y] = pts[i];
        const [xp, yp] = pts[Math.max(0, i - 1)];
        const [xn, yn] = pts[Math.min(pts.length - 1, i + 1)];
        let dx = xn - xp, dy = yn - yp;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len; dy /= len;
        const nx = -dy, ny = dx;
        const lx = clampX(x + nx * width / 2), ly = clampY(y + ny * width / 2);
        const rx = clampX(x - nx * width / 2), ry = clampY(y - ny * width / 2);
        const gl = groundAt(lx, ly), gr = groundAt(rx, ry);
        // 4 vertices per cross-section: top-left, top-right, bottom-left, bottom-right
        positions.push(lx, gl + c.lift, -ly);
        positions.push(rx, gr + c.lift, -ry);
        positions.push(lx, gl - EMBED, -ly);
        positions.push(rx, gr - EMBED, -ry);
        if (i > 0) {
          const p = (i - 1) * 4, s = i * 4;
          indices.push(p, p + 1, s,  p + 1, s + 1, s);         // top
          indices.push(p + 2, s + 2, p + 3,  p + 3, s + 2, s + 3); // bottom
          indices.push(p, s, p + 2,  s, s + 2, p + 2);         // left wall
          indices.push(p + 1, p + 3, s + 1,  s + 1, p + 3, s + 3); // right wall
        }
      }
      // end caps
      const last = (pts.length - 1) * 4;
      indices.push(0, 2, 1,  1, 2, 3);
      indices.push(last, last + 1, last + 2,  last + 1, last + 3, last + 2);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      group.add(new THREE.Mesh(geo, MATS[layerKey]));
    }
  }
  return group;
}

/* ---------- flat polygon layers (water, green space) */

const GREEN_MATCH = t =>
  /^(park|garden|pitch|golf_course)$/.test(t['leisure'] || '') ||
  /^(grass|meadow|forest|recreation_ground|village_green|cemetery)$/.test(t['landuse'] || '') ||
  /^(wood|scrub|heath|grassland)$/.test(t['natural'] || '');

const WATER_MATCH = t => t['natural'] === 'water' || t['waterway'] === 'riverbank';

// Linear waterways (rivers, streams, canals, drains) are mapped as lines, not
// polygons — render them as draped ribbons like roads, into the water group.
const WATERWAY_WIDTHS = { river: 12, canal: 8, stream: 3.5, drain: 2.5 };

function addWaterwayLines(group, elements, project, groundAt) {
  const c = cfg.water;
  const EMBED = 1.0;
  for (const el of elements) {
    if (el.type !== 'way' || !el.tags || !el.geometry) continue;
    const w = el.tags.waterway;
    if (!WATERWAY_WIDTHS[w]) continue;
    if (el.tags.tunnel === 'yes' || el.tags.tunnel === 'culvert') continue;
    const width = WATERWAY_WIDTHS[w];
    const runs = clipLineToExtent(ringFromGeometry(el.geometry, project));
    for (const rawPts of runs) {
      if (rawPts.length < 2) continue;
      const pts = densifyLine(rawPts, 12);
      const positions = [], indices = [];
      for (let i = 0; i < pts.length; i++) {
        const [x, y] = pts[i];
        const [xp, yp] = pts[Math.max(0, i - 1)];
        const [xn, yn] = pts[Math.min(pts.length - 1, i + 1)];
        let dx = xn - xp, dy = yn - yp;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len; dy /= len;
        const nx = -dy, ny = dx;
        const lx = clampX(x + nx * width / 2), ly = clampY(y + ny * width / 2);
        const rx = clampX(x - nx * width / 2), ry = clampY(y - ny * width / 2);
        const gl = groundAt(lx, ly), gr = groundAt(rx, ry);
        positions.push(lx, gl + c.lift, -ly);
        positions.push(rx, gr + c.lift, -ry);
        positions.push(lx, gl - EMBED, -ly);
        positions.push(rx, gr - EMBED, -ry);
        if (i > 0) {
          const p = (i - 1) * 4, s = i * 4;
          indices.push(p, p + 1, s,  p + 1, s + 1, s);
          indices.push(p + 2, s + 2, p + 3,  p + 3, s + 2, s + 3);
          indices.push(p, s, p + 2,  s, s + 2, p + 2);
          indices.push(p + 1, p + 3, s + 1,  s + 1, p + 3, s + 3);
        }
      }
      const last = (pts.length - 1) * 4;
      indices.push(0, 2, 1,  1, 2, 3);
      indices.push(last, last + 1, last + 2,  last + 1, last + 3, last + 2);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      group.add(new THREE.Mesh(geo, MATS.water));
    }
  }
}

function buildFlatPolys(elements, project, groundAt, layerKey, match) {
  const c = cfg[layerKey];
  const DEPTH = 1.5; // how far the slab's underside sinks into the terrain
  const group = new THREE.Group();
  group.name = layerKey;
  const polys = collectPolygons(elements, match);
  for (const poly of polys) {
   for (const rings of clippedRings(poly, project)) {   // may be split at the boundary
    try {
      const outer = densifyRing(rings.outer, 15);
      const holes = rings.holes.map(h => densifyRing(h, 15));

      // triangulate in 2D, subdivide the interior, then drape every vertex
      const shapeGeo = new THREE.ShapeGeometry(shapeFromRings(outer, holes));
      const pos = shapeGeo.getAttribute('position');
      const rawIdx = shapeGeo.getIndex() ? shapeGeo.getIndex().array : null;
      if (!rawIdx) continue;
      const verts = [];
      for (let i = 0; i < pos.count; i++) verts.push([pos.getX(i), pos.getY(i)]);
      const tris = subdivideTriangulation(verts, Array.from(rawIdx), 15);
      const n = verts.length;
      const positions = [], indices = [];
      for (const [x, y] of verts) positions.push(x, groundAt(x, y) + c.lift, -y);  // draped top
      for (const [x, y] of verts) positions.push(x, groundAt(x, y) - DEPTH, -y);   // draped underside
      for (let t = 0; t < tris.length; t += 3) indices.push(tris[t], tris[t + 1], tris[t + 2]);
      for (let t = 0; t < tris.length; t += 3) indices.push(n + tris[t + 2], n + tris[t + 1], n + tris[t]);
      // side walls around the outer ring and every hole
      const addWalls = (ring) => {
        const base = positions.length / 3;
        for (const [x, y] of ring) {
          const g = groundAt(x, y);
          positions.push(x, g + c.lift, -y);
          positions.push(x, g - DEPTH, -y);
        }
        const m = ring.length;
        for (let k = 0; k < m; k++) {
          const a = base + k * 2, b = a + 1, cc = base + ((k + 1) % m) * 2, d = cc + 1;
          indices.push(a, b, cc, b, d, cc);
        }
      };
      addWalls(outer);
      for (const h of holes) addWalls(h);

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      group.add(new THREE.Mesh(geo, MATS[layerKey]));
    } catch (e) { /* skip */ }
   }
  }
  return group;
}

/* ============================================================ model build (from cached data) */

function buildModel() {
  const { bbox, elements, sampleElev, minElev, prebaked } = state.last;
  const project = makeProjector(bbox.lat0, bbox.lon0);

  // set the active build extent: council mask if present, else the square
  if (state.mode === 'suburb' && state.council && state.council.maskRings) {
    const c = state.council;
    let hx = 0, hy = 0;
    for (const r of c.maskRings) for (const [x, y] of r) { hx = Math.max(hx, Math.abs(x)); hy = Math.max(hy, Math.abs(y)); }
    EXT = { hx: hx + 5, hy: hy + 5, mask: c.maskRings };
  } else {
    const half = state.sizeMeters / 2;
    EXT = { hx: half, hy: half, mask: null };
  }

  // ground height in relative metres at local x/y, with exaggeration applied
  const groundAt = (x, y) => {
    if (!cfg.terrain.on || !sampleElev) return 0;
    const lat = bbox.lat0 + y / 111320;
    const lon = bbox.lon0 + x / (111320 * Math.cos(bbox.lat0 * Math.PI / 180));
    return Math.max(0, (sampleElev(lat, lon) - minElev)) * cfg.terrain.exag;
  };

  const model = new THREE.Group();
  model.name = 'mapforge-model';
  model.add(buildTerrainBlock(groundAt));

  const counts = {};
  if (cfg.buildings.on) {
    const extra = prebaked ? prebakedToPolys(prebaked, project) : null;
    const g = buildBuildings(elements, project, groundAt, extra);
    counts.buildings = g.children.length;
    model.add(g);
  }
  for (const rk of ['majorRoads', 'minorRoads', 'paths']) {
    if (!cfg[rk].on) continue;
    const g = buildRoadClass(elements, project, groundAt, rk);
    counts[rk] = g.children.length;
    model.add(g);
  }
  if (cfg.green.on) {
    const g = buildFlatPolys(elements, project, groundAt, 'green', GREEN_MATCH);
    counts.green = g.children.length;
    model.add(g);
  }
  if (cfg.water.on) {
    const g = buildFlatPolys(elements, project, groundAt, 'water', WATER_MATCH);
    addWaterwayLines(g, elements, project, groundAt);
    counts.water = g.children.length;
    model.add(g);
  }
  return { model, counts };
}

// Convert a pre-baked buildings FeatureCollection into the poly shape the
// building builder consumes ({tags:{height}, outer:[{lat,lon}], holes:[...]}).
function prebakedToPolys(fc, project) {
  const polys = [];
  const toRing = coords => coords.map(([lon, lat]) => ({ lat, lon }));
  for (const ft of (fc.features || [])) {
    const g = ft.geometry; if (!g) continue;
    const h = ft.properties && ft.properties.h;
    const tags = (h != null) ? { height: String(h) } : {};
    const push = rings => {
      if (!rings || !rings.length || rings[0].length < 4) return;
      polys.push({ tags, outer: toRing(rings[0]), holes: rings.slice(1).map(toRing) });
    };
    if (g.type === 'Polygon') push(g.coordinates);
    else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) push(poly);
  }
  return polys;
}

// Load buildings/<slug>.buildings.json (returns null if none exists).
async function loadPrebaked(slug) {
  if (!slug) return null;
  try {
    const res = await fetch('buildings/' + slug + '.buildings.json', { cache: 'force-cache' });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
}

function swapModel() {
  if (!state.last) return null;
  const { model, counts } = buildModel();
  initViewer();
  if (state.model) {
    scene.remove(state.model);
    state.model.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  }
  state.model = model;
  scene.add(model);
  return counts;
}

// Debounced rebuild used by the layer inspector's geometry controls.
let rebuildTimer = null;
function scheduleRebuild() {
  if (!state.last) return;
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    const counts = swapModel();
    if (counts) setStatus(statusLine(counts));
  }, 250);
}

// Route a layer control change to the right rebuild. The backing map is not part
// of the exported 3D model, so it rebuilds independently of the model geometry.
function layerChanged(key) {
  if (key === 'backing') { rebuildBaseLayer(); rebuildTitle3D(); }
  else if (key === 'frame') rebuildFrame();
  else if (key === 'backdrop') rebuildBackdrop();
  else scheduleRebuild();
}

// A geometry-value change; the base depth also shifts the base sheet, frame,
// backdrop and 3D title, so rebuild those too.
function geomChanged(ck) {
  scheduleRebuild();
  if (ck === 'base') { rebuildBaseLayer(); rebuildFrame(); rebuildBackdrop(); rebuildTitle3D(); }
}

function statusLine(counts) {
  const roads = (counts.majorRoads || 0) + (counts.minorRoads || 0) + (counts.paths || 0);
  return `Done — ${counts.buildings || 0} buildings, ${roads} road segments, ${counts.water || 0} water, ${counts.green || 0} green areas.`;
}

/* ============================================================ 3D viewer */

let renderer, scene, camera, controls;

function initViewer() {
  if (renderer) return;
  const el = $('viewer');
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(el.clientWidth, el.clientHeight);
  el.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1117);
  scene.fog = new THREE.Fog(0x0d1117, 2500, 6000);

  camera = new THREE.PerspectiveCamera(50, el.clientWidth / el.clientHeight, 1, 60000);

  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30363d, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(600, 900, 400);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x88aaff, 0.5);
  fill.position.set(-500, 300, -600);
  scene.add(fill);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI / 2.05;

  window.addEventListener('resize', resizeViewer);
  (function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  })();
}

function resizeViewer() {
  if (!renderer) return;
  const el = $('viewer');
  if (!el.clientWidth) return;
  camera.aspect = el.clientWidth / el.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(el.clientWidth, el.clientHeight);
}

function showViewer(on) {
  $('viewer').style.display = on ? 'block' : 'none';
  $('map').style.display = on ? 'none' : 'block';
  $('backBtn').style.display = on ? 'block' : 'none';
  $('dlMenu').style.display = on ? 'block' : 'none';
  if (on) updateDownloadMenu();
  if (on) { $('selBox').style.display = 'none'; resizeViewer(); }
  else { updateSelBox(); map.resize(); }
}
$('backBtn').addEventListener('click', () => showViewer(false));

/* ============================================================ generate */

function setStatus(msg, isError) {
  const el = $('status');
  el.textContent = msg;
  el.className = isError ? 'error' : '';
}
function setLoading(on, text) {
  $('loading').style.display = on ? 'flex' : 'none';
  if (text) $('loadingText').textContent = text;
}

async function generate() {
  if (state.uiMode === 'suburb' && !state.council) {
    setStatus('Choose a suburb from the dropdown first — or switch to Custom mode to build a square area.', true);
    return;
  }
  if (state.uiMode === 'custom' && !state.sizeMeters) {
    setStatus('Choose an area size first.', true);
    return;
  }
  const bbox = currentBBox();
  $('generateBtn').disabled = true;
  setStatus('');
  setLoading(true, 'Fetching OpenStreetMap data…');

  try {
    const osmPromise = fetchOSM(bbox);
    let sampleElev = null;
    if (cfg.terrain.on) {
      setLoading(true, 'Fetching OpenStreetMap data + elevation tiles…');
      try {
        sampleElev = await buildElevationSampler(bbox);
      } catch (e) {
        console.warn('Elevation unavailable, using flat terrain', e);
      }
    }
    // pre-baked real footprints for the selected council (if a file exists)
    const prebaked = await loadPrebaked(state.council && state.council.slug);

    const osm = await osmPromise;
    const elements = osm.elements || [];

    setLoading(true, 'Building 3D geometry…');
    await new Promise(r => setTimeout(r, 30));

    let minElev = 0, maxElev = 0;
    if (sampleElev) {
      minElev = Infinity; maxElev = -Infinity;
      for (let j = 0; j <= 16; j++) {
        for (let i = 0; i <= 16; i++) {
          const lat = bbox.south + (bbox.north - bbox.south) * j / 16;
          const lon = bbox.west + (bbox.east - bbox.west) * i / 16;
          const e = sampleElev(lat, lon);
          minElev = Math.min(minElev, e);
          maxElev = Math.max(maxElev, e);
        }
      }
    }
    // highest terrain elevation of the map (relative metres, exaggeration applied)
    state.maxGround = sampleElev ? Math.max(0, (maxElev - minElev)) * cfg.terrain.exag : 0;

    state.last = { bbox, elements, sampleElev, minElev, prebaked };
    const counts = swapModel();

    // greyscale base sheet the model sits on (preview only; not in 3D exports).
    // The A3 sheet extends well beyond the built 3D area, so fetch a wider slice
    // of OSM context for it — best-effort; fall back to the model data on failure.
    const M = Math.max(2 * EXT.hx, 2 * EXT.hy);   // model's widest side in metres
    let baseElements = elements;
    try {
      const baseBbox = a3BaseBbox(bbox, M);
      setLoading(true, 'Fetching surrounding map for the base sheet…');
      const wider = await Promise.race([
        fetchOSM(baseBbox),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 45000)),
      ]);
      if (wider && wider.elements && wider.elements.length) baseElements = wider.elements;
    } catch (e) {
      console.warn('Wider base-sheet context unavailable, using model data', e);
    }
    // place labels (suburb + postcode) for the backing-map title — best-effort
    await ensurePlaceLabels(bbox);
    state.baseData = { bbox, elements: baseElements, prebaked, M };
    rebuildBaseLayer();
    rebuildFrame();
    rebuildBackdrop();
    rebuildTitle3D();

    const d = (state.mode === 'suburb' && state.council) ? 2 * Math.max(EXT.hx, EXT.hy) : state.sizeMeters;
    camera.position.set(d * 0.9, d * 0.95, d * 0.9);
    controls.target.set(0, 0, 0);
    controls.update();
    scene.fog.near = d * 6;
    scene.fog.far = d * 54;   // +200% draw distance so objects don't vanish when zoomed out

    showViewer(true);
    setStatus(statusLine(counts));
    // Export section stays hidden — downloads are handled by the floating
    // "Download" button on the 3D view.
  } catch (e) {
    console.error(e);
    setStatus('Generation failed: ' + (e.message || e) + ' — try a smaller area or wait a moment (the free OSM server rate-limits).', true);
  } finally {
    setLoading(false);
    $('generateBtn').disabled = false;
  }
}
$('generateBtn').addEventListener('click', generate);
$('clearCache')?.addEventListener('click', clearRequestCache);

/* ============================================================ layer inspector UI */

// Control kinds: color | range | select | toggleRow (layer visibility lives in the header)
const INSPECTOR = [
  { key: 'buildings', label: 'Buildings', toggle: true, group: '3D Suburb', items: [
    ['color', 'Colour', 'color'],
    ['nodes', 'Unmapped buildings (address nodes)', 'check'],
    ['nodeSize', 'Unmapped box size (m)', 'range', 4, 30, 1],
    ['defH', 'Default height (m)', 'range', 2, 40, 1],
    ['scale', 'Height scale', 'range', 0.2, 3, 0.05],
    ['extra', 'Extra height (m)', 'range', 0, 40, 1],
    ['minH', 'Minimum height (m)', 'range', 0, 30, 1],
    ['fit', 'Ground fit', 'select', [['terrain', 'Follow terrain'], ['flat', 'Flat (lowest point)']]],
  ]},
  { key: 'majorRoads', label: 'Roads', toggle: true, toggleAlso: ['minorRoads'], items: [
    ['color', 'Major colour', 'color'],
    ['widthScale', 'Major width scale', 'range', 0.2, 3, 0.05],
    ['lift', 'Major raise above ground (m)', 'range', 0, 5, 0.1],
    ['color', 'Minor colour', 'color', { ck: 'minorRoads' }],
    ['widthScale', 'Minor width scale', 'range', 0.2, 3, 0.05, { ck: 'minorRoads' }],
    ['lift', 'Minor raise above ground (m)', 'range', 0, 5, 0.1, { ck: 'minorRoads' }],
  ]},
  { key: 'paths', label: 'Paths & tracks', toggle: true, items: [
    ['color', 'Colour', 'color'],
    ['widthScale', 'Width scale', 'range', 0.2, 3, 0.05],
    ['lift', 'Raise above ground (m)', 'range', 0, 5, 0.1],
  ]},
  { key: 'green', label: 'Green space', toggle: true, items: [
    ['color', 'Colour', 'color'],
    ['lift', 'Raise above ground (m)', 'range', 0, 5, 0.1],
  ]},
  { key: 'water', label: 'Water', toggle: true, items: [
    ['color', 'Colour', 'color'],
    ['lift', 'Raise above ground (m)', 'range', 0, 5, 0.1],
  ]},
  { key: 'terrain', label: 'Terrain', toggle: true, items: [
    ['color', 'Colour', 'color'],
    ['exag', 'Vertical exaggeration', 'range', 0, 3, 0.05],
    ['res', 'Level of detail', 'range', 32, 160, 16],
    ['color', 'Base colour', 'color', { ck: 'base' }],
    ['depth', 'Base depth (m)', 'range', 1, 100, 1, { ck: 'base' }],
  ]},
  { key: 'backing', label: 'Backing map', toggle: true, group: 'Printable map', items: [
    ['title', 'Title', 'select', [['none', 'No title'], ['postcode', 'Postcode title'], ['suburb', 'Suburb title']]],
    ['title3d', '3D printable title', 'check'],
    ['outline', 'White outline (mm)', 'range', 0, 20, 0.5],
  ]},
  { key: 'frame', label: 'Frame', toggle: true, group: 'Other', items: [
    ['material', 'Material', 'select', [['black', 'Black'], ['white', 'White'], ['silver', 'Silver'], ['wood', 'Wood texture']]],
    ['thickness', 'Thickness (mm)', 'range', 2, 40, 1],
    ['height', 'Height (mm)', 'range', 2, 40, 1],
  ]},
  { key: 'backdrop', label: 'Environment', toggle: true, items: [
    ['style', 'Background', 'select', [['white', 'White wall'], ['brick', 'Brick wall'], ['wood', 'Wooden wall'], ['textured', 'Textured wall']]],
  ]},
];

const MATERIAL_KEYS = new Set(['color', 'metal', 'rough']);

function applyMaterial(layerKey) {
  const m = MATS[layerKey], c = cfg[layerKey];
  m.color.set(c.color);
  m.metalness = c.metal ?? 0;
  m.roughness = c.rough ?? 1;
  m.needsUpdate = true;
}

function buildInspectorUI() {
  const host = $('layersUI');
  for (const layer of INSPECTOR) {
    const c = cfg[layer.key];
    if (layer.group) {
      const sub = document.createElement('div');
      sub.className = 'layer-group';
      sub.textContent = layer.group;
      host.appendChild(sub);
    }
    const wrap = document.createElement('div');
    wrap.className = 'layer';

    const head = document.createElement('div');
    head.className = 'layer-head';

    if (layer.toggle) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = c.on;
      cb.addEventListener('click', e => e.stopPropagation());
      cb.addEventListener('change', () => {
        c.on = cb.checked;
        for (const k of (layer.toggleAlso || [])) cfg[k].on = cb.checked;   // e.g. Roads toggles major + minor
        layerChanged(layer.key);
      });
      head.appendChild(cb);
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'cb-spacer';
      head.appendChild(spacer);
    }

    let sw = null;
    if (c.color !== undefined) {
      sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = c.color;
      head.appendChild(sw);
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'cb-spacer';
      head.appendChild(spacer);
    }

    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = layer.label;
    head.appendChild(name);

    const chev = document.createElement('span');
    chev.className = 'chev';
    chev.textContent = '▸';
    head.appendChild(chev);

    const body = document.createElement('div');
    body.className = 'layer-body';
    body.style.display = 'none';

    // accordion: opening one layer closes any other that's open
    head.addEventListener('click', () => {
      const open = body.style.display !== 'none';
      host.querySelectorAll('.layer-body').forEach(b => b.style.display = 'none');
      host.querySelectorAll('.chev').forEach(ch => ch.textContent = '▸');
      if (!open) { body.style.display = 'block'; chev.textContent = '▾'; }
    });

    for (const item of layer.items) {
      const [prop, label, kind] = item;
      // an item can target a different config object via a trailing {ck:'base'} option
      const last = item[item.length - 1];
      const opts = (last && typeof last === 'object' && !Array.isArray(last)) ? last : null;
      const ck = (opts && opts.ck) || layer.key;
      const cc = cfg[ck];

      const row = document.createElement('div');
      row.className = 'ctl-row';
      const lab = document.createElement('label');
      lab.textContent = label;
      row.appendChild(lab);

      if (kind === 'color') {
        const inp = document.createElement('input');
        inp.type = 'color';
        inp.value = cc[prop];
        inp.addEventListener('input', () => {
          cc[prop] = inp.value;
          if (sw && ck === layer.key) sw.style.background = inp.value;
          applyMaterial(ck);
        });
        row.appendChild(inp);
      } else if (kind === 'check') {
        const inp = document.createElement('input');
        inp.type = 'checkbox';
        inp.checked = !!cc[prop];
        inp.style.accentColor = '#4f8cff';
        inp.style.width = '15px';
        inp.style.height = '15px';
        inp.style.cursor = 'pointer';
        inp.addEventListener('change', () => { cc[prop] = inp.checked; layerChanged(layer.key); });
        row.appendChild(inp);
      } else if (kind === 'select') {
        const sel = document.createElement('select');
        for (const [val, text] of item[3]) {
          const o = document.createElement('option');
          o.value = val; o.textContent = text;
          sel.appendChild(o);
        }
        sel.value = cc[prop];
        sel.addEventListener('change', () => { cc[prop] = sel.value; layerChanged(layer.key); });
        row.appendChild(sel);
      } else { // range
        const [, , , min, max, step] = item;
        const inp = document.createElement('input');
        inp.type = 'range';
        inp.min = min; inp.max = max; inp.step = step;
        inp.value = cc[prop];
        const val = document.createElement('span');
        val.className = 'ctl-val';
        val.textContent = cc[prop];
        inp.addEventListener('input', () => {
          cc[prop] = Number(inp.value);
          val.textContent = inp.value;
          if (MATERIAL_KEYS.has(prop)) applyMaterial(ck);
          else geomChanged(ck);
        });
        row.appendChild(inp);
        row.appendChild(val);
      }
      body.appendChild(row);
    }

    wrap.appendChild(head);
    wrap.appendChild(body);
    host.appendChild(wrap);
  }
}
buildInspectorUI();
// warm up the title font so the flat + 3D titles are ready on first generate
loadTitleFont().catch(() => {});

/* ============================================================ base map layer */

// lat/lon bbox covering the whole A3 sheet at the model's print scale, so we can
// fetch the surrounding map that extends beyond the 3D render.
function a3BaseBbox(bbox, M) {
  const mPerMM = M / MODEL_PRINT_MM;                    // metres per printed mm
  const xHalf = (A3_W / 2) * mPerMM;
  const yNorth = MODEL_CY_MM * mPerMM;                  // from model centre up to the top edge
  const ySouth = (A3_H - MODEL_CY_MM) * mPerMM;         // down to the bottom edge
  const mLat = 111320, mLon = 111320 * Math.cos(bbox.lat0 * Math.PI / 180);
  return {
    north: bbox.lat0 + yNorth / mLat, south: bbox.lat0 - ySouth / mLat,
    east: bbox.lon0 + xHalf / mLon, west: bbox.lon0 - xHalf / mLon,
    lat0: bbox.lat0, lon0: bbox.lon0,
  };
}

// Draw a flat greyscale map of the whole A3 sheet (raw geometry, no boundary
// clip — this is the surrounding context the 3D model sits within).
function buildFlatMapCanvas(project, elements, extraBuildingPolys, M) {
  const s = MODEL_PRINT_MM / M;          // printed mm per metre
  const pxmm = 8;
  const W = Math.round(A3_W * pxmm), H = Math.round(A3_H * pxmm);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  // local metres (origin = model centre, +y = north) → canvas px
  const toPx = ([x, y]) => [(MODEL_CX_MM + x * s) * pxmm, (MODEL_CY_MM - y * s) * pxmm];
  const ringPath = ring => { ctx.moveTo(...toPx(ring[0])); for (let i = 1; i < ring.length; i++) ctx.lineTo(...toPx(ring[i])); ctx.closePath(); };

  ctx.fillStyle = '#f0f0f0'; ctx.fillRect(0, 0, W, H);   // land background

  const fillPolys = (match, style) => {
    ctx.fillStyle = style; ctx.beginPath();
    for (const poly of collectPolygons(elements, match)) {
      ringPath(ringFromGeometry(poly.outer, project));
      for (const h of poly.holes || []) ringPath(ringFromGeometry(h, project));
    }
    ctx.fill('evenodd');
  };
  const strokeLines = (predicate, widthFn, style) => {
    ctx.strokeStyle = style; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const el of elements) {
      if (el.type !== 'way' || !el.tags || !el.geometry || !predicate(el.tags)) continue;
      ctx.lineWidth = Math.max(1, widthFn(el.tags) * s * pxmm);
      const pts = ringFromGeometry(el.geometry, project);
      ctx.beginPath(); ctx.moveTo(...toPx(pts[0]));
      for (let i = 1; i < pts.length; i++) ctx.lineTo(...toPx(pts[i]));
      ctx.stroke();
    }
  };

  fillPolys(GREEN_MATCH, '#dcdcdc');
  fillPolys(WATER_MATCH, '#c6c6c6');
  strokeLines(t => WATERWAY_WIDTHS[t.waterway] && t.tunnel !== 'yes' && t.tunnel !== 'culvert',
    t => WATERWAY_WIDTHS[t.waterway], '#c6c6c6');
  strokeLines(t => t.highway && roadClass(t.highway) === 'paths' && t.area !== 'yes',
    t => (ROAD_WIDTHS[t.highway] || 5) * cfg.paths.widthScale, '#c8c8c8');
  strokeLines(t => t.highway && roadClass(t.highway) === 'minorRoads' && t.area !== 'yes',
    t => (ROAD_WIDTHS[t.highway] || 5) * cfg.minorRoads.widthScale, '#8c8c8c');
  strokeLines(t => t.highway && roadClass(t.highway) === 'majorRoads' && t.area !== 'yes',
    t => (ROAD_WIDTHS[t.highway] || 5) * cfg.majorRoads.widthScale, '#6a6a6a');

  // buildings (OSM + any pre-baked), drawn raw
  ctx.fillStyle = '#9a9a9a'; ctx.beginPath();
  for (const poly of collectPolygons(elements, t => t['building'] !== undefined)) {
    ringPath(ringFromGeometry(poly.outer, project));
    for (const h of poly.holes || []) ringPath(ringFromGeometry(h, project));
  }
  if (extraBuildingPolys) for (const poly of extraBuildingPolys) {
    ringPath(ringFromGeometry(poly.outer, project));
    for (const h of poly.holes || []) ringPath(ringFromGeometry(h, project));
  }
  ctx.fill('evenodd');

  // Optional large greyscale title on the empty band above the 3D render, drawn
  // from the SAME font as the 3D title so the two line up exactly. Never let a
  // title-drawing hiccup abort the whole backing map.
  try { drawBackingTitle(ctx, toPx, s, pxmm); } catch (e) { console.warn('Backing title skipped', e); }

  return canvas;
}

// Which title (if any) to print on the backing map.
function backingTitleText() {
  const mode = cfg.backing.title;
  if (mode === 'postcode') {
    return (state.council && state.council.postcode)
      || (state.placeLabels && state.placeLabels.postcode) || '';
  }
  if (mode === 'suburb') {
    const name = (state.council && state.council.name)
      || (state.placeLabels && state.placeLabels.suburb) || '';
    return name.toUpperCase();
  }
  return '';
}

// Bounding box of a set of font shapes (outer contours).
function shapesBounds(shapes) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const sh of shapes) {
    for (const p of sh.getPoints(6)) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
  }
  return { minX, maxX, minY, maxY };
}

// Shared layout for BOTH the flat and 3D titles: same font glyphs, same size,
// same centre — so the 3D title sits exactly over the printed one. Returns local
// metres (origin = model centre, +y = north). Needs the title font loaded.
function titleLayout(font) {
  const text = backingTitleText();
  if (!text || !font || !state.baseData) return null;
  const M = state.baseData.M;
  const metresPerMM = M / MODEL_PRINT_MM;
  const W = 2 * EXT.hx;                                   // width = model footprint width
  const sheetTopLocalY = MODEL_CY_MM * metresPerMM;       // north edge of the A3 sheet
  const modelNorthLocalY = EXT.hy;                        // north edge of the model
  const bandCentreY = (sheetTopLocalY + modelNorthLocalY) / 2;
  const maxH = 0.7 * Math.max(1, sheetTopLocalY - modelNorthLocalY);
  let probe;
  try { probe = font.generateShapes(text, 100); } catch (e) { return null; }
  const pb = shapesBounds(probe);
  const w0 = (pb.maxX - pb.minX) || 1, h0 = (pb.maxY - pb.minY) || 1;
  let size = 100 * W / w0;
  if (h0 * size / 100 > maxH) size = 100 * maxH / h0;    // clamp so it fits the band
  const shapes = font.generateShapes(text, size);
  const b = shapesBounds(shapes);
  return { text, size, shapes, cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, bandCentreY };
}

// Draw the flat greyscale title (white outline + grey fill) from the font shapes.
function drawBackingTitle(ctx, toPx, s, pxmm) {
  const lay = titleLayout(_titleFont);
  if (!lay) return;
  const buildPath = () => {
    ctx.beginPath();
    for (const shape of lay.shapes) {
      const ep = shape.extractPoints(6);
      const contour = (pts) => {
        pts.forEach((p, i) => {
          const px = toPx([p.x - lay.cx, p.y - lay.cy + lay.bandCentreY]);
          if (i === 0) ctx.moveTo(px[0], px[1]); else ctx.lineTo(px[0], px[1]);
        });
        ctx.closePath();
      };
      contour(ep.shape);
      for (const h of ep.holes) contour(h);
    }
  };
  ctx.save();
  ctx.lineJoin = 'round';
  const outlinePx = (cfg.backing.outline || 0) * pxmm;       // outline in mm → px
  if (outlinePx > 0) { buildPath(); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = outlinePx; ctx.stroke(); }
  buildPath(); ctx.fillStyle = '#7a7a7a'; ctx.fill('evenodd');   // always greyscale
  ctx.restore();
}

function buildBaseLayer(bbox, elements, prebaked, M) {
  const project = makeProjector(bbox.lat0, bbox.lon0);
  const extra = prebaked ? prebakedToPolys(prebaked, project) : null;
  const canvas = buildFlatMapCanvas(project, elements, extra, M);
  const baseY = -Math.max(0.5, cfg.base.depth) - 0.2;   // just under the model

  if (state.baseLayer) {
    scene.remove(state.baseLayer);
    state.baseLayer.geometry.dispose();
    if (state.baseLayer.material.map) state.baseLayer.material.map.dispose();
    state.baseLayer.material.dispose();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = MODEL_PRINT_MM / M;                          // mm per metre
  const mPerMM = 1 / s;
  // world extents of the A3 sheet (world z = -y; north = -z)
  const xHalf = (A3_W / 2) * mPerMM;
  const zNorth = -MODEL_CY_MM * mPerMM;                  // top edge (north)
  const zSouth = (A3_H - MODEL_CY_MM) * mPerMM;          // bottom edge (south)
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    -xHalf, baseY, zNorth,  xHalf, baseY, zNorth,  -xHalf, baseY, zSouth,  xHalf, baseY, zSouth], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 0, 0, 1, 0], 2));
  g.setIndex([0, 2, 3, 0, 3, 1]);
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
  mesh.name = 'basemap';
  state.baseLayer = mesh;
  scene.add(mesh);

  state.basePdf = { canvas, wmm: A3_W, hmm: A3_H };      // A3 portrait
}

function removeBaseLayer() {
  if (state.baseLayer) {
    scene.remove(state.baseLayer);
    state.baseLayer.geometry.dispose();
    if (state.baseLayer.material.map) state.baseLayer.material.map.dispose();
    state.baseLayer.material.dispose();
    state.baseLayer = null;
  }
  state.basePdf = null;
}

// (Re)build the backing map from cached inputs — used on first generate and
// whenever the Backing map layer's toggle or title changes. The sheet is built
// immediately (so it always appears); if the title font isn't ready yet the
// sheet is redrawn with the title once the font loads.
function rebuildBaseLayer() {
  removeBaseLayer();
  if (cfg.backing.on && state.baseData) {
    const { bbox, elements, prebaked, M } = state.baseData;
    buildBaseLayer(bbox, elements, prebaked, M);
    if (backingTitleText() && !_titleFont) {
      loadTitleFont().then(() => {
        if (cfg.backing.on && state.baseData) {
          removeBaseLayer();
          const d = state.baseData;
          buildBaseLayer(d.bbox, d.elements, d.prebaked, d.M);
          updateBaseUI();
        }
      }).catch(() => {});
    }
  }
  updateBaseUI();
}

// Show the base-map PDF export only when the backing map is switched on.
function updateBaseUI() {
  const on = !!cfg.backing.on;
  if ($('expPdf')) $('expPdf').style.display = on ? 'block' : 'none';
  if ($('pdfHint')) $('pdfHint').style.display = on ? 'block' : 'none';
}

/* ---------- decorative frame (preview only; never exported) ---------- */

// A picture-frame border around the A3 base sheet, ~15 mm thick and 15 mm tall
// at print scale. Added straight to the scene (not state.model / not the PDF
// canvas), so it never appears in the GLB/STL/OBJ or the printed base map.
function boxBetween(x0, x1, y0, y1, z0, z1, mat) {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return new THREE.Mesh(g, mat);
}

function woodTexture() {
  const S = 1024;
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const g = c.getContext('2d');
  const tones = [[142, 98, 58], [124, 84, 46], [158, 112, 68], [112, 74, 42], [148, 102, 60], [132, 90, 52]];
  let x = 0, p = 0;
  while (x < S) {
    const pw = 150 + Math.random() * 90;                 // varied plank widths
    const t = tones[p % tones.length];
    const grd = g.createLinearGradient(x, 0, x + pw, 0);
    grd.addColorStop(0, `rgb(${t[0] - 12},${t[1] - 9},${t[2] - 7})`);
    grd.addColorStop(0.5, `rgb(${t[0]},${t[1]},${t[2]})`);
    grd.addColorStop(1, `rgb(${t[0] - 10},${t[1] - 7},${t[2] - 5})`);
    g.fillStyle = grd; g.fillRect(x, 0, pw, S);
    // cathedral grain: nested arcs around a plank centre
    const cx = x + pw * (0.3 + Math.random() * 0.4);
    for (let i = 0; i < 46; i++) {
      const off = (i - 23) * (pw / 46);
      g.strokeStyle = `rgba(58,36,16,${0.08 + Math.random() * 0.13})`;
      g.lineWidth = 0.6 + Math.random() * 1.4;
      g.beginPath();
      const gx = cx + off;
      g.moveTo(gx, -20);
      g.bezierCurveTo(cx + off * 0.55, S * 0.35, cx + off * 1.5, S * 0.66, gx + (Math.random() * 8 - 4), S + 20);
      g.stroke();
    }
    // knots
    if (Math.random() < 0.5) {
      const ky = Math.random() * S, kx = x + pw * (0.3 + Math.random() * 0.4);
      for (let r = 26; r > 0; r -= 2.5) {
        g.strokeStyle = `rgba(42,24,9,${0.55 - r * 0.014})`; g.lineWidth = 1.6;
        g.beginPath(); g.ellipse(kx, ky, r * 0.6, r, Math.random() * 0.5, 0, Math.PI * 2); g.stroke();
      }
    }
    // groove between planks (shadow + highlight)
    g.fillStyle = 'rgba(0,0,0,0.30)'; g.fillRect(x, 0, 4, S);
    g.fillStyle = 'rgba(255,236,208,0.06)'; g.fillRect(x + 4, 0, 2, S);
    x += pw; p++;
  }
  // faint overall fibre speckle
  for (let i = 0; i < 20000; i++) { const sx = Math.random() * S, sy = Math.random() * S, a = Math.random() * 0.05; g.fillStyle = Math.random() < 0.5 ? `rgba(0,0,0,${a})` : `rgba(255,240,215,${a})`; g.fillRect(sx, sy, 1.2, 1.2); }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function frameMaterial(kind) {
  if (kind === 'wood') {
    return new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.7, metalness: 0.0, side: THREE.DoubleSide });
  }
  if (kind === 'silver') return new THREE.MeshStandardMaterial({ color: 0xc8ccd0, roughness: 0.3, metalness: 0.9, side: THREE.DoubleSide });
  if (kind === 'white')  return new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide });
  return new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.55, metalness: 0.15, side: THREE.DoubleSide }); // black
}

function removeFrame() {
  if (state.frame) {
    scene.remove(state.frame);
    state.frame.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
    });
    state.frame = null;
  }
}

function buildFrame(M) {
  const mPerMM = M / MODEL_PRINT_MM;
  const xHalf = (A3_W / 2) * mPerMM;
  const zNorth = -MODEL_CY_MM * mPerMM;
  const zSouth = (A3_H - MODEL_CY_MM) * mPerMM;
  const t = (cfg.frame.thickness || 10) * mPerMM;        // frame thickness
  const h = (cfg.frame.height || 10) * mPerMM;           // frame height
  const yb = -Math.max(0.5, cfg.base.depth) - 0.2;       // base-sheet level
  const y0 = yb, y1 = yb + h;
  const mat = frameMaterial(cfg.frame.material);
  const grp = new THREE.Group();
  grp.name = 'frame';
  const ox0 = -xHalf - t, ox1 = xHalf + t, oz0 = zNorth - t, oz1 = zSouth + t;
  grp.add(boxBetween(ox0, ox1, y0, y1, oz0, zNorth, mat));   // north strip (full outer width)
  grp.add(boxBetween(ox0, ox1, y0, y1, zSouth, oz1, mat));   // south strip
  grp.add(boxBetween(ox0, -xHalf, y0, y1, zNorth, zSouth, mat)); // west strip
  grp.add(boxBetween(xHalf, ox1, y0, y1, zNorth, zSouth, mat));  // east strip
  state.frame = grp;
  scene.add(grp);
}

// (Re)build the frame from cached inputs — on generate and on any Frame change.
function rebuildFrame() {
  removeFrame();
  if (cfg.frame.on && state.baseData) buildFrame(state.baseData.M);
}

/* ---------- backdrop wall + floor (preview only; never exported) ---------- */

function brickTexture() {
  const S = 1024;
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const g = c.getContext('2d');
  // mortar base — cementy grey with grain and soft shading
  g.fillStyle = '#bcb4a4'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 16000; i++) { const x = Math.random() * S, y = Math.random() * S, a = Math.random() * 0.08; g.fillStyle = Math.random() < 0.5 ? `rgba(0,0,0,${a})` : `rgba(255,255,255,${a})`; g.fillRect(x, y, 1.5, 1.5); }
  const bw = 210, bh = 74, m = 16;   // brick + mortar gap
  const brickCols = [[152, 62, 48], [170, 74, 54], [134, 52, 42], [178, 88, 62], [120, 46, 40], [158, 68, 50], [110, 58, 52]];
  let row = 0;
  for (let y = -bh; y < S + bh; y += bh + m) {
    const off = (row % 2) ? -(bw + m) / 2 : 0;
    for (let x = off - bw; x < S + bw; x += bw + m) {
      const base = brickCols[Math.floor(Math.random() * brickCols.length)];
      const jit = k => Math.max(0, Math.min(255, base[k] + (Math.random() * 34 - 17))) | 0;
      const yy = y + (Math.random() * 3 - 1.5), hh = bh + (Math.random() * 3 - 1.5);
      g.fillStyle = `rgb(${jit(0)},${jit(1)},${jit(2)})`;
      g.fillRect(x, yy, bw, hh);
      // mottling / weathering within the brick
      for (let k = 0; k < 90; k++) { const sx = x + Math.random() * bw, sy = yy + Math.random() * hh, a = Math.random() * 0.14; g.fillStyle = Math.random() < 0.55 ? `rgba(0,0,0,${a})` : `rgba(255,236,214,${a * 0.7})`; g.fillRect(sx, sy, 3, 3); }
      // bevel: top/left highlight, bottom/right shadow
      g.fillStyle = 'rgba(255,238,222,0.10)'; g.fillRect(x, yy, bw, 4); g.fillRect(x, yy, 4, hh);
      g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(x, yy + hh - 4, bw, 4); g.fillRect(x + bw - 4, yy, 4, hh);
    }
    row++;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// Rendered/troweled plaster wall: warm off-white with soft mottling, sweeping
// trowel marks and a fine sand speckle.
function plasterTexture() {
  const S = 1024;
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#e8e3d9'; g.fillRect(0, 0, S, S);       // warm render base
  // soft mottled patches (light + shadow)
  for (let i = 0; i < 130; i++) {
    const x = Math.random() * S, y = Math.random() * S, r = 60 + Math.random() * 180;
    const light = Math.random() < 0.5, a = 0.04 + Math.random() * 0.06;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, light ? `rgba(255,252,244,${a})` : `rgba(118,108,92,${a})`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  // trowel sweeps — long faint curved strokes
  for (let i = 0; i < 70; i++) {
    const x = Math.random() * S, y = Math.random() * S, len = 120 + Math.random() * 300;
    const ang = (Math.random() * 0.7 - 0.35) + (Math.random() < 0.5 ? 0 : Math.PI / 2);
    g.strokeStyle = Math.random() < 0.5 ? `rgba(255,255,250,0.05)` : `rgba(88,80,68,0.05)`;
    g.lineWidth = 14 + Math.random() * 26; g.lineCap = 'round';
    g.beginPath(); g.moveTo(x, y);
    g.quadraticCurveTo(x + Math.cos(ang) * len * 0.5 + (Math.random() * 40 - 20), y + Math.sin(ang) * len * 0.5,
      x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    g.stroke();
  }
  // fine sand speckle
  for (let i = 0; i < 26000; i++) { const x = Math.random() * S, y = Math.random() * S, a = Math.random() * 0.06; g.fillStyle = Math.random() < 0.5 ? `rgba(0,0,0,${a})` : `rgba(255,255,255,${a})`; g.fillRect(x, y, 1, 1); }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function backdropMaterial(style) {
  // polygonOffset pushes the backdrop away in the depth buffer so it can never
  // overdraw the (nearly coplanar) base sheet / frame sitting in front of it.
  const common = { roughness: 0.9, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 3, polygonOffsetUnits: 3 };
  if (style === 'brick') return new THREE.MeshStandardMaterial({ ...common, map: brickTexture() });
  if (style === 'wood') return new THREE.MeshStandardMaterial({ ...common, map: woodTexture(), roughness: 0.7 });
  if (style === 'textured') return new THREE.MeshStandardMaterial({ ...common, map: plasterTexture(), roughness: 0.95 });
  return new THREE.MeshStandardMaterial({ ...common, color: 0xf4f4f2, roughness: 0.95 }); // white wall
}

function removeBackdrop() {
  if (state.backdrop) {
    scene.remove(state.backdrop);
    state.backdrop.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
    });
    state.backdrop = null;
  }
}

function buildBackdrop(M) {
  const mPerMM = M / MODEL_PRINT_MM;
  const xHalf = (A3_W / 2) * mPerMM;
  const zNorth = -MODEL_CY_MM * mPerMM;
  const zSouth = (A3_H - MODEL_CY_MM) * mPerMM;
  const frameT = (cfg.frame.on ? (cfg.frame.thickness || 10) : 0) * mPerMM;
  const yb = -Math.max(0.5, cfg.base.depth) - 0.2;

  // Backdrop half-extent: the framed piece's padded footprint, widened out.
  const paddedHalf = xHalf + frameT + xHalf * 0.9;
  const halfW = paddedHalf * 8;                          // very wide backdrop
  const padZ = (zSouth - zNorth) * 0.45;
  const fx0 = -halfW, fx1 = halfW;
  // depth (the flat backdrop's on-screen "height") extended by 300% (×4 about its centre)
  const bz0 = zNorth - frameT - padZ, bz1 = zSouth + frameT + padZ;
  const midZ = (bz0 + bz1) / 2, halfD = (bz1 - bz0) / 2 * 4;
  const fz0 = midZ - halfD, fz1 = midZ + halfD;
  const floorW = fx1 - fx0, floorD = fz1 - fz0;
  const floorY = yb - Math.max(2, (zSouth - zNorth) * 0.02);   // clearly below the sheet
  // world size of one texture tile; larger tile = fewer repeats = bigger pattern.
  // Brick is zoomed 16× (400% × 400%) and wood 4× relative to the base tile.
  const styleScale = ({ brick: 16, wood: 4 })[cfg.backdrop.style] || 1;
  const tile = Math.max(xHalf * 0.5, 1) * styleScale;

  const grp = new THREE.Group();
  grp.name = 'backdrop';

  // floor only — a single flat surface parallel to the backing map (no vertical wall)
  const floorMat = backdropMaterial(cfg.backdrop.style);
  if (floorMat.map) floorMat.map.repeat.set(Math.max(1, Math.round(floorW / tile)), Math.max(1, Math.round(floorD / tile)));
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(floorW, floorD), floorMat);
  floor.geometry.rotateX(-Math.PI / 2);                  // lie flat, normal up
  floor.geometry.translate((fx0 + fx1) / 2, floorY, (fz0 + fz1) / 2);

  grp.add(floor);
  state.backdrop = grp;
  scene.add(grp);
}

function rebuildBackdrop() {
  removeBackdrop();
  if (cfg.backdrop.on && state.baseData) buildBackdrop(state.baseData.M);
}

/* ---------- 3D printable title (preview + separate export) ---------- */

function loadTitleFont() {
  if (_titleFont) return Promise.resolve(_titleFont);
  if (!_titleFontPromise) {
    _titleFontPromise = new Promise((resolve, reject) => {
      new FontLoader().load(
        'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/fonts/helvetiker_bold.typeface.json',
        f => { _titleFont = f; resolve(f); }, undefined, reject);
    });
  }
  return _titleFontPromise;
}

function removeTitle3D() {
  if (state.titleObj) {
    scene.remove(state.titleObj);
    if (state.titleObj.geometry) state.titleObj.geometry.dispose();
    if (state.titleObj.material) state.titleObj.material.dispose();
    state.titleObj = null;
  }
}

// Build an extruded 3D version of the suburb/postcode title, standing on the
// base sheet in the band north of the model. Its standing height equals the
// map's highest elevation. Added to the scene only (not state.model), so it is
// excluded from the main 3D exports and printed base map — it has its own export.
async function buildTitle3D() {
  if (!state.baseData) return;
  let font;
  try { font = await loadTitleFont(); }
  catch (e) { console.warn('Title font failed to load', e); setStatus('Could not load the 3D title font.', true); return; }
  // guard against a stale rebuild (toggle flipped off while the font loaded)
  if (!cfg.backing.title3d || !cfg.backing.on) return;

  // identical layout to the flat title → the 3D title sits exactly over it
  const lay = titleLayout(font);
  if (!lay) return;
  const depth = Math.max(state.maxGround || 0, 15);     // standing height = highest elevation

  let geo = new TextGeometry(lay.text, { font, size: lay.size, height: depth, curveSegments: 5, bevelEnabled: false });
  // orient upright: extrusion → world +y (up); glyph tops point north; readable from above
  geo.rotateX(-Math.PI / 2);
  geo.computeBoundingBox();
  const bb = geo.boundingBox;

  // footprint centre → world (x=0, z=-bandCentreY); base sits on the base sheet
  const worldZ = -lay.bandCentreY;                      // north = -z
  const yb = -Math.max(0.5, cfg.base.depth) - 0.2;
  geo.translate(
    0 - (bb.min.x + bb.max.x) / 2,
    yb - bb.min.y,
    worldZ - (bb.min.z + bb.max.z) / 2,
  );
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(cfg.majorRoads.color), roughness: 0.8, metalness: 0.05, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'Title';
  state.titleObj = mesh;
  scene.add(mesh);
}

function rebuildTitle3D() {
  removeTitle3D();
  if (cfg.backing.on && cfg.backing.title3d && state.baseData) buildTitle3D();
  updateTitleExportUI();
}

// Show the separate 3D-title export only when the 3D title is switched on.
function updateTitleExportUI() {
  const on = !!(cfg.backing.on && cfg.backing.title3d);
  if ($('expTitle')) $('expTitle').style.display = on ? 'block' : 'none';
  if ($('titleHint')) $('titleHint').style.display = on ? 'block' : 'none';
  if (typeof updateDownloadMenu === 'function') updateDownloadMenu();
}

/* ============================================================ export */

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// Export the model as a colour 3MF: one object per layer colour, each tagged with
// its own base material so Bambu Studio (and other slicers) keep the layer colours
// and can map them to filaments/AMS. Oriented Z-up so it loads flat with the
// buildings on top, and pre-scaled so the model is 200 mm across (like the STL).
function writeColour3MF(root, filename) {
  const modelMax = Math.max(2 * EXT.hx, 2 * EXT.hy);
  const scale = 200 / modelMax;
  root.updateMatrixWorld(true);

  // group all triangles by LAYER (so each layer becomes its own named, coloured
  // object that Bambu Studio can map to a filament)
  const groups = new Map();
  const v = new THREE.Vector3();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, minZ = Infinity, maxZ = -Infinity;
  root.traverse(o => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    const col = (o.material && o.material.color) ? o.material.color.getHexString() : 'cccccc';
    const key = MAT2KEY.get(o.material) || ('colour_' + col);
    const name = LAYER_LABELS[key] || o.name || key;
    let g = groups.get(key);
    if (!g) { g = { key, name, color: col, verts: [], tris: [] }; groups.set(key, g); }
    const pos = o.geometry.attributes.position, idx = o.geometry.index;
    const base = g.verts.length / 3;
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(o.matrixWorld);
      g.verts.push(v.x, v.y, v.z);
      if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
    }
    if (idx) for (let i = 0; i < idx.count; i += 3) g.tris.push(base + idx.getX(i), base + idx.getX(i + 1), base + idx.getX(i + 2));
    else for (let i = 0; i < pos.count; i += 3) g.tris.push(base + i, base + i + 1, base + i + 2);
  });
  if (!groups.size) { setStatus('Nothing to export.', true); return 0; }

  const midX = (minX + maxX) / 2, midZ = (minZ + maxZ) / 2;
  // three (x,y,z) → 3MF Z-up (X,Y,Z): rotate Y→Z (flat, buildings up),
  // centre in X/Y and drop the base onto Z=0, then scale to mm.
  const mapV = (x, y, z) => [((x - midX) * scale), (-(z - midZ) * scale), ((y - minY) * scale)];

  const esc = (str) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const arr = [...groups.values()];
  const matXml = arr.map((g) => `<base name="${esc(g.name)}" displaycolor="#${g.color.toUpperCase()}FF"/>`).join('');
  let objXml = '', itemXml = '';
  arr.forEach((g, i) => {
    const oid = i + 2;
    const vs = [];
    for (let k = 0; k < g.verts.length; k += 3) {
      const p = mapV(g.verts[k], g.verts[k + 1], g.verts[k + 2]);
      vs.push(`<vertex x="${p[0].toFixed(3)}" y="${p[1].toFixed(3)}" z="${p[2].toFixed(3)}"/>`);
    }
    const ts = [];
    for (let k = 0; k < g.tris.length; k += 3) ts.push(`<triangle v1="${g.tris[k]}" v2="${g.tris[k + 1]}" v3="${g.tris[k + 2]}"/>`);
    objXml += `<object id="${oid}" name="${esc(g.name)}" type="model" pid="1" pindex="${i}"><mesh><vertices>${vs.join('')}</vertices><triangles>${ts.join('')}</triangles></mesh></object>`;
    itemXml += `<item objectid="${oid}"/>`;
  });

  const model = `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">`
    + `<resources><basematerials id="1">${matXml}</basematerials>${objXml}</resources>`
    + `<build>${itemXml}</build></model>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;

  const zipped = zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    '3D/3dmodel.model': strToU8(model),
  });
  download(new Blob([zipped], { type: 'model/3mf' }), filename);
  return arr.length;
}

function exportColour3MF() {
  if (!state.model) return;
  setStatus('Exporting colour 3MF…');
  try {
    const n = writeColour3MF(state.model, state.modelName + '.3mf');
    if (n) setStatus(`Colour 3MF exported — ${n} colour groups, flat, 200 mm across.`);
  } catch (e) { console.error(e); setStatus('3MF export failed: ' + e.message, true); }
}

function exportTitle3MF() {
  if (!state.titleObj) { setStatus('Turn on the 3D printable title first.', true); return; }
  setStatus('Exporting 3D text 3MF…');
  try {
    writeColour3MF(state.titleObj, state.modelName + '-title.3mf');
    setStatus('3D text 3MF exported (flat, scaled to match the 200 mm model).');
  } catch (e) { console.error(e); setStatus('3D text export failed: ' + e.message, true); }
}

$('expGlb')?.addEventListener('click', () => {
  if (!state.model) return;
  setStatus('Exporting GLB…');
  new GLTFExporter().parse(
    state.model,
    (result) => {
      download(new Blob([result], { type: 'model/gltf-binary' }), state.modelName + '.glb');
      setStatus('GLB exported.');
    },
    (err) => setStatus('GLB export failed: ' + err, true),
    { binary: true }
  );
});

$('expStl')?.addEventListener('click', () => {
  if (!state.model) return;
  setStatus('Exporting STL…');
  try {
    const modelMax = Math.max(2 * EXT.hx, 2 * EXT.hy); // model's widest side in metres
    const clone = state.model.clone(true);
    clone.rotation.x = Math.PI / 2;         // Y-up → Z-up so it loads flat, buildings up
    clone.scale.setScalar(200 / modelMax);
    clone.updateMatrixWorld(true);
    const result = new STLExporter().parse(clone, { binary: true });
    download(new Blob([result], { type: 'application/octet-stream' }), state.modelName + '.stl');
    setStatus('STL exported (single colour, flat, scaled to 200 mm across).');
  } catch (e) { setStatus('STL export failed: ' + e.message, true); }
});

$('expObj')?.addEventListener('click', () => {
  if (!state.model) return;
  setStatus('Exporting OBJ…');
  try {
    const result = new OBJExporter().parse(state.model);
    download(new Blob([result], { type: 'text/plain' }), state.modelName + '.obj');
    setStatus('OBJ exported.');
  } catch (e) { setStatus('OBJ export failed: ' + e.message, true); }
});

$('exp3mf')?.addEventListener('click', exportColour3MF);

function exportBasePdf() {
  if (!state.basePdf) { setStatus('Turn on the Backing map layer first.', true); return; }
  setStatus('Exporting base map PDF…');
  try {
    const { canvas, wmm, hmm } = state.basePdf;
    const pdf = new jsPDF({ orientation: wmm >= hmm ? 'l' : 'p', unit: 'mm',
      format: [Math.min(wmm, hmm), Math.max(wmm, hmm)] });
    const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, pw, ph);
    pdf.save(state.modelName + '-basemap.pdf');
    setStatus(`Base map PDF exported (${pw.toFixed(0)}×${ph.toFixed(0)} mm — print at 100%).`);
  } catch (e) { setStatus('PDF export failed: ' + e.message, true); }
}
$('expPdf')?.addEventListener('click', exportBasePdf);
$('expTitle')?.addEventListener('click', exportTitle3MF);

// download menu on the 3D view
document.querySelectorAll('#dlOptions button').forEach(b => {
  b.addEventListener('click', () => {
    const k = b.dataset.dl;
    if (k === 'pdf') exportBasePdf();
    else if (k === 'model') exportColour3MF();
    else if (k === 'text') exportTitle3MF();
  });
});

// the "3D Text · 3MF" download option only makes sense when the 3D title is on
function updateDownloadMenu() {
  const t = document.querySelector('#dlOptions button[data-dl="text"]');
  if (t) t.style.display = (cfg.backing.on && cfg.backing.title3d) ? 'block' : 'none';
}
updateDownloadMenu();
