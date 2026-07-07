// MapForge 3D — generate 3D models of real places from OpenStreetMap data.
// Original implementation. Data: © OpenStreetMap contributors (ODbL);
// elevation: Terrain Tiles on AWS (Mapzen terrarium encoding).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';

/* ============================================================ state & layer config */

const state = {
  sizeMeters: 2000,  // side length of the selection square
  model: null,       // THREE.Group of the last generated model
  modelName: 'queens-parade-ashwood',
  last: null,        // cached fetch: {bbox, elements, sampleElev, minElev}
};

// Everything the layer inspector can change lives here.
const cfg = {
  terrain:    { on: true,  color: '#ffffff', metal: 0.0,  rough: 1.0,  exag: 1.0, res: 96 },
  base:       {            color: '#3a4048', metal: 0.0,  rough: 1.0,  depth: 12 },
  buildings:  { on: true,  color: '#c9d4e4', metal: 0.1,  rough: 0.85, defH: 8, scale: 1, extra: 0, minH: 0, fit: 'terrain', nodes: true, nodeSize: 10 },
  majorRoads: { on: true,  color: '#2e3947', metal: 0.0,  rough: 1.0,  widthScale: 1, lift: 0.5 },
  minorRoads: { on: true,  color: '#3a4353', metal: 0.0,  rough: 1.0,  widthScale: 1, lift: 0.4 },
  paths:      { on: true,  color: '#55606f', metal: 0.0,  rough: 1.0,  widthScale: 1, lift: 0.3 },
  green:      { on: true,  color: '#40653c', metal: 0.0,  rough: 1.0,  lift: 0.15 },
  water:      { on: true,  color: '#3d6fa8', metal: 0.25, rough: 0.35, lift: 0.2 },
};

// One material per layer, updated live by the inspector.
const MATS = {};
for (const key of Object.keys(cfg)) {
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
  const px = state.sizeMeters / metersPerPixel();
  const el = $('selBox');
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
    document.querySelectorAll('.size-grid button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.sizeMeters = Number(btn.dataset.size);
    updateSelBox();
  });
});

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
  const c = map.getCenter();
  const half = state.sizeMeters / 2;
  const dLat = half / 111320;
  const dLon = half / (111320 * Math.cos(c.lat * Math.PI / 180));
  return { south: c.lat - dLat, north: c.lat + dLat, west: c.lng - dLon, east: c.lng + dLon, lat0: c.lat, lon0: c.lng };
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
function clippedRings(poly, project, half) {
  let outer = clipRingToSquare(ringFromGeometry(poly.outer, project), half);
  if (outer.length < 3 || Math.abs(ringArea(outer)) < 1) return null;
  if (ringArea(outer) < 0) outer = outer.slice().reverse();
  const holes = [];
  for (const h of poly.holes || []) {
    let r = clipRingToSquare(ringFromGeometry(h, project), half);
    if (r.length < 3) continue;
    if (ringArea(r) > 0) r = r.slice().reverse();
    holes.push(r);
  }
  return { outer, holes };
}

/* ---------- terrain block (closed solid: displaced top, skirt, bottom) */

function buildTerrainBlock(groundAt) {
  const half = state.sizeMeters / 2;
  const N = Math.max(16, Math.round(cfg.terrain.res / 16) * 16);
  const step = state.sizeMeters / N;

  const hz = [];
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      hz.push(groundAt(-half + i * step, -half + j * step));
    }
  }

  const positions = [], indices = [];
  const V = (i, j) => j * (N + 1) + i;
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const x = -half + i * step, y = -half + j * step;
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
  for (let i = 0; i <= N; i++) edgeLoop.push([ -half + i * step, -half ]);
  for (let j = 1; j <= N; j++) edgeLoop.push([ half, -half + j * step ]);
  for (let i = N - 1; i >= 0; i--) edgeLoop.push([ -half + i * step, half ]);
  for (let j = N - 1; j >= 1; j--) edgeLoop.push([ -half, -half + j * step ]);
  const hAt = (x, y) => {
    const i = Math.round((x + half) / step), j = Math.round((y + half) / step);
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
  sp.push(-half, bot, half,  half, bot, half,  half, bot, -half,  -half, bot, -half);
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

function buildBuildings(elements, project, groundAt, half) {
  const c = cfg.buildings;
  const group = new THREE.Group();
  group.name = 'buildings';
  const footprints = []; // unclipped projected outer rings, used to detect mapped buildings
  const polys = collectPolygons(elements, t => t['building'] !== undefined);
  for (const poly of polys) {
    try {
      footprints.push(ringFromGeometry(poly.outer, project));
      const rings = clippedRings(poly, project, half);
      if (!rings) continue;
      let h = taggedHeight(poly.tags);
      h = (h === null ? c.defH : h) * c.scale + c.extra;
      h = Math.max(h, c.minH, 1);
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
      if (Math.abs(x) > half || Math.abs(y) > half) continue;
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
      // keep the box fully inside the selection square
      const bx = Math.max(-half + s / 2, Math.min(half - s / 2, x));
      const by = Math.max(-half + s / 2, Math.min(half - s / 2, y));
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

function buildRoadClass(elements, project, groundAt, half, layerKey) {
  const c = cfg[layerKey];
  const group = new THREE.Group();
  group.name = layerKey;
  for (const el of elements) {
    if (el.type !== 'way' || !el.tags || !el.tags.highway || !el.geometry) continue;
    if (el.tags.area === 'yes') continue;
    const kind = el.tags.highway;
    if (roadClass(kind) !== layerKey) continue;
    const width = (ROAD_WIDTHS[kind] || 5) * c.widthScale;
    const runs = clipLineToSquare(ringFromGeometry(el.geometry, project), half);
    const EMBED = 1.0; // how far the ribbon's underside sinks into the terrain
    for (const rawPts of runs) {
      if (rawPts.length < 2) continue;
      const pts = densifyLine(rawPts, 12); // follow the terrain closely
      const positions = [], indices = [];
      const cl = v => Math.max(-half, Math.min(half, v));
      for (let i = 0; i < pts.length; i++) {
        const [x, y] = pts[i];
        const [xp, yp] = pts[Math.max(0, i - 1)];
        const [xn, yn] = pts[Math.min(pts.length - 1, i + 1)];
        let dx = xn - xp, dy = yn - yp;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len; dy /= len;
        const nx = -dy, ny = dx;
        const lx = cl(x + nx * width / 2), ly = cl(y + ny * width / 2);
        const rx = cl(x - nx * width / 2), ry = cl(y - ny * width / 2);
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

function addWaterwayLines(group, elements, project, groundAt, half) {
  const c = cfg.water;
  const EMBED = 1.0;
  for (const el of elements) {
    if (el.type !== 'way' || !el.tags || !el.geometry) continue;
    const w = el.tags.waterway;
    if (!WATERWAY_WIDTHS[w]) continue;
    if (el.tags.tunnel === 'yes' || el.tags.tunnel === 'culvert') continue;
    const width = WATERWAY_WIDTHS[w];
    const runs = clipLineToSquare(ringFromGeometry(el.geometry, project), half);
    for (const rawPts of runs) {
      if (rawPts.length < 2) continue;
      const pts = densifyLine(rawPts, 12);
      const positions = [], indices = [];
      const cl = v => Math.max(-half, Math.min(half, v));
      for (let i = 0; i < pts.length; i++) {
        const [x, y] = pts[i];
        const [xp, yp] = pts[Math.max(0, i - 1)];
        const [xn, yn] = pts[Math.min(pts.length - 1, i + 1)];
        let dx = xn - xp, dy = yn - yp;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len; dy /= len;
        const nx = -dy, ny = dx;
        const lx = cl(x + nx * width / 2), ly = cl(y + ny * width / 2);
        const rx = cl(x - nx * width / 2), ry = cl(y - ny * width / 2);
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

function buildFlatPolys(elements, project, groundAt, half, layerKey, match) {
  const c = cfg[layerKey];
  const DEPTH = 1.5; // how far the slab's underside sinks into the terrain
  const group = new THREE.Group();
  group.name = layerKey;
  const polys = collectPolygons(elements, match);
  for (const poly of polys) {
    try {
      const rings = clippedRings(poly, project, half);
      if (!rings) continue;
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
  return group;
}

/* ============================================================ model build (from cached data) */

function buildModel() {
  const { bbox, elements, sampleElev, minElev } = state.last;
  const project = makeProjector(bbox.lat0, bbox.lon0);
  const half = state.sizeMeters / 2;

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
    const g = buildBuildings(elements, project, groundAt, half);
    counts.buildings = g.children.length;
    model.add(g);
  }
  for (const rk of ['majorRoads', 'minorRoads', 'paths']) {
    if (!cfg[rk].on) continue;
    const g = buildRoadClass(elements, project, groundAt, half, rk);
    counts[rk] = g.children.length;
    model.add(g);
  }
  if (cfg.green.on) {
    const g = buildFlatPolys(elements, project, groundAt, half, 'green', GREEN_MATCH);
    counts.green = g.children.length;
    model.add(g);
  }
  if (cfg.water.on) {
    const g = buildFlatPolys(elements, project, groundAt, half, 'water', WATER_MATCH);
    addWaterwayLines(g, elements, project, groundAt, half);
    counts.water = g.children.length;
    model.add(g);
  }
  return { model, counts };
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

    state.last = { bbox, elements, sampleElev, minElev };
    const counts = swapModel();

    const d = state.sizeMeters;
    camera.position.set(d * 0.75, d * 0.85, d * 0.75);
    controls.target.set(0, 0, 0);
    controls.update();
    scene.fog.near = d * 5;
    scene.fog.far = d * 14;

    showViewer(true);
    setStatus(statusLine(counts));
    ['expGlb', 'expStl', 'expObj'].forEach(id => $(id).disabled = false);
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
      cb.addEventListener('change', () => { c.on = cb.checked; scheduleRebuild(); });
      head.appendChild(cb);
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'cb-spacer';
      head.appendChild(spacer);
    }

    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = c.color;
    head.appendChild(sw);

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
          sw.style.background = inp.value;
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
        inp.addEventListener('change', () => { c[prop] = inp.checked; scheduleRebuild(); });
        row.appendChild(inp);
      } else if (kind === 'select') {
        const sel = document.createElement('select');
        for (const [val, text] of item[3]) {
          const o = document.createElement('option');
          o.value = val; o.textContent = text;
          sel.appendChild(o);
        }
        sel.value = c[prop];
        sel.addEventListener('change', () => { c[prop] = sel.value; scheduleRebuild(); });
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
          else scheduleRebuild();
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
    const clone = state.model.clone(true);
    clone.scale.setScalar(200 / state.sizeMeters);
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
