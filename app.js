// MapForge 3D — generate 3D models of real places from OpenStreetMap data.
// Original implementation. Data: © OpenStreetMap contributors (ODbL);
// elevation: Terrain Tiles on AWS (Mapzen terrarium encoding).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';

/* ============================================================ state */

const state = {
  sizeMeters: 500,        // side length of the selection square
  model: null,            // THREE.Group of the last generated model
  modelName: 'map',
  minElev: 0,
};

const $ = (id) => document.getElementById(id);

/* ============================================================ 2D map */

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  center: [151.2153, -33.8568],   // Sydney
  zoom: 14,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');

// Keep the on-screen selection square sized to real metres at map centre.
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

// Local flat projection (metres) centred on (lat0, lon0).
function makeProjector(lat0, lon0) {
  const mLat = 111320;                                  // metres per degree latitude
  const mLon = 111320 * Math.cos(lat0 * Math.PI / 180); // metres per degree longitude
  return (lat, lon) => [ (lon - lon0) * mLon, (lat - lat0) * mLat ];
}

function currentBBox() {
  const c = map.getCenter();
  const half = state.sizeMeters / 2;
  const dLat = half / 111320;
  const dLon = half / (111320 * Math.cos(c.lat * Math.PI / 180));
  return { south: c.lat - dLat, north: c.lat + dLat, west: c.lng - dLon, east: c.lng + dLon, lat0: c.lat, lon0: c.lng };
}

/* ============================================================ Overpass */

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function fetchOSM(bbox, wants) {
  const bb = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const parts = [];
  if (wants.buildings) {
    parts.push(`way["building"](${bb});`, `relation["building"]["type"="multipolygon"](${bb});`);
  }
  if (wants.roads) {
    parts.push(`way["highway"](${bb});`);
  }
  if (wants.water) {
    parts.push(
      `way["natural"="water"](${bb});`,
      `relation["natural"="water"]["type"="multipolygon"](${bb});`,
      `way["waterway"="riverbank"](${bb});`,
    );
  }
  if (!parts.length) return { elements: [] };
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

// Terrarium-encoded elevation tiles (Mapzen / Terrain Tiles on AWS).
const TERRAIN_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

function lonLatToTile(lon, lat, z) {
  const n = Math.pow(2, z);
  const x = (lon + 180) / 360 * n;
  const latRad = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return [x, y];
}

// Returns an elevation sampler: sample(lat, lon) -> metres above sea level.
async function buildElevationSampler(bbox) {
  // pick a zoom where the bbox spans roughly 1.5–3 tiles across
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
    // bilinear
    return elevAt(x0, y0)     * (1 - dx) * (1 - dy)
         + elevAt(x0 + 1, y0) * dx * (1 - dy)
         + elevAt(x0, y0 + 1) * (1 - dx) * dy
         + elevAt(x0 + 1, y0 + 1) * dx * dy;
  };
}

/* ============================================================ geometry building */

const MATS = {
  terrain:  new THREE.MeshLambertMaterial({ color: 0x5e7d5a, flatShading: false }),
  base:     new THREE.MeshLambertMaterial({ color: 0x3a4048 }),
  building: new THREE.MeshLambertMaterial({ color: 0xc9d4e4 }),
  roof:     new THREE.MeshLambertMaterial({ color: 0xb4c0d4 }),
  road:     new THREE.MeshLambertMaterial({ color: 0x3a4353 }),
  path:     new THREE.MeshLambertMaterial({ color: 0x55606f }),
  water:    new THREE.MeshLambertMaterial({ color: 0x3d6fa8 }),
};

const BASE_DEPTH = 12; // solid plinth below the lowest terrain point, metres

// Close small gaps: polygon ring from an OSM way's geometry array.
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

function parseHeight(tags) {
  if (!tags) return 8;
  const h = parseFloat(tags['height'] || tags['building:height']);
  if (!isNaN(h) && h > 0) return Math.min(h, 500);
  const lv = parseFloat(tags['building:levels']);
  if (!isNaN(lv) && lv > 0) return Math.min(lv * 3.2 + 1.5, 500);
  return 8;
}

function centroidOf(ring) {
  let x = 0, y = 0;
  for (const [px, py] of ring) { x += px; y += py; }
  return [x / ring.length, y / ring.length];
}

// Collect polygon rings (outer + holes) from OSM ways & multipolygon relations.
function collectPolygons(elements, match) {
  const polys = [];
  for (const el of elements) {
    if (!match(el.tags || {})) continue;
    if (el.type === 'way' && el.geometry && el.geometry.length >= 4) {
      polys.push({ tags: el.tags, outer: el.geometry, holes: [] });
    } else if (el.type === 'relation' && el.members) {
      const outers = el.members.filter(m => m.role === 'outer' && m.geometry && m.geometry.length >= 4);
      const inners = el.members.filter(m => m.role === 'inner' && m.geometry && m.geometry.length >= 4);
      for (const o of outers) {
        polys.push({ tags: el.tags, outer: o.geometry, holes: inners.map(i => i.geometry) });
      }
    }
  }
  return polys;
}

/* ---------- terrain block (closed solid: displaced top, skirt, bottom) */

function buildTerrainBlock(bbox, project, sampleElev, minElev, flat) {
  const half = state.sizeMeters / 2;
  const N = 96; // grid segments per side
  const step = state.sizeMeters / N;

  // top-surface heights
  const hz = [];
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const x = -half + i * step, y = -half + j * step;
      if (flat) { hz.push(0); continue; }
      const lat = bbox.lat0 + y / 111320;
      const lon = bbox.lon0 + x / (111320 * Math.cos(bbox.lat0 * Math.PI / 180));
      hz.push(Math.max(0, sampleElev(lat, lon) - minElev));
    }
  }

  const positions = [], indices = [];
  const V = (i, j) => j * (N + 1) + i;
  // top vertices (y-up scene: x east, z south -> use -y)
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

  // skirt + bottom as a closed plinth
  const bot = -BASE_DEPTH;
  const sp = [], si = [];
  const edgeLoop = [];
  for (let i = 0; i <= N; i++) edgeLoop.push([ -half + i * step, -half ]);          // south
  for (let j = 1; j <= N; j++) edgeLoop.push([ half, -half + j * step ]);           // east
  for (let i = N - 1; i >= 0; i--) edgeLoop.push([ -half + i * step, half ]);       // north
  for (let j = N - 1; j >= 1; j--) edgeLoop.push([ -half, -half + j * step ]);      // west
  const hAt = (x, y) => {
    const i = Math.round((x + half) / step), j = Math.round((y + half) / step);
    return hz[V(Math.max(0, Math.min(N, i)), Math.max(0, Math.min(N, j)))];
  };
  for (let k = 0; k < edgeLoop.length; k++) {
    const [x, y] = edgeLoop[k];
    sp.push(x, hAt(x, y), -y);   // top edge vertex
    sp.push(x, bot, -y);         // bottom edge vertex
  }
  const M = edgeLoop.length;
  for (let k = 0; k < M; k++) {
    const a = k * 2, b = k * 2 + 1, c = ((k + 1) % M) * 2, d = ((k + 1) % M) * 2 + 1;
    si.push(a, b, c, b, d, c);
  }
  // bottom cap (two triangles across the square)
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

function buildBuildings(elements, project, groundAt, clipHalf) {
  const group = new THREE.Group();
  group.name = 'buildings';
  const polys = collectPolygons(elements, t => t['building'] !== undefined);
  for (const poly of polys) {
    try {
      let outer = ringFromGeometry(poly.outer, project);
      // skip if entirely outside the selection square
      if (!outer.some(([x, y]) => Math.abs(x) <= clipHalf && Math.abs(y) <= clipHalf)) continue;
      if (ringArea(outer) < 0) outer = outer.slice().reverse();
      const holes = (poly.holes || []).map(h => {
        let r = ringFromGeometry(h, project);
        if (ringArea(r) > 0) r = r.slice().reverse();
        return r;
      });
      const height = parseHeight(poly.tags);
      const shape = shapeFromRings(outer, holes);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
      // ExtrudeGeometry extrudes along +z; rotate so it stands up in y-up scene
      geo.rotateX(-Math.PI / 2);
      const [cx, cy] = centroidOf(outer);
      const ground = groundAt(cx, cy);
      const mesh = new THREE.Mesh(geo, MATS.building);
      mesh.position.y = Math.max(0, ground) - 1.5; // sink slightly into terrain
      group.add(mesh);
    } catch (e) { /* skip malformed footprints */ }
  }
  return group;
}

/* ---------- roads (flat ribbons draped on terrain) */

const ROAD_WIDTHS = {
  motorway: 18, trunk: 16, primary: 13, secondary: 11, tertiary: 9,
  unclassified: 7, residential: 7, living_street: 6, service: 4.5,
  pedestrian: 5, track: 3.5, cycleway: 2.5, footway: 2, path: 1.8, steps: 2,
};

function buildRoads(elements, project, groundAt, clipHalf) {
  const group = new THREE.Group();
  group.name = 'roads';
  for (const el of elements) {
    if (el.type !== 'way' || !el.tags || !el.tags.highway || !el.geometry) continue;
    const kind = el.tags.highway;
    const width = ROAD_WIDTHS[kind] || 5;
    const isPath = ['footway', 'path', 'cycleway', 'steps', 'track', 'pedestrian'].includes(kind);
    const pts = ringFromGeometry(el.geometry, project)
      .filter(([x, y]) => Math.abs(x) <= clipHalf * 1.2 && Math.abs(y) <= clipHalf * 1.2);
    if (pts.length < 2) continue;

    const positions = [], indices = [];
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = pts[i];
      // direction: average of adjacent segments
      const [xp, yp] = pts[Math.max(0, i - 1)];
      const [xn, yn] = pts[Math.min(pts.length - 1, i + 1)];
      let dx = xn - xp, dy = yn - yp;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const nx = -dy, ny = dx; // perpendicular
      const h = groundAt(x, y) + 0.4;
      positions.push(x + nx * width / 2, h, -(y + ny * width / 2));
      positions.push(x - nx * width / 2, h, -(y - ny * width / 2));
      if (i > 0) {
        const a = (i - 1) * 2, b = a + 1, c = i * 2, d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    group.add(new THREE.Mesh(geo, isPath ? MATS.path : MATS.road));
  }
  return group;
}

/* ---------- water */

function buildWater(elements, project, groundAt, clipHalf) {
  const group = new THREE.Group();
  group.name = 'water';
  const polys = collectPolygons(elements, t => t['natural'] === 'water' || t['waterway'] === 'riverbank');
  for (const poly of polys) {
    try {
      let outer = ringFromGeometry(poly.outer, project);
      if (!outer.some(([x, y]) => Math.abs(x) <= clipHalf && Math.abs(y) <= clipHalf)) continue;
      if (ringArea(outer) < 0) outer = outer.slice().reverse();
      const holes = (poly.holes || []).map(h => {
        let r = ringFromGeometry(h, project);
        if (ringArea(r) > 0) r = r.slice().reverse();
        return r;
      });
      const shape = shapeFromRings(outer, holes);
      const geo = new THREE.ShapeGeometry(shape);
      geo.rotateX(-Math.PI / 2);
      // water sits at the lowest ground level along its rim
      let minG = Infinity;
      for (const [x, y] of outer) minG = Math.min(minG, groundAt(x, y));
      const mesh = new THREE.Mesh(geo, MATS.water);
      mesh.position.y = Math.max(0.2, minG + 0.2);
      group.add(mesh);
    } catch (e) { /* skip */ }
  }
  return group;
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

  const amb = new THREE.HemisphereLight(0xdfe8ff, 0x30363d, 0.9);
  scene.add(amb);
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(600, 900, 400);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x88aaff, 0.35);
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
  const wants = {
    buildings: $('lyrBuildings').checked,
    terrain: $('lyrTerrain').checked,
    roads: $('lyrRoads').checked,
    water: $('lyrWater').checked,
  };
  const bbox = currentBBox();
  const project = makeProjector(bbox.lat0, bbox.lon0);
  const half = state.sizeMeters / 2;

  $('generateBtn').disabled = true;
  setStatus('');
  setLoading(true, 'Fetching OpenStreetMap data…');

  try {
    // 1. OSM vector data + elevation in parallel
    const osmPromise = fetchOSM(bbox, wants);
    let sampleElev = () => 0;
    if (wants.terrain) {
      setLoading(true, 'Fetching OpenStreetMap data + elevation tiles…');
      try {
        sampleElev = await buildElevationSampler(bbox);
      } catch (e) {
        console.warn('Elevation unavailable, using flat terrain', e);
        wants.terrain = false;
      }
    }
    const osm = await osmPromise;
    const elements = osm.elements || [];

    setLoading(true, 'Building 3D geometry…');
    await new Promise(r => setTimeout(r, 30)); // let the loading text paint

    // min elevation over the selection square (coarse scan)
    let minElev = Infinity;
    if (wants.terrain) {
      for (let j = 0; j <= 16; j++) {
        for (let i = 0; i <= 16; i++) {
          const lat = bbox.south + (bbox.north - bbox.south) * j / 16;
          const lon = bbox.west + (bbox.east - bbox.west) * i / 16;
          minElev = Math.min(minElev, sampleElev(lat, lon));
        }
      }
    } else {
      minElev = 0;
    }
    state.minElev = minElev;

    // ground height (relative metres) at local x/y
    const groundAt = (x, y) => {
      if (!wants.terrain) return 0;
      const lat = bbox.lat0 + y / 111320;
      const lon = bbox.lon0 + x / (111320 * Math.cos(bbox.lat0 * Math.PI / 180));
      return Math.max(0, sampleElev(lat, lon) - minElev);
    };

    // 2. build the model
    const model = new THREE.Group();
    model.name = 'mapforge-model';
    model.add(buildTerrainBlock(bbox, project, sampleElev, minElev, !wants.terrain));
    let counts = { buildings: 0, roads: 0, water: 0 };
    if (wants.buildings) {
      const g = buildBuildings(elements, project, groundAt, half);
      counts.buildings = g.children.length;
      model.add(g);
    }
    if (wants.roads) {
      const g = buildRoads(elements, project, groundAt, half);
      counts.roads = g.children.length;
      model.add(g);
    }
    if (wants.water) {
      const g = buildWater(elements, project, groundAt, half);
      counts.water = g.children.length;
      model.add(g);
    }

    // 3. show it
    initViewer();
    if (state.model) scene.remove(state.model);
    state.model = model;
    scene.add(model);

    const d = state.sizeMeters;
    camera.position.set(d * 0.75, d * 0.85, d * 0.75);
    controls.target.set(0, 0, 0);
    controls.update();

    // keep fog proportional to the model so large areas don't fade out
    scene.fog.near = d * 5;
    scene.fog.far = d * 14;

    showViewer(true);
    setStatus(`Done — ${counts.buildings} buildings, ${counts.roads} road segments, ${counts.water} water bodies.`);
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
    // scale so the model is 200 mm across — ready for slicing / 3D printing
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
