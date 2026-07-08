// MapForge 3D — generate 3D models of real places from OpenStreetMap data.
// Original implementation. Data: © OpenStreetMap contributors (ODbL);
// elevation: Terrain Tiles on AWS (Mapzen terrarium encoding).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import polygonClipping from 'https://esm.sh/polygon-clipping@0.15.7';
import { jsPDF } from 'https://esm.sh/jspdf@2.5.1';

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
  base:       {            color: '#3a4048', metal: 0.0,  rough: 1.0,  depth: 12 },
  backing:    { on: true,  title: 'none' },
  buildings:  { on: true,  color: '#c9d4e4', metal: 0.1,  rough: 0.85, defH: 8, scale: 1, extra: 0, minH: 0, fit: 'terrain', nodes: true, nodeSize: 10 },
  majorRoads: { on: true,  color: '#2e3947', metal: 0.0,  rough: 1.0,  widthScale: 1, lift: 2.5 },
  minorRoads: { on: true,  color: '#3a4353', metal: 0.0,  rough: 1.0,  widthScale: 1, lift: 2.0 },
  paths:      { on: true,  color: '#55606f', metal: 0.0,  rough: 1.0,  widthScale: 1, lift: 0.3 },
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

const $ = (id) => document.getElementById(id);

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
  $('councilHint').style.display = 'none';
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
      const hint = $('councilHint');
      hint.style.display = 'block';
      hint.textContent = `Suburb mode: the whole of ${suburb.name} will be built to its real boundary. Real footprints load automatically if you've added buildings/${suburb.slug}.buildings.json.`;
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
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
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
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
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
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
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

  let lastErr;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (!res.ok) throw new Error('Overpass HTTP ' + res.status);
      return await res.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Overpass unavailable');
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
        const img = new Image();
        img.crossOrigin = 'anonymous';
        await new Promise((ok, bad) => {
          img.onload = ok; img.onerror = bad;
          img.src = TERRAIN_URL(z, tx, ty);
        });
        ctx.drawImage(img, (tx - txMin) * T, (ty - tyMin) * T);
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
  if (key === 'backing') rebuildBaseLayer();
  else scheduleRebuild();
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

  camera = new THREE.PerspectiveCamera(50, el.clientWidth / el.clientHeight, 1, 20000);

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
  $('selBox').style.display = on ? 'none' : 'block';
  $('backBtn').style.display = on ? 'block' : 'none';
  if (on) resizeViewer(); else map.resize();
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

    let minElev = 0;
    if (sampleElev) {
      minElev = Infinity;
      for (let j = 0; j <= 16; j++) {
        for (let i = 0; i <= 16; i++) {
          const lat = bbox.south + (bbox.north - bbox.south) * j / 16;
          const lon = bbox.west + (bbox.east - bbox.west) * i / 16;
          minElev = Math.min(minElev, sampleElev(lat, lon));
        }
      }
    }

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

    const d = (state.mode === 'suburb' && state.council) ? 2 * Math.max(EXT.hx, EXT.hy) : state.sizeMeters;
    camera.position.set(d * 0.9, d * 0.95, d * 0.9);
    controls.target.set(0, 0, 0);
    controls.update();
    scene.fog.near = d * 6;
    scene.fog.far = d * 18;

    showViewer(true);
    setStatus(statusLine(counts));
    $('exportSection').style.display = 'block';
  } catch (e) {
    console.error(e);
    setStatus('Generation failed: ' + (e.message || e) + ' — try a smaller area or wait a moment (the free OSM server rate-limits).', true);
  } finally {
    setLoading(false);
    $('generateBtn').disabled = false;
  }
}
$('generateBtn').addEventListener('click', generate);

/* ============================================================ layer inspector UI */

// Control kinds: color | range | select | toggleRow (layer visibility lives in the header)
const INSPECTOR = [
  { key: 'buildings', label: 'Buildings', toggle: true, items: [
    ['color', 'Colour', 'color'],
    ['nodes', 'Unmapped buildings (address nodes)', 'check'],
    ['nodeSize', 'Unmapped box size (m)', 'range', 4, 30, 1],
    ['defH', 'Default height (m)', 'range', 2, 40, 1],
    ['scale', 'Height scale', 'range', 0.2, 3, 0.05],
    ['extra', 'Extra height (m)', 'range', 0, 40, 1],
    ['minH', 'Minimum height (m)', 'range', 0, 30, 1],
    ['fit', 'Ground fit', 'select', [['terrain', 'Follow terrain'], ['flat', 'Flat (lowest point)']]],
  ]},
  { key: 'majorRoads', label: 'Major roads', toggle: true, items: [
    ['color', 'Colour', 'color'],
    ['widthScale', 'Width scale', 'range', 0.2, 3, 0.05],
    ['lift', 'Raise above ground (m)', 'range', 0, 5, 0.1],
  ]},
  { key: 'minorRoads', label: 'Minor roads', toggle: true, items: [
    ['color', 'Colour', 'color'],
    ['widthScale', 'Width scale', 'range', 0.2, 3, 0.05],
    ['lift', 'Raise above ground (m)', 'range', 0, 5, 0.1],
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
  { key: 'terrain', label: 'Terrain elevation', toggle: true, items: [
    ['color', 'Colour', 'color'],
    ['exag', 'Vertical exaggeration', 'range', 0, 3, 0.05],
    ['res', 'Level of detail', 'range', 32, 160, 16],
  ]},
  { key: 'base', label: 'Base block', toggle: false, items: [
    ['color', 'Colour', 'color'],
    ['depth', 'Base depth (m)', 'range', 1, 100, 1],
  ]},
  { key: 'backing', label: 'Backing map', toggle: true, items: [
    ['title', 'Title', 'select', [['none', 'No title'], ['postcode', 'Postcode title'], ['suburb', 'Suburb title']]],
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
    const wrap = document.createElement('div');
    wrap.className = 'layer';

    const head = document.createElement('div');
    head.className = 'layer-head';

    if (layer.toggle) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = c.on;
      cb.addEventListener('click', e => e.stopPropagation());
      cb.addEventListener('change', () => { c.on = cb.checked; layerChanged(layer.key); });
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

    head.addEventListener('click', () => {
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      chev.textContent = open ? '▸' : '▾';
    });

    for (const item of layer.items) {
      const [prop, label, kind] = item;
      const row = document.createElement('div');
      row.className = 'ctl-row';
      const lab = document.createElement('label');
      lab.textContent = label;
      row.appendChild(lab);

      if (kind === 'color') {
        const inp = document.createElement('input');
        inp.type = 'color';
        inp.value = c[prop];
        inp.addEventListener('input', () => {
          c[prop] = inp.value;
          if (sw) sw.style.background = inp.value;
          applyMaterial(layer.key);
        });
        row.appendChild(inp);
      } else if (kind === 'check') {
        const inp = document.createElement('input');
        inp.type = 'checkbox';
        inp.checked = !!c[prop];
        inp.style.accentColor = '#4f8cff';
        inp.style.width = '15px';
        inp.style.height = '15px';
        inp.style.cursor = 'pointer';
        inp.addEventListener('change', () => { c[prop] = inp.checked; layerChanged(layer.key); });
        row.appendChild(inp);
      } else if (kind === 'select') {
        const sel = document.createElement('select');
        for (const [val, text] of item[3]) {
          const o = document.createElement('option');
          o.value = val; o.textContent = text;
          sel.appendChild(o);
        }
        sel.value = c[prop];
        sel.addEventListener('change', () => { c[prop] = sel.value; layerChanged(layer.key); });
        row.appendChild(sel);
      } else { // range
        const [, , , min, max, step] = item;
        const inp = document.createElement('input');
        inp.type = 'range';
        inp.min = min; inp.max = max; inp.step = step;
        inp.value = c[prop];
        const val = document.createElement('span');
        val.className = 'ctl-val';
        val.textContent = c[prop];
        inp.addEventListener('input', () => {
          c[prop] = Number(inp.value);
          val.textContent = inp.value;
          if (MATERIAL_KEYS.has(prop)) applyMaterial(layer.key);
          else layerChanged(layer.key);
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

/* ============================================================ base map layer */

// A3 base sheet layout (portrait, north up, mm). The 3D model prints at 200 mm
// on its widest side and sits centred in the lower two-thirds of the sheet.
const A3_W = 297, A3_H = 420;
const MODEL_PRINT_MM = 200;             // model's widest side, printed
const MODEL_CX_MM = A3_W / 2;           // 148.5 — model centred horizontally
const MODEL_CY_MM = A3_H * 2 / 3;       // 280 — middle of the bottom two-thirds

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

  // Optional large title on the empty band above the 3D render, scaled so its
  // width matches the width of the model footprint.
  const titleText = backingTitleText();
  if (titleText) drawBackingTitle(ctx, titleText, s, pxmm);

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
    return (state.council && state.council.name)
      || (state.placeLabels && state.placeLabels.suburb) || '';
  }
  return '';
}

// Draw the title centred over the model, its width matched to the model footprint
// (2·EXT.hx metres wide), sitting in the empty band north of the model.
function drawBackingTitle(ctx, text, s, pxmm) {
  const modelWmm = 2 * EXT.hx * s;                       // model footprint width in mm
  const targetWpx = modelWmm * pxmm;
  const modelTopMM = MODEL_CY_MM - EXT.hy * s;           // north edge of the model, mm from top
  const bandMM = Math.max(10, modelTopMM);               // empty band above the model
  const yMM = modelTopMM - bandMM / 2;                   // centre of that band

  ctx.save();
  ctx.fillStyle = '#7a7a7a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // fit the font size so the rendered text is exactly the model's width
  let fs = 100;
  ctx.font = `700 ${fs}px "Segoe UI", system-ui, -apple-system, sans-serif`;
  const w0 = ctx.measureText(text).width || 1;
  fs = fs * targetWpx / w0;
  // keep it from overflowing the band's height
  fs = Math.min(fs, bandMM * 0.7 * pxmm);
  ctx.font = `700 ${fs}px "Segoe UI", system-ui, -apple-system, sans-serif`;
  ctx.fillText(text, MODEL_CX_MM * pxmm, yMM * pxmm);
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
// whenever the Backing map layer's toggle or title changes.
function rebuildBaseLayer() {
  removeBaseLayer();
  if (cfg.backing.on && state.baseData) {
    const { bbox, elements, prebaked, M } = state.baseData;
    buildBaseLayer(bbox, elements, prebaked, M);
  }
  updateBaseUI();
}

// Show the base-map PDF export only when the backing map is switched on.
function updateBaseUI() {
  const on = !!cfg.backing.on;
  if ($('expPdf')) $('expPdf').style.display = on ? 'block' : 'none';
  if ($('pdfHint')) $('pdfHint').style.display = on ? 'block' : 'none';
}

/* ============================================================ export */

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

$('expGlb').addEventListener('click', () => {
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

$('expStl').addEventListener('click', () => {
  if (!state.model) return;
  setStatus('Exporting STL…');
  try {
    const modelMax = Math.max(2 * EXT.hx, 2 * EXT.hy); // model's widest side in metres
    const clone = state.model.clone(true);
    clone.scale.setScalar(200 / modelMax);
    clone.updateMatrixWorld(true);
    const result = new STLExporter().parse(clone, { binary: true });
    download(new Blob([result], { type: 'application/octet-stream' }), state.modelName + '.stl');
    setStatus('STL exported (scaled to 200 mm across).');
  } catch (e) { setStatus('STL export failed: ' + e.message, true); }
});

$('expObj').addEventListener('click', () => {
  if (!state.model) return;
  setStatus('Exporting OBJ…');
  try {
    const result = new OBJExporter().parse(state.model);
    download(new Blob([result], { type: 'text/plain' }), state.modelName + '.obj');
    setStatus('OBJ exported.');
  } catch (e) { setStatus('OBJ export failed: ' + e.message, true); }
});

$('expPdf').addEventListener('click', () => {
  if (!state.basePdf) return;
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
});
