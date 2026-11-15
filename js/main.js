// SOLUS — application wiring: map layers, panels, route planning, point inspection.
import { MapView, TrekTileLayer, ImageOverlay, FnLayer, tileStats } from './mapview.js';
import { APP_VERSION, TREK, GLOBAL_LAYERS, REGION_IMAGERY, REGION_FALLBACK, REGION_ORDER, SPEEDS_KMH, ROUTE } from './config.js';
import {
  store, loadManifest, loadRegion, loadWaypoints, thresholds, usingFallbackThresholds, severityClasses, limitations,
  citations, levelFor, severityFor, sampleAt, prefetch, suspectNear,
} from './data.js';
import { analyzeRoute, FLAG_TITLES, rimOf, demLabel, LARGE_CRATER_KM, LARGE_CRATER_NOTE } from './route.js';
import { M_PER_DEG, distance, fmtDeg, fmtDist, parseLatLon, pathLength } from './geo.js';
import { validationHTML, loadAllValidation } from './validation.js';
import { lowestRiskRoute } from './suggest.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const COLORS = {
  ok: '#46b98a', caution: '#f0a43a', nogo: '#e5484d', unknown: '#8a93a3', outside: '#3b4658', crater: '#c9a0ff',
  exp: '#b9a98a', data_gap: '#8a93a3', no_coverage: '#5d6b80', traverse: '#7fd6ff', suspect: '#d65db1',
};
const LEVEL_TEXT = { ok: 'within limits', caution: 'caution', nogo: 'no-go', unknown: 'no data', outside: 'not covered' };
const MODE_NAME = { rover: 'Rover', marswalk: 'Marswalk' };
const trekUrl = TREK.url.bind(TREK);
const BAND_TOP = 26, BAND_LEFT = 54; // graticule label bands (px)

const state = {
  region: 'jezero', mode: 'rover', fmt: 'dd', R: null,
  layers: {
    imagery: true, tint: true, hillshade: false, slope: false, nodata: true, suspect: false, footprints: true,
    geology: false, traverse: true, waypoints: false, craters: false, hazards: true,
  },
  hazardTypes: { steep_slope: true, crater_rim: true, data_gap: false, rough_terrain: false, relief: false },
  route: { pts: [], editing: false },
  analysisKind: 'route', analysis: null, analyzing: false, selected: null, inspect: null,
  hz: [], visibleHz: [], overview: [], nearSet: null, cursor: null,
  moreLayers: false, imageryOffline: false,
};

// ---------------------------------------------------------------------------
// Map and layers
// ---------------------------------------------------------------------------
const map = new MapView($('mapwrap'));
const baseLayer = Object.assign(new TrekTileLayer(GLOBAL_LAYERS.viking, trekUrl), { key: 'imagery' });
let regionLayers = [];

const routeLayer = new FnLayer('route', drawRoute, { hit: hitRoute });
const hazardLayer = new FnLayer('hazards', drawHazards, { hit: hitHazard });
const inspectLayer = new FnLayer('inspect', drawInspect);
const graticule = new FnLayer('graticule', drawGraticule);

function rebuildLayers() {
  map.layers = [baseLayer, ...regionLayers, hazardLayer, routeLayer, inspectLayer, graticule];
  for (const l of map.layers) l.map = map;
  applyVisibility();
}

function applyVisibility() {
  baseLayer.visible = state.layers.imagery;
  for (const l of regionLayers) l.visible = !!state.layers[l.key] && (l.key !== 'tint' || state.layers.imagery);
  hazardLayer.visible = state.layers.hazards;
  map.render();
}

function buildRegionLayers(R) {
  const L = [];
  const tag = (layer, key, extra = {}) => Object.assign(layer, { key }, extra);
  for (const def of REGION_IMAGERY[R.id] || []) L.push(tag(new TrekTileLayer(def, trekUrl), 'imagery'));
  // Display only: the grey HiRISE/CTX mosaics take the hue of the Viking colour mosaic beneath them.
  L.push(tag(new TrekTileLayer(GLOBAL_LAYERS.viking, trekUrl, { opacity: 0.8 }), 'tint', { composite: 'color', name: 'Viking colour tint' }));
  // overlays: least preferred source first, so the preferred source ends up on top
  const order = [...R.sourceOrder].reverse();
  const ov = (kind, key, opacity, smooth) => {
    const list = (R.overlays[kind] || []).slice().sort((a, b) => order.indexOf(a.dem) - order.indexOf(b.dem));
    for (const o of list) L.push(tag(new ImageOverlay(o.url, o.bounds, { opacity, smooth, name: `${o.dem} ${kind}` }), key, { meta: o }));
  };
  ov('hillshade', 'hillshade', 0.92, true);
  ov('slope', 'slope', 0.62, false);
  L.push(tag(new FnLayer('geology', drawGeology), 'geology'));
  ov('unknown', 'nodata', 0.85, false);
  ov('suspect', 'suspect', 0.95, false);
  L.push(tag(new FnLayer('footprints', drawFootprints), 'footprints'));
  L.push(tag(new FnLayer('traverse', drawTraverse), 'traverse'));
  L.push(tag(new FnLayer('waypoints', drawWaypoints), 'waypoints'));
  L.push(tag(new FnLayer('craters', drawCraters), 'craters'));
  regionLayers = L;
  rebuildLayers();
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------
function inView(lon, lat, padDeg = 0) {
  const [x0, y0, x1, y1] = map.bounds();
  return lon >= x0 - padDeg && lon <= x1 + padDeg && lat >= y0 - padDeg && lat <= y1 + padDeg;
}
function eachRing(geom, fn) {
  if (!geom) return;
  const t = geom.type, c = geom.coordinates;
  if (t === 'Polygon') c.forEach(fn);
  else if (t === 'MultiPolygon') c.forEach((p) => p.forEach(fn));
  else if (t === 'LineString') fn(c);
  else if (t === 'MultiLineString') c.forEach(fn);
}
function pathRing(ctx, ring) {
  ring.forEach(([lon, lat], i) => { const [x, y] = map.toScreen(lon, lat); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
}
function bboxOfGeom(geom) {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  eachRing(geom, (r) => r.forEach(([x, y]) => { b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)]; }));
  return b;
}
function intersects(b) {
  const [x0, y0, x1, y1] = map.bounds();
  return !(b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1);
}
function label(ctx, text, x, y, opts = {}) {
  const lines = Array.isArray(text) ? text : [text];
  ctx.font = '700 12px Barlow, system-ui';
  const w = Math.max(...lines.map((t, i) => { ctx.font = i === 0 ? '700 12px Barlow, system-ui' : '500 11.5px "JetBrains Mono", Consolas, monospace'; return ctx.measureText(t).width; })) + 16;
  const h = lines.length * 15 + 8;
  const bx = opts.align === 'right' ? x - w : x, by = y - h;
  ctx.fillStyle = opts.bg || 'rgba(8,12,18,.9)'; ctx.strokeStyle = opts.border || 'rgba(255,255,255,.6)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(bx, by, w, h, 4); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fff';
  lines.forEach((t, i) => {
    ctx.font = i === 0 ? '700 12px Barlow, system-ui' : '500 11.5px "JetBrains Mono", Consolas, monospace';
    ctx.fillText(t, bx + 8, by + 16 + i * 15);
  });
}
function triangle(ctx, x, y, s, fill) {
  ctx.beginPath(); ctx.moveTo(x, y - s); ctx.lineTo(x + s * 0.95, y + s * 0.7); ctx.lineTo(x - s * 0.95, y + s * 0.7); ctx.closePath();
  ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = `800 ${Math.round(s * 0.95)}px Barlow, system-ui`; ctx.textAlign = 'center';
  ctx.fillText('!', x, y + s * 0.45); ctx.textAlign = 'left';
}
function badge(ctx, n, x, y, color) {
  const t = String(n).padStart(2, '0');
  ctx.font = '700 12px Barlow, system-ui';
  const w = ctx.measureText(t).width + 12;
  ctx.fillStyle = 'rgba(8,12,18,.92)'; ctx.strokeStyle = color; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(x, y - 10, w, 20, 3); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.fillText(t, x + 6, y + 4.5);
}
function diamond(ctx, x, y, r, fill, stroke) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4);
  ctx.fillStyle = fill; ctx.fillRect(-r, -r, 2 * r, 2 * r);
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.strokeRect(-r, -r, 2 * r, 2 * r); }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Vector layers
// ---------------------------------------------------------------------------
function drawFootprints(ctx) {
  const fc = state.R?.footprints; if (!fc) return;
  ctx.setLineDash([6, 4]); ctx.lineWidth = 1.2;
  for (const f of fc.features) {
    const p = f.properties || {};
    if (!f._bb) f._bb = bboxOfGeom(f.geometry);
    if (!intersects(f._bb)) continue;
    ctx.strokeStyle = (p.camera || p.dem_id || '').toLowerCase().includes('hirise') ? 'rgba(108,196,238,.9)' : 'rgba(108,196,238,.45)';
    ctx.beginPath(); eachRing(f.geometry, (r) => pathRing(ctx, r)); ctx.stroke();
  }
  ctx.setLineDash([]);
}

function drawTraverse(ctx) {
  const fc = state.R?.traverse; if (!fc) return;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const assessed = state.analysis?.kind === 'traverse';
  for (const pass of [{ w: 5, c: 'rgba(0,0,0,.45)' }, { w: 2.2, c: assessed ? 'rgba(127,214,255,.45)' : COLORS.traverse }]) {
    ctx.lineWidth = pass.w; ctx.strokeStyle = pass.c;
    for (const f of fc.features) { ctx.beginPath(); eachRing(f.geometry, (r) => pathRing(ctx, r)); ctx.stroke(); }
  }
  if (map.res < 0.01) {
    const f = fc.features[0]; const p = f?.properties || {};
    const g = f?.geometry; const first = g?.type === 'LineString' ? g.coordinates[0] : g?.coordinates?.[0]?.[0];
    if (first && inView(first[0], first[1])) {
      const [x, y] = map.toScreen(first[0], first[1]);
      label(ctx, `${p.rover || 'Rover'} traverse`, x + 8, y - 6, { border: COLORS.traverse });
    }
  }
}

const wpDrawn = [];
function drawWaypoints(ctx) {
  wpDrawn.length = 0;
  const fc = state.R?.waypoints; if (!fc) return;
  const r = map.res > 0.0015 ? 2.6 : map.res > 0.0004 ? 3.8 : 5.5;
  if (!fc._sorted) { fc.features.sort((a, b) => (a.properties.tilt ?? 0) - (b.properties.tilt ?? 0)); fc._sorted = true; }
  for (const f of fc.features) {
    const p = f.properties; const [lon, lat] = f.geometry.coordinates;
    if (p.tilt == null || !inView(lon, lat)) continue;
    const [x, y] = map.toScreen(lon, lat);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = COLORS[levelFor(p.tilt, state.mode)]; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.stroke();
    wpDrawn.push({ x, y, f });
  }
}
function waypointAt(x, y) {
  let best = null, bd = 8;
  for (const d of wpDrawn) { const dd = Math.hypot(d.x - x, d.y - y); if (dd < bd) { bd = dd; best = d.f; } }
  return best;
}

const geoPalette = ['#c1784f', '#8f9e5a', '#5f8fae', '#b1859c', '#c8a85a', '#7aa58d', '#9c7bb8', '#b86a6a'];
const unitColor = (code) => { let h = 0; for (const c of String(code)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return geoPalette[h % geoPalette.length]; };
const unitCode = (p) => p.unit ?? p.unit_code ?? p.UnitSymbol ?? '?';
const unitName = (p) => p.name ?? p.unit_name ?? p.UnitName ?? '';

function drawGeology(ctx) {
  const fc = state.R?.geology; if (!fc) return;
  for (const f of fc.features) {
    if (!f._bb) f._bb = bboxOfGeom(f.geometry);
    if (!intersects(f._bb)) continue;
    const col = unitColor(unitCode(f.properties || {}));
    ctx.beginPath(); eachRing(f.geometry, (r) => { pathRing(ctx, r); ctx.closePath(); });
    ctx.globalAlpha = 0.26; ctx.fillStyle = col; ctx.fill('evenodd');
    ctx.globalAlpha = 0.9; ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const [bx0, by0, bx1, by1] = map.bounds();
  for (const f of fc.features) {
    const b = f._bb; if (!b || !intersects(b)) continue;
    const cx = (Math.max(b[0], bx0) + Math.min(b[2], bx1)) / 2, cy = (Math.max(b[1], by0) + Math.min(b[3], by1)) / 2;
    if (!pointInGeom([cx, cy], f.geometry)) continue;
    const [x, y] = map.toScreen(cx, cy);
    ctx.font = '700 13px Barlow, system-ui'; ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fillText(unitCode(f.properties || {}), x, y);
  }
}

function drawCraters(ctx) {
  const fc = state.R?.craters; if (!fc) return;
  ctx.lineWidth = 1.3;
  for (const f of fc.features) {
    const p = f.properties || {}; const d = p.diam_km ?? p.value; if (!d) continue;
    const [lon, lat] = f.geometry.coordinates;
    const ry = (d * 500) / M_PER_DEG, rx = ry / Math.cos(lat * Math.PI / 180);
    if (!inView(lon, lat, rx)) continue;
    const [x, y] = map.toScreen(lon, lat);
    const pxr = ry / map.res; if (pxr < 2) continue;
    ctx.strokeStyle = p.rim_measured ? 'rgba(201,160,255,.95)' : 'rgba(201,160,255,.55)';
    ctx.setLineDash(p.rim_measured ? [] : [4, 4]);
    ctx.beginPath(); ctx.ellipse(x, y, rx / map.res, pxr, 0, 0, Math.PI * 2); ctx.stroke();
    if (pxr > 30) {
      const rim = rimOf(p);
      ctx.font = '600 11px Barlow, system-ui'; ctx.fillStyle = 'rgba(225,205,255,.95)';
      ctx.fillText(`${d.toFixed(1)} km${rim.p95 != null ? ` · rim p95 ${rim.p95.toFixed(0)}°` : ''}`, x - 14, y - pxr - 4);
    }
  }
  ctx.setLineDash([]);
}

// ---------------------------------------------------------------------------
// Hazards (pre-computed overview points from hazards.geojson)
// ---------------------------------------------------------------------------
function prepareHazards(R) {
  state.hz = (R.hazards?.features || []).map((f) => {
    const p = f.properties || {}; const [lon, lat] = f.geometry.coordinates;
    return { lon, lat, p, type: p.type, n: 0 };
  });
}
/** Colour level of a mapped point. Steep slope: by the 95th percentile in its square (LOCKED #14). */
function hzLevel(h) {
  const p = h.p;
  switch (h.type) {
    case 'steep_slope': return p[`level_${state.mode}_p95`] ?? levelFor(p.p95 ?? p.value, state.mode) ?? 'ok';
    case 'crater_rim': return 'crater';
    case 'data_gap': return 'unknown';
    default: return 'exp';
  }
}
function hzSeverity(h) {
  if (h.type === 'steep_slope') return severityFor(h.p.p95 ?? h.p.value);
  if (h.type === 'crater_rim') { const r = rimOf(h.p); return r.p95 != null ? severityFor(r.p95) : 0; }
  return 0;
}
/** Overview filter (LOCKED #15): p95 caution / no-go, measured crater rims, chosen types, plus everything near the route. */
function hzVisible(h) {
  if (!state.hazardTypes[h.type]) return false;
  if (state.nearSet?.has(h)) return true;
  if (h.type === 'steep_slope') { const l = hzLevel(h); return l === 'caution' || l === 'nogo'; }
  if (h.type === 'crater_rim') return h.p.rim_measured === true;
  return true;
}
const LEVEL_RANK = { nogo: 4, caution: 3, crater: 2, ok: 1.5, unknown: 1, exp: 0.5 };
/** Well-supported square: its source covers at least half of it and the peak is not on suspect pixels. */
const hzWellCovered = (p) => !p.suspect && (p.source_coverage_pct ?? 100) >= 50;
/** Ranking: level first, then well-supported squares before edge-of-coverage / suspect ones, then p95. */
function hzScore(h) {
  const p = h.p;
  const within = h.type === 'steep_slope' ? (hzWellCovered(p) ? 100 : 0) + (p.p95 ?? 0)
    : h.type === 'crater_rim' ? (rimOf(p).p95 ?? 0) + (p.diam_km ?? 0) / 1000
      : h.type === 'data_gap' ? Math.log10(1 + (+p.value || 0)) : (p.rank_score ?? 0) / 1e7;
  return (LEVEL_RANK[hzLevel(h)] || 0) * 1000 + within;
}

function computeOverview() {
  if (!state.R) return;
  const [x0, y0] = map.toWorld(BAND_LEFT, map.h), [x1, y1] = map.toWorld(map.w, BAND_TOP);
  for (const h of state.overview) h.n = 0;
  const vis = state.hz.filter((h) => h.lon >= x0 && h.lon <= x1 && h.lat >= y0 && h.lat <= y1 && hzVisible(h));
  vis.sort((a, b) => hzScore(b) - hzScore(a));
  state.visibleHz = vis;
  state.overview = routeMode() ? [] : vis.slice(0, 25);
  state.overview.forEach((h, i) => { h.n = i + 1; });
  updateHzCount();
  if (!routeMode()) renderRisk();
}
const routeMode = () => !!(state.analysis || state.analyzing || state.route.editing || state.route.pts.length > 1);

const hzDrawn = [];
function drawHzMarker(ctx, h, x, y, c, big) {
  if (h.type === 'crater_rim') { ctx.beginPath(); ctx.arc(x, y, big ? 9 : 7, 0, Math.PI * 2); ctx.strokeStyle = c; ctx.lineWidth = 2.5; ctx.stroke(); }
  else if (h.type === 'data_gap') diamond(ctx, x, y, big ? 6 : 4.5, c, 'rgba(255,255,255,.9)');
  else if (h.type !== 'steep_slope') { ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.strokeRect(x - 5, y - 5, 10, 10); }
  else triangle(ctx, x, y, big ? 11 : 8, c);
}
function drawHazards(ctx) {
  hzDrawn.length = 0;
  const list = state.visibleHz || [];
  const rm = routeMode();
  const cluster = list.length > 250;
  const bins = new Map(), singles = [];
  for (let i = list.length - 1; i >= 0; i--) {             // least severe first, so the worst end up on top
    const h = list[i]; const [x, y] = map.toScreen(h.lon, h.lat);
    if (x < -20 || y < -20 || x > map.w + 20 || y > map.h + 20) continue;
    if (cluster && !h.n && !state.nearSet?.has(h)) {
      const k = `${Math.floor(x / 32)}_${Math.floor(y / 32)}`;
      let b = bins.get(k); if (!b) bins.set(k, (b = { n: 0, sx: 0, sy: 0, top: h, items: [] }));
      b.n++; b.sx += x; b.sy += y; b.top = h; b.items.push({ h, x, y }); // least → most severe: the last one is the worst
    } else singles.push({ h, x, y });
  }
  ctx.globalAlpha = rm ? 0.3 : 1;
  for (const b of bins.values()) {
    const x = b.sx / b.n, y = b.sy / b.n, c = COLORS[hzLevel(b.top)] || COLORS.caution;
    if (b.n < 3) { // small groups stay individual dots
      for (const it of b.items) { ctx.beginPath(); ctx.arc(it.x, it.y, 3, 0, Math.PI * 2); ctx.fillStyle = COLORS[hzLevel(it.h)] || COLORS.caution; ctx.fill(); hzDrawn.push(it); }
      continue;
    }
    const r = 7 + Math.min(9, Math.log2(b.n) * 2);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = 'rgba(10,15,23,.8)'; ctx.fill();
    ctx.lineWidth = 2.2; ctx.strokeStyle = c; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = '700 11px Barlow, system-ui'; ctx.textAlign = 'center'; ctx.fillText(String(b.n), x, y + 4); ctx.textAlign = 'left';
    hzDrawn.push({ x, y, cluster: b, r });
  }
  for (const { h, x, y } of singles) {
    const near = state.nearSet?.has(h);
    ctx.globalAlpha = rm && !near ? 0.3 : 1;
    drawHzMarker(ctx, h, x, y, COLORS[hzLevel(h)] || COLORS.caution, !!h.n);
    hzDrawn.push({ x, y, h });
  }
  ctx.globalAlpha = 1;
  if (!rm) for (const h of state.overview) {
    const [x, y] = map.toScreen(h.lon, h.lat);
    badge(ctx, h.n, x + 13, y - 8, COLORS[hzLevel(h)] || COLORS.caution);
  }
  const sel = state.selected?.kind === 'hz' ? state.selected.item : null;
  if (sel) { const [x, y] = map.toScreen(sel.lon, sel.lat); ctx.beginPath(); ctx.arc(x, y, 18, 0, Math.PI * 2); ctx.strokeStyle = '#6cc4ee'; ctx.lineWidth = 2; ctx.stroke(); }
}
function hitHazard(x, y) {
  let best = null, bd = 13;
  for (const d of hzDrawn) {
    const dd = Math.hypot(d.x - x, d.y - y);
    if (dd < (d.cluster ? d.r + 2 : bd) && (!best || dd < best.dd)) best = { dd, f: d.cluster ? { cluster: d.cluster, x: d.x, y: d.y } : d.h };
  }
  return best?.f || null;
}

// ---------------------------------------------------------------------------
// Route layer
// ---------------------------------------------------------------------------
function drawRoute(ctx) {
  const A = state.analysis, pts = state.route.pts;
  if (!pts.length && !A) return;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // coloured underlay from the assessment, grouped into runs of one class
  if (A && A.samples.length > 1) {
    ctx.lineWidth = A.kind === 'traverse' ? 6 : 9;
    let run = null;
    const flush = () => { if (run) { ctx.strokeStyle = COLORS[run.level] + 'dd'; ctx.stroke(); run = null; } };
    let prev = null;
    for (const s of A.samples) {
      const p = map.toScreen(s.lon, s.lat);
      if (prev && prev.s.part === s.part) {
        if (!run || run.level !== s.level) { flush(); run = { level: s.level }; ctx.beginPath(); ctx.moveTo(prev.p[0], prev.p[1]); }
        ctx.lineTo(p[0], p[1]);
      } else flush();
      prev = { p, s };
    }
    flush();
  }
  if (A?.kind !== 'traverse' && pts.length) {
    const sug = state.route.suggested, ch = state.route.choice;
    const alt = ch && !state.route.editing ? (sug ? ch.userPts : ch.low?.pts) : null; // the other option, faint
    if (alt) {
      ctx.save(); ctx.globalAlpha = 0.55; ctx.lineWidth = 2; ctx.setLineDash([4, 6]);
      ctx.strokeStyle = sug ? '#ffffff' : COLORS.traverse;
      ctx.beginPath(); pathRing(ctx, alt); ctx.stroke(); ctx.restore();
    }
    ctx.lineWidth = 2.6; ctx.setLineDash(sug ? [7, 6] : [9, 7]); ctx.strokeStyle = sug ? COLORS.traverse : '#fff';
    ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 4;
    ctx.beginPath(); pathRing(ctx, pts);
    if (state.route.editing && state.cursor) { const [x, y] = map.toScreen(state.cursor[0], state.cursor[1]); ctx.lineTo(x, y); }
    ctx.stroke();
    ctx.setLineDash([]); ctx.shadowBlur = 0;
    // waypoints
    pts.forEach(([lon, lat], i) => {
      const [x, y] = map.toScreen(lon, lat);
      const end = i === 0 || i === pts.length - 1;
      if (sug && !end) { ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fillStyle = COLORS.traverse; ctx.fill(); return; } // computed vertices
      ctx.beginPath(); ctx.arc(x, y, end ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle = '#0b1018'; ctx.fill(); ctx.lineWidth = 2.4; ctx.strokeStyle = '#fff'; ctx.stroke();
    });
    // the user's own points, which the suggestion passes through
    if (sug) for (const [lon, lat] of sug.userPts.slice(1, -1)) {
      const [x, y] = map.toScreen(lon, lat);
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.lineWidth = 2.4; ctx.strokeStyle = '#fff'; ctx.stroke();
    }
    // insert handles at segment midpoints (drag to add a point)
    if (canEditRoute() && !sug) for (const m of midHandles()) {
      ctx.beginPath(); ctx.arc(m.x, m.y, 5.5, 0, Math.PI * 2); ctx.fillStyle = 'rgba(11,16,24,.75)'; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(m.x - 3, m.y); ctx.lineTo(m.x + 3, m.y); ctx.moveTo(m.x, m.y - 3); ctx.lineTo(m.x, m.y + 3); ctx.stroke();
    }
  }
  // flags (a badge that would overlap an earlier one is skipped; the marker itself is always drawn)
  const placed = [];
  const selFlag = state.selected?.kind === 'flag' ? state.selected.item : null;
  if (A) for (const f of A.flags) {
    const [x, y] = map.toScreen(f.lon, f.lat);
    if (x < -30 || y < -30 || x > map.w + 30 || y > map.h + 30) continue;
    const c = f.type === 'crater_rim' ? COLORS.crater : COLORS[f.level] || COLORS.caution;
    if (f.type === 'steep_slope') triangle(ctx, x, y - 4, 13, c);
    else if (f.type === 'crater_rim') { ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.lineWidth = 3; ctx.strokeStyle = c; ctx.stroke(); }
    else diamond(ctx, x, y, 6, c, '#fff');
    const bx = x + 15, by = y - 12;
    if (f === selFlag || !placed.some(([px, py]) => Math.abs(px - bx) < 30 && Math.abs(py - by) < 21)) { badge(ctx, f.n, bx, by, c); placed.push([bx, by]); }
    if (state.selected?.kind === 'flag' && state.selected.item === f) { ctx.beginPath(); ctx.arc(x, y - 2, 21, 0, Math.PI * 2); ctx.strokeStyle = '#6cc4ee'; ctx.lineWidth = 2; ctx.stroke(); }
  }
  // start / goal labels (as on the mission chart)
  if (A?.kind !== 'traverse' && pts.length) {
    const fmt = (v, k) => fmtDeg(v, k, state.fmt);
    const s = pts[0], [sx, sy] = map.toScreen(s[0], s[1]);
    label(ctx, ['START (P-0)', `LAT ${fmt(s[1], 'lat')}`, `LON ${fmt(s[0], 'lon')}`], sx - 10, sy - 14, { align: 'right' });
    if (pts.length > 1 && !state.route.editing) {
      const g = pts[pts.length - 1], [gx, gy] = map.toScreen(g[0], g[1]);
      const gi = state.route.suggested ? state.route.suggested.userPts.length - 1 : pts.length - 1;
      label(ctx, [`GOAL (P-${gi})`, `LAT ${fmt(g[1], 'lat')}`, `LON ${fmt(g[0], 'lon')}`], gx + 10, gy - 14);
    }
  }
}
function hitRoute(x, y) {
  if (!state.analysis) return null;
  for (const f of state.analysis.flags) { const [fx, fy] = map.toScreen(f.lon, f.lat); if (Math.hypot(fx - x, fy - y) < 15) return f; }
  return null;
}
const canEditRoute = () => !state.route.editing && state.route.pts.length > 1 && state.analysisKind === 'route' && !state.analyzing;
function midHandles() {
  const pts = state.route.pts, out = [];
  for (let k = 1; k < pts.length; k++) {
    const [ax, ay] = map.toScreen(...pts[k - 1]), [bx, by] = map.toScreen(...pts[k]);
    if (Math.hypot(bx - ax, by - ay) > 46) out.push({ k, x: (ax + bx) / 2, y: (ay + by) / 2 });
  }
  return out;
}

function drawInspect(ctx) {
  const p = state.inspect; if (!p) return;
  const [x, y] = map.toScreen(p.lon, p.lat);
  ctx.strokeStyle = '#6cc4ee'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - 16, y); ctx.lineTo(x - 5, y); ctx.moveTo(x + 5, y); ctx.lineTo(x + 16, y);
  ctx.moveTo(x, y - 16); ctx.lineTo(x, y - 5); ctx.moveTo(x, y + 5); ctx.lineTo(x, y + 16); ctx.stroke();
}

// graticule with edge labels, like a mission chart
function drawGraticule(ctx) {
  const [x0, y0, x1, y1] = map.bounds();
  const steps = [10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001, 0.0005, 0.0002, 0.0001];
  const step = steps.find((s) => s / map.res < 150 && s / map.res >= 60) || steps.reduce((a, s) => (s / map.res >= 60 ? s : a), steps[0]);
  const dec = Math.max(0, Math.ceil(-Math.log10(step) + 0.01));
  ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let lon = Math.ceil(x0 / step) * step; lon <= x1; lon += step) { const [x] = map.toScreen(lon, 0); ctx.moveTo(Math.round(x) + 0.5, BAND_TOP); ctx.lineTo(Math.round(x) + 0.5, map.h); }
  for (let lat = Math.ceil(y0 / step) * step; lat <= y1; lat += step) { const [, y] = map.toScreen(0, lat); ctx.moveTo(BAND_LEFT, Math.round(y) + 0.5); ctx.lineTo(map.w, Math.round(y) + 0.5); }
  ctx.stroke();
  ctx.fillStyle = 'rgba(10,15,23,.85)'; ctx.fillRect(0, 0, map.w, BAND_TOP); ctx.fillRect(0, BAND_TOP, BAND_LEFT, map.h);
  ctx.fillStyle = '#e7edf5'; ctx.font = '600 13px Barlow, system-ui'; ctx.textAlign = 'center';
  for (let lon = Math.ceil(x0 / step) * step; lon <= x1; lon += step) {
    const [x] = map.toScreen(lon, 0); if (x < 70) continue;
    ctx.fillText(`${Math.abs(lon).toFixed(dec)}° ${lon >= 0 ? 'E' : 'W'}`, x, 18);
  }
  ctx.textAlign = 'right';
  for (let lat = Math.ceil(y0 / step) * step; lat <= y1; lat += step) {
    const [, y] = map.toScreen(0, lat); if (y < 40) continue;
    ctx.fillText(`${lat.toFixed(dec)}°`, BAND_LEFT - 4, y + 4);
  }
  ctx.textAlign = 'left';
}

// ---------------------------------------------------------------------------
// Sidebar: regions, modes, layers
// ---------------------------------------------------------------------------
const missionOf = (id) => {
  const r = store.regions[id]?.region;
  return (r?.mission_context || REGION_FALLBACK[id].mission).replace(' / ', ' · ');
};
function renderRegionTabs() {
  $('regionTabs').innerHTML = REGION_ORDER.map((id) => {
    const r = store.regions[id]?.region || REGION_FALLBACK[id];
    return `<button data-region="${id}" class="${id === state.region ? 'active' : ''}">${esc(shortName(r.name || id))}<small>${esc(missionOf(id))}</small></button>`;
  }).join('');
  $('regionTabs').querySelectorAll('button').forEach((b) => { b.onclick = () => selectRegion(b.dataset.region); });
}
const shortName = (n) => n.replace(/\s*[/(].*$/, '').replace(' crater', '').replace(' Chasma', '');

function renderModeNote() {
  const t = thresholds().modes[state.mode];
  const basis = state.mode === 'rover' ? 'Apollo Lunar Roving Vehicle and NASA Mars rovers' : 'NASA Artemis EVA suit requirement and Apollo';
  $('modeNote').innerHTML = `Caution ≥ <b>${t.caution_deg}°</b> · No-go ≥ <b>${t.nogo_deg}°</b> · Walk-back limit <b>${t.walkback_km} km</b><br>` +
    `<span>Basis: ${basis}. ${usingFallbackThresholds() ? '<b class="warnc">Fallback values: manifest not loaded.</b>' : 'Approved thresholds.'} <a class="lnk" data-open="thresholds">Details</a></span>`;
  $('modeNote').querySelector('[data-open]').onclick = () => openModal('thresholds');
}

const LAYER_DEFS = [
  { key: 'imagery', label: 'Imagery', sub: 'HiRISE / CTX via Mars Trek · Viking colour', sw: 'linear-gradient(135deg,#a8644a,#6b3c2c 60%,#c88a64)' },
  { key: 'slope', label: 'Slope', sub: 'Terrain gradient (°) · HiRISE 5 m / CTX 18 m', sw: 'linear-gradient(90deg,#fcfdbf,#fe9f6d,#de4968,#8c2981,#3b0f70)', needs: 'slope' },
  { key: 'geology', label: 'Geology', sub: 'Unit boundaries · USGS SIM 3292', sw: 'linear-gradient(135deg,#c1784f 0 45%,#5f8fae 45% 70%,#8f9e5a 70%)', needs: 'geology' },
  { key: 'traverse', label: 'Rover traverse', sub: 'NASA/JPL MMGIS ground truth', sw: 'linear-gradient(160deg,transparent 45%,#7fd6ff 45% 55%,transparent 55%)', needs: 'traverse' },
  { key: 'hazards', label: 'Hazards', sub: 'Detected risks (severity 1 – 6)', haz: true, needs: 'hazards' },
  { key: 'hillshade', more: true, label: 'Shaded relief', sub: 'From the elevation models · works offline', sw: 'linear-gradient(135deg,#ddd,#555)', needs: 'hillshade' },
  { key: 'nodata', more: true, label: 'No-data areas', sub: 'Stereo gaps · terrain unknown', sw: 'repeating-linear-gradient(45deg,#8a93a3 0 3px,#2a3342 3px 7px)', needs: 'unknown' },
  { key: 'suspect', more: true, label: 'Suspect values', sub: 'Flagged outliers (not removed)', sw: 'radial-gradient(#e600e6 30%,#2a1f2a 32%)', needs: 'suspect' },
  { key: 'footprints', more: true, label: 'Elevation-model coverage', sub: 'HiRISE (bright) / CTX footprints', sw: 'repeating-linear-gradient(90deg,#6cc4ee 0 5px,#0e1520 5px 9px)', needs: 'footprints' },
  { key: 'craters', more: true, label: 'Craters', sub: 'Robbins catalogue, ≥ 1 km', sw: 'radial-gradient(circle,transparent 48%,#c9a0ff 50% 58%,transparent 60%)', needs: 'craters' },
  { key: 'waypoints', more: true, label: 'Rover tilt at waypoints', sub: 'On-board tilt, NASA/JPL MMGIS', sw: 'radial-gradient(circle at 30% 40%,#46b98a 3px,transparent 4px),radial-gradient(circle at 70% 60%,#f0a43a 3px,transparent 4px),#0e1520', needs: 'waypoints' },
];
const HZ_TYPES = [
  { key: 'steep_slope', label: 'Steep slope' }, { key: 'crater_rim', label: 'Crater rim' }, { key: 'data_gap', label: 'Data gap' },
  { key: 'rough_terrain', label: 'Roughness', exp: true }, { key: 'relief', label: 'Relief', exp: true },
];
function hasData(need) {
  const R = state.R; if (!R || !need) return true;
  if (['hillshade', 'slope', 'unknown', 'suspect'].includes(need)) return !!R.overlays[need]?.length;
  if (need === 'waypoints') return !!R.region.files?.traverse_waypoints_original;
  return !!R[need]?.features?.length;
}
function renderLayers() {
  const more = LAYER_DEFS.filter((d) => d.more);
  const rows = (d) => {
    const ok = hasData(d.needs);
    const on = state.layers[d.key] && ok;
    const sw = d.haz ? `<div class="swatch haz"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 3l10 17H2z" fill="#e5484d" stroke="#fff" stroke-width="1.4"/><text x="12" y="17.5" text-anchor="middle" font-size="11" font-weight="800" fill="#fff">!</text></svg></div>`
      : `<div class="swatch" style="background:${d.sw}"></div>`;
    const count = d.haz ? '<span class="more" id="hzCount"></span>' : (ok ? '' : '<span class="more">n/a</span>');
    let row = `<div class="layer ${on ? 'on' : ''} ${ok ? '' : 'disabled'}" data-key="${d.key}" title="${ok ? '' : 'Not available for this region'}"><div class="check"></div>${sw}<div class="lbl"><b>${d.label}</b><span>${d.sub}</span></div>${count}</div>`;
    if (d.key === 'imagery' && on) row += `<div class="subtypes open"><button class="chip ${state.layers.tint ? 'on' : ''}" data-flag-layer="tint" title="Display only: grey HiRISE/CTX mosaics take the hue of the Viking colour mosaic">Viking colour tint</button></div>`;
    if (d.haz) row += `<div class="subtypes ${on ? 'open' : ''}" id="hzTypes">${HZ_TYPES.map((t) => `<button class="chip ${state.hazardTypes[t.key] ? 'on' : ''}" data-hz="${t.key}" ${t.exp ? 'title="Experimental: the floors are placeholders chosen during processing, not published limits"' : ''}>${t.label}${t.exp ? '<i>exp.</i>' : ''}</button>`).join('')}</div>`;
    if (d.key === 'slope' && on) row += slopeLegend();
    if (d.key === 'waypoints' && on) row += `<div class="legend" style="padding:2px 0 8px 32px">${['ok', 'caution', 'nogo'].map((k) => `<span style="--c:${COLORS[k]}">${LEVEL_TEXT[k]}</span>`).join('')}<span style="color:var(--faint)">${MODE_NAME[state.mode]} limits on recorded tilt</span></div>`;
    return row;
  };
  $('layerList').innerHTML = LAYER_DEFS.filter((d) => !d.more).map(rows).join('') +
    `<div class="moretoggle" id="moreToggle">${state.moreLayers ? 'Fewer layers ▴' : `More layers (${more.length}) ▾`}</div>` +
    (state.moreLayers ? more.map(rows).join('') : '');
  $('moreToggle').onclick = () => { state.moreLayers = !state.moreLayers; renderLayers(); };
  $('layerList').querySelectorAll('.layer').forEach((el) => {
    el.onclick = () => {
      if (el.classList.contains('disabled')) return;
      const k = el.dataset.key; state.layers[k] = !state.layers[k];
      if (k === 'waypoints' && state.layers.waypoints && state.R) loadWaypoints(state.R).then(() => map.render());
      renderLayers(); applyVisibility(); computeOverview();
    };
  });
  $('layerList').querySelectorAll('[data-hz]').forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation(); const k = el.dataset.hz; state.hazardTypes[k] = !state.hazardTypes[k];
      el.classList.toggle('on'); computeOverview(); map.render();
    };
  });
  $('layerList').querySelectorAll('[data-flag-layer]').forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); const k = el.dataset.flagLayer; state.layers[k] = !state.layers[k]; el.classList.toggle('on'); applyVisibility(); };
  });
  updateHzCount();
}
function slopeLegend() {
  const o = state.R?.overlays?.slope?.[0];
  if (!o?.legend) return '';
  const bl = [...new Set((state.R.overlays.slope || []).map((x) => x.slope_baseline_m || (x.dem.startsWith('ctx') ? 18 : null)).filter(Boolean))].sort((a, b) => a - b);
  return `<div class="legend slope-legend">${o.legend.map((e) => `<span style="--c:rgba(${(e.rgba || [0, 0, 0, 255]).slice(0, 3).join(',')})" title="${esc(e.why_this_edge || '')}">${esc(e.label)}</span>`).join('')}
    <span class="lg-note">Slope over ${bl.map((b) => `${b} m`).join(' / ')} · transparent = no slope value</span></div>`;
}
function updateHzCount() {
  const el = $('hzCount'); if (!el) return;
  el.textContent = state.R ? `${state.visibleHz.length} in view` : '';
}

// ---------------------------------------------------------------------------
// Risk panel
// ---------------------------------------------------------------------------
const ICONS = {
  steep_slope: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 26L19 8l10 18z"/><path d="M8 26l5-6 3 3 4-5"/><path d="M22 6l2-2"/></svg>',
  crater_rim: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.7"><ellipse cx="16" cy="16" rx="12" ry="10"/><ellipse cx="17" cy="17" rx="7" ry="5.5"/></svg>',
  data_gap: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="5" y="5" width="22" height="22" rx="2" stroke-dasharray="3 3"/><path d="M12 13a4 4 0 118 0c0 3-4 3-4 6M16 23v.5"/></svg>',
  no_coverage: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="5" y="5" width="22" height="22" rx="2"/><path d="M8 24L24 8"/></svg>',
  rough_terrain: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 24l5-6 3 3 4-7 4 5 3-3 7 8z"/></svg>',
  relief: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 26h24M8 26V12M16 26V6M24 26V16"/></svg>',
};
const pips = (n, c) => `<div class="pips" style="--c:${c}">${[1, 2, 3, 4, 5, 6].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</div>`;
const coordLine = (lon, lat) => `<b>LAT</b>${fmtDeg(lat, 'lat', state.fmt)}&nbsp;&nbsp;<b>LON</b>${fmtDeg(lon, 'lon', state.fmt)}`;
const tagsHTML = (list) => list.filter(Boolean).map((t) => (typeof t === 'string' ? `<span class="tag">${esc(t)}</span>` : `<span class="tag ${t.cls}">${esc(t.text)}</span>`)).join('');
const roverName = (tr) => (tr?.rover || 'the rover').replace(/\s*\(.*\)\s*$/, '');
const areaText = (a) => (a >= 1e6 ? `${(a / 1e6).toFixed(2)} km²` : `${Math.round(a).toLocaleString('en-US')} m²`);

function renderRisk() {
  const el = $('risk');
  let html = '';
  if (state.inspect) html += inspectCard();
  html += routeMode() ? routeBlock() : overviewBlock();
  el.innerHTML = html;
  el.querySelectorAll('[data-flag]').forEach((c) => { c.onclick = () => selectFlag(state.analysis.flags[+c.dataset.flag - 1], true); });
  el.querySelectorAll('[data-hzn]').forEach((c) => { c.onclick = () => selectHz(state.overview[+c.dataset.hzn - 1], true); });
  const close = el.querySelector('[data-close-inspect]'); if (close) close.onclick = () => { state.inspect = null; renderRisk(); map.render(); };
  el.querySelectorAll('[data-run-traverse]').forEach((b) => { b.onclick = () => assessTraverse(); });
  const cp = el.querySelector('[data-copy-route]'); if (cp) cp.onclick = copyRoute;
  const ex = el.querySelector('[data-exit-analysis]'); if (ex) ex.onclick = clearRoute;
  el.querySelectorAll('[data-nav]').forEach((b) => { b.onclick = () => openNav(b.dataset.nav); });
  const cn = el.querySelector('[data-copy-nav]');
  if (cn) cn.onclick = () => { const t = state.navShare.phone; const ok = () => toast('Phone link copied'); if (navigator.clipboard?.writeText) navigator.clipboard.writeText(t).then(ok, () => fallbackCopy(t, ok)); else fallbackCopy(t, ok); };
  const pr = el.querySelector('[data-print]'); if (pr) pr.onclick = () => { state.showAllFlags = true; renderRisk(); setTimeout(() => window.print(), 50); };
  const sg = el.querySelector('[data-suggest]'); if (sg) sg.onclick = runSuggest;
  const us = el.querySelector('[data-unsuggest]'); if (us) us.onclick = backToUserRoute;
  const sl = el.querySelector('[data-showlow]'); if (sl) sl.onclick = showLowRoute;
  const sa = el.querySelector('[data-show-all]'); if (sa) sa.onclick = () => { state.showAllFlags = true; renderRisk(); };
  const pf = el.querySelector('canvas.profile'); if (pf) drawProfile(pf);
}

function overviewBlock() {
  const n = state.visibleHz.length;
  $('riskCount').textContent = state.R ? `${n} hazard${n === 1 ? '' : 's'} in view` : '';
  if (!store.available) return '<div class="empty"><b>Processed data not loaded.</b> The map shows NASA Mars Trek imagery only. Put the <code>solus_processed</code> folder into <code>data/</code> (see README).</div>';
  let html = '';
  const tr = state.R?.traverse?.features?.[0]?.properties;
  if (tr) {
    html += `<button class="gt" data-run-traverse><b>Ground truth: assess ${esc(roverName(tr))}'s real traverse</b><span>${tr.length_km ?? ''} km driven by a NASA rover, checked with the same ${MODE_NAME[state.mode]} limits</span></button>`;
  } else if (state.R && !state.R.traverse) {
    html += '<div class="empty small">No rover has visited this region, so there is no ground-truth traverse to compare with.</div>';
  }
  if (!state.overview.length) return html + `<div class="empty">No mapped hazards in view for <b>${MODE_NAME[state.mode]}</b> mode with the selected types.<br><br><b>Plan a route</b> with the route tool (top right) for a sample-by-sample check.</div>`;
  return html + `<div class="risk-head"><span>Top ${state.overview.length} in view · ranked by typical (p95) slope</span><span class="info" title="Within each level, squares that their elevation model covers well (≥ 50 %) and whose peak is not on suspect pixels are listed first. Edge-of-coverage and suspect squares stay on the map with their tags.">ⓘ</span></div>` +
    state.overview.map((h) => hzCard(h)).join('') +
    '<div class="empty small">Each steep-slope point summarises a 1 km square. <b>Plan a route</b> for a sample-by-sample check along your path.</div>';
}

function hzTitle(h) {
  const p = h.p;
  if (h.type === 'steep_slope') return `Steep slope — p95 ${(p.p95 ?? p.value).toFixed(1)}°`;
  if (h.type === 'crater_rim') { const r = rimOf(p); return `Crater rim — ${(p.diam_km ?? p.value).toFixed(1)} km${r.p95 != null ? ` · rim p95 ${r.p95.toFixed(1)}°` : ''}`; }
  if (h.type === 'data_gap') return `Data gap — ${areaText(+p.value || 0)}`;
  return `${h.type === 'relief' ? 'Relief' : 'Roughness'} (exp.) — ${(+p.value).toFixed(2)} ${p.unit || ''}`;
}
function hzTags(h) {
  const p = h.p;
  const near = state.nearSet?.has(h) ? { cls: 'near', text: `within ${ROUTE.hazardBuffer} m of route` } : null;
  const cov = p.source_coverage_pct != null && p.source_coverage_pct < 50 ? `edge of coverage (${p.source_coverage_pct}% of square)` : null;
  if (h.type === 'crater_rim') {
    const r = rimOf(p);
    return [r.dem ? `${r.camera} set ${r.set_id} · ${r.baseline_m} m` : 'rim not measured', p.robbins_id && `Robbins ${p.robbins_id}`, near];
  }
  return [p.camera && `${p.camera}${p.baseline_m ? ` · ${p.baseline_m} m baseline` : p.window_m ? ` · ${p.window_m} m window` : p.res_m ? ` · ${p.res_m} m` : ''}`,
    p.set_id && `set ${p.set_id}`, cov, p.suspect ? { cls: 'suspect', text: 'suspect data' } : null, near];
}
function hzEvidence(h) {
  const p = h.p;
  let ev = esc(p.evidence || '');
  if (h.type === 'steep_slope') {
    const lv = hzLevel(h);
    ev += `<br><span class="muted">Colour and severity use the 95th percentile in the square (${(p.p95 ?? p.value).toFixed(1)}° → ${MODE_NAME[state.mode]}: ${LEVEL_TEXT[lv]}, severity ${hzSeverity(h)}/6). The steepest single spot (${(+p.value).toFixed(1)}°, severity ${p.severity ?? severityFor(p.value)}/6) is often an elevation-model artifact.</span>`;
  }
  if (h.type === 'crater_rim' && (p.diam_km ?? 0) >= LARGE_CRATER_KM) ev += `<br><span class="muted">${esc(LARGE_CRATER_NOTE)}</span>`;
  if (h.type === 'rough_terrain' || h.type === 'relief') ev += '<br><span class="muted">Experimental: the floor for this type is a placeholder chosen during processing, not a published limit.</span>';
  return ev;
}
function hzCard(h) {
  const lvl = hzLevel(h), c = COLORS[lvl] || COLORS.caution, sev = hzSeverity(h);
  const sel = state.selected?.kind === 'hz' && state.selected.item === h;
  const lvlTxt = h.type === 'steep_slope' ? `${MODE_NAME[state.mode]}: ${LEVEL_TEXT[lvl]}` : '';
  return `<div class="card ${sel ? 'sel' : ''}" data-hzn="${h.n}" style="--c:${c}">
    <div class="ico">${ICONS[h.type] || ICONS.steep_slope}</div>
    <div><h3>${String(h.n).padStart(2, '0')} · ${esc(hzTitle(h))}</h3>
      <div class="coords">${coordLine(h.lon, h.lat)}</div>
      <div class="sev"><span>${sev ? `Severity: ${sev} / 6` : h.type === 'data_gap' ? 'Terrain unknown' : 'Severity: n/a'}${lvlTxt ? ` · ${lvlTxt}` : ''}</span>${sev ? pips(sev, c) : ''}</div>
      <div>${tagsHTML(hzTags(h))}</div></div>
    <div class="ev">${hzEvidence(h)}</div></div>`;
}

function nearSummary() {
  if (!state.nearSet) return '';
  const list = [...state.nearSet];
  const steep = list.filter((h) => h.type === 'steep_slope');
  const lv = (l) => steep.filter((h) => hzLevel(h) === l).length;
  return `<div class="row"><span>Mapped steep 1 km squares within ${ROUTE.hazardBuffer} m</span><b>${steep.length}${steep.length ? ` (${lv('nogo')} no-go, ${lv('caution')} caution by p95)` : ''}</b></div>`;
}

function routeBlock() {
  const pts = state.route.pts, A = state.analysis;
  const kind = state.analysisKind;
  if (!A) {
    $('riskCount').textContent = kind === 'traverse' ? 'Assessing traverse' : 'Planning route';
    if (kind === 'traverse') return `<div class="empty">${esc(state.analyzing || 'Assessing traverse…')}</div>`;
    return `<div class="summary"><div class="row"><span>Waypoints</span><b>${pts.length}</b></div><div class="row"><span>Distance so far</span><b>${fmtDist(pathLength(pts))}</b></div></div>
      <div class="empty">${state.analyzing ? esc(state.analyzing) : pts.length < 2 ? 'Click on the map to place <b>START</b>, then more points.' : 'Double-click or press <b>Enter</b> to finish and assess the route. Right-click or Backspace removes the last point; Esc cancels.'}</div>`;
  }
  const T = A.totals, tot = Object.values(T).reduce((a, b) => a + b, 0) || 1;
  const pct = (k) => (100 * T[k] / tot);
  const nFlags = A.flags.length;
  $('riskCount').textContent = `${nFlags} item${nFlags === 1 ? '' : 's'} on ${kind === 'traverse' ? 'traverse' : 'route'}`;
  const th = A.thresholds;
  const srcs = A.sources.map((d) => { const g = state.R.grids[d]?.slope?.meta; const dm = state.R.demById[d]; return `${dm?.camera || d.split('_')[0].toUpperCase()} ${d.split('_')[1]}${g?.baseline_m ? ` (${g.baseline_m} m)` : ''}`; }).join(', ') || '—';
  const wb = A.walkback.exceeded
    ? `<div class="warn">Route reaches <b>${fmtDist(A.walkback.max_m)}</b> from its start, beyond the <b>${th.walkback_km} km walk-back limit</b> for ${state.mode === 'rover' ? 'an unpressurised rover (NASA EVA-EXP-0075: "~10 km, ~5 hr walk back")' : 'a Marswalk (NASA EVA-EXP-0075: traverses "up to 2 km away from the lander")'}. Plan a return or a support vehicle.</div>`
    : A.walkback.applies ? `<div class="row"><span>Farthest from start</span><b>${fmtDist(A.walkback.max_m)} of ${th.walkback_km} km walk-back limit</b></div>` : '';
  const verdictBits = [];
  if (pct('nogo') > 0) verdictBits.push(`<b>${pct('nogo').toFixed(1)}%</b> no-go`);
  if (pct('caution') > 0) verdictBits.push(`<b>${pct('caution').toFixed(1)}%</b> caution`);
  if (pct('unknown') + pct('outside') > 0) verdictBits.push(`<b>${(pct('unknown') + pct('outside')).toFixed(1)}%</b> not assessable`);
  const head = kind === 'traverse' ? traverseHeader(A, pct) : suggestionBlock();
  const time = A.hours < 1 ? `${Math.round(A.hours * 60)} min` : `${A.hours.toFixed(1)} h`;
  return head + `<div class="summary">
      <div class="row"><span>Distance</span><b>${fmtDist(A.length)}${A.parts > 1 ? ` in ${A.parts} parts` : ''}</b></div>
      ${kind === 'traverse' ? '' : `<div class="row"><span>Est. time at ${SPEEDS_KMH[state.mode]} km/h (level ground)</span><b>${time}</b></div>`}
      <div class="row"><span>Max slope sampled</span><b>${A.maxSlope != null ? `${A.maxSlope.toFixed(1)}° (${A.maxSample.camera} ${A.maxSample.baseline_m} m)` : '—'}</b></div>
      <div class="row"><span>Climb / descent*</span><b>${A.elevRange ? `+${Math.round(A.gain)} m / −${Math.round(A.loss)} m` : '—'}</b></div>
      <div class="row"><span>Assessed with</span><b class="right">${esc(srcs)}</b></div>
      ${nearSummary()}
      <div class="bar">${['ok', 'caution', 'nogo', 'unknown', 'outside'].map((k) => `<i style="width:${pct(k)}%;background:${COLORS[k]}"></i>`).join('')}</div>
      <div class="legend">${['ok', 'caution', 'nogo', 'unknown', 'outside'].map((k) => `<span style="--c:${COLORS[k]}">${LEVEL_TEXT[k]} ${pct(k) > 0 && pct(k) < 1 ? '<1' : pct(k).toFixed(0)}%</span>`).join('')}</div>
      <canvas class="profile" width="640" height="200"></canvas>
      ${wb}
      <div class="verdict">${verdictBits.length ? `${verdictBits.join(' · ')}. ` : 'No caution or no-go stretches where data exists. '}This is <b>not a safety verification</b>: slope can't show sand vs rock or rocks under ~1 m.</div>
      <div class="foot-note">* counted only between samples from the same elevation model; models disagree by tens of metres. Elevations are model heights (no MOLA offset). Sample spacing ${fmtDist(A.step)}.</div>
      ${kind === 'route' ? `<div class="navrow"><button class="btn nav" data-nav="tablet">▶ Navigate · rover tablet</button><button class="btn nav" data-nav="wrist">⌚ Wrist view</button></div>${navInfo()}` : ''}
      <div class="btnrow">${kind === 'route' && !state.route.choice ? '<button class="btn" data-suggest>Find the lowest-risk route</button>' : ''}${kind === 'route' ? '<button class="btn ghost" data-copy-route>Copy as text</button>' : ''}<button class="btn ghost" data-print>Print</button><button class="btn ghost" data-exit-analysis>${kind === 'traverse' ? 'Close traverse check' : 'Clear route'}</button></div>
      ${kind === 'route' ? `<div class="foot-note">${state.route.suggested ? 'Dragging a point turns the lowest-risk route into your own route.' : 'Edit: drag a point to move it, drag a ⊕ to add one, right-click a point to remove it.'}</div>` : ''}
    </div>` +
    (A.flagLevels.length === 1 ? '<div class="empty small">Numbered flags mark no-go stretches, data gaps and crater rims; caution stretches are amber on the line and counted in the totals.</div>' : '') +
    (nFlags ? A.flags.slice(0, state.showAllFlags ? nFlags : 30).map((f) => flagCard(f)).join('') +
      (nFlags > 30 && !state.showAllFlags ? `<button class="btn ghost wide" data-show-all>Show all ${nFlags} items</button>` : '')
      : `<div class="empty">No flagged stretches for ${MODE_NAME[state.mode]} limits (${A.flagLevels.length === 1 ? `no-go ≥ ${th.nogo_deg}°` : `caution ≥ ${th.caution_deg}°`}) where data exists.</div>`);
}

/** Numbers for the route-choice comparison, from one assessment. */
function summarize(A) {
  const T = A.totals, tot = Object.values(T).reduce((a, b) => a + b, 0) || 1, p = (k) => (100 * T[k]) / tot;
  return { length: A.length, hours: A.hours, caution: p('caution'), nogo: p('nogo'), nodata: p('unknown') + p('outside'), maxSlope: A.maxSlope, flags: A.flags.length };
}
function suggestionBlock() {
  const err = state.route.suggestError;
  if (err) return `<div class="warn"><b>No lowest-risk route.</b> ${esc(err.charAt(0).toUpperCase() + err.slice(1))}</div>`;
  const ch = state.route.choice; if (!ch) return '';
  const U = ch.userSum, L = ch.low?.sum, info = ch.low?.info, showingLow = !!state.route.suggested;
  const pc = (v) => (v == null ? '—' : v > 0 && v < 0.1 ? '<0.1%' : `${v.toFixed(1)}%`);
  const tm = (h) => (h == null ? '—' : h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1)} h`);
  const row = (label, u, l, fmt, lowerIsBetter = true) => {
    const better = (a, b) => a != null && b != null && (lowerIsBetter ? a < b - 1e-9 : a > b + 1e-9);
    return `<tr><td>${label}</td><td class="${better(u, l) ? 'win' : ''}">${fmt(u)}</td><td class="${better(l, u) ? 'win' : ''}">${fmt(l)}</td></tr>`;
  };
  const table = `<table class="choice">
      <tr><th></th><th class="${showingLow ? '' : 'on'}">Your route</th><th class="${showingLow ? 'on' : ''}">Lowest-risk</th></tr>
      ${row('No-go', U?.nogo, L?.nogo, pc)}
      ${row('Caution', U?.caution, L?.caution, pc)}
      ${row('No data / not covered', U?.nodata, L?.nodata, pc)}
      ${row('Steepest sample', U?.maxSlope, L?.maxSlope, (v) => (v == null ? '—' : `${v.toFixed(1)}°`))}
      ${row('Flagged items', U?.flags, L?.flags, (v) => (v == null ? '—' : String(v)))}
      ${row('Distance', U?.length, L?.length, (v) => (v == null ? '—' : fmtDist(v)))}
      ${row(`Time at ${SPEEDS_KMH[state.mode]} km/h`, U?.hours, L?.hours, tm)}
    </table>`;
  const sets = info ? [...new Set(info.legs.map((l) => l.set))].join(', ') : '';
  const snaps = info ? info.legs.flatMap((l, i) => [l.snapA ? `START${info.legs.length > 1 ? ` of leg ${i + 1}` : ''} moved ${Math.round(l.snapA)} m` : null, l.snapB ? `GOAL${info.legs.length > 1 ? ` of leg ${i + 1}` : ''} moved ${Math.round(l.snapB)} m` : null]).filter(Boolean) : [];
  const left = info && info.nogoLeftM > 0
    ? `<p class="left">The check still finds about ${fmtDist(info.nogoLeftM)} of no-go on it that no detour within the search area avoids (often right at START or GOAL). Those stretches are flagged below.</p>` : '';
  return `<div class="sugg">
    <h4>Route choice · ${MODE_NAME[ch.mode]} limits</h4>
    ${table}
    <div class="btnrow">${showingLow ? '<button class="btn" data-unsuggest>Show my route</button>' : '<button class="btn" data-showlow>Show lowest-risk route</button>'}</div>
    ${info ? `<p><b>Lowest-risk route</b> through your ${ch.userPts.length} points: planned on the slope of MRO CTX DEM set ${esc(sets)} (18 m cells), then checked with the most detailed data and re-planned (${info.passes} pass${info.passes > 1 ? 'es' : ''}). It is planned around no-go and no-data ground, and over caution ground only where no detour exists (a caution cell costs ${info.cautionFactor}× more per metre; gentler slopes cost 1 + (slope / ${info.refDeg}°)²; SOLUS choices, not published rules).${snaps.length ? ` ${esc(snaps.join('; '))} to the nearest usable cell.` : ''}</p>` : ''}
    ${left}
    <p class="muted">The lowest risk the slope data can show, not a safety guarantee: slope cannot show loose sand or rocks smaller than about 1 m.</p>
  </div>`;
}

function traverseHeader(A, pct) {
  const v = state.R.validation?.rover_path, tr = state.R.traverse?.features?.[0]?.properties || {};
  const tilt = v?.rover_measured_tilt_deg;
  const per = (v?.per_dem || []).filter((d) => d.classification_along_traverse);
  const nogoRange = per.length ? `${Math.min(...per.map((d) => d.classification_along_traverse[state.mode].nogo))}–${Math.max(...per.map((d) => d.classification_along_traverse[state.mode].nogo))}%` : '—';
  const notNogo = 100 - pct('nogo');
  return `<div class="gt-result">
    <h4>Ground truth · ${esc(tr.rover || 'rover')} traverse</h4>
    <div class="big">${notNogo.toFixed(1)}%</div><div class="sub">of the real path is <b>not no-go</b> in ${MODE_NAME[state.mode]} mode (no-go ${pct('nogo').toFixed(1)}%, no data or not covered ${(pct('unknown') + pct('outside')).toFixed(1)}%)</div>
    <ul>
      <li>Each sample uses the most detailed model with data (HiRISE 5 m first, then CTX 18 m).</li>
      ${per.length ? `<li>Processing pipeline, one model at a time: no-go on ${nogoRange} of the path.</li>` : ''}
      ${tilt ? `<li>The rover's own on-board tilt at ${tilt.n} waypoints: ${tilt.classification?.[state.mode]?.nogo ?? '—'}% no-go (max ${tilt.max}°, sol ${tilt.sol_of_max}).</li>` : ''}
      <li>Line: NASA/JPL MMGIS traverse, simplified at ${tr.simplify_tolerance_m ?? 3} m for display (sol ${tr.sol_first ?? '?'}–${tr.sol_last ?? '?'}).</li>
    </ul>
    <p class="muted">Rover drivers chose easy paths, and a robotic rover is not a crewed vehicle; this shows the limits behave sensibly, not that terrain is safe. Walk-back rule not applied to a robotic traverse.</p>
  </div>`;
}

function flagCard(f) {
  const c = f.type === 'crater_rim' ? COLORS.crater : COLORS[f.level] || COLORS.caution;
  const sel = state.selected?.kind === 'flag' && state.selected.item === f;
  const sev = f.severity || 0;
  const tags = f.type === 'crater_rim'
    ? [f.rim.dem ? `${f.rim.camera} set ${f.rim.set_id} · ${f.rim.baseline_m} m` : 'rim not measured', `Robbins ${f.crater_id}`, `at ${fmtDist(f.d)}`]
    : [f.dem && `${f.camera || (f.dem.startsWith('hirise') ? 'HiRISE' : 'CTX')} set ${f.set_id ?? f.dem.split('_')[1]}`, f.baseline_m && `${f.baseline_m} m baseline`,
      f.type !== 'steep_slope' ? `${fmtDist(f.start_d)}–${fmtDist(f.end_d)}` : `at ${fmtDist(f.d)}`, f.suspect ? { cls: 'suspect', text: 'suspect data' } : null];
  return `<div class="card ${sel ? 'sel' : ''}" data-flag="${f.n}" style="--c:${c}">
    <div class="ico">${ICONS[f.type] || ICONS.steep_slope}</div>
    <div><h3>Risk ${String(f.n).padStart(2, '0')} — ${esc(FLAG_TITLES[f.type](f))}</h3>
      <div class="coords">${coordLine(f.lon, f.lat)}</div>
      <div class="sev"><span>${sev ? `Severity: ${sev} / 6` : f.type === 'data_gap' || f.type === 'no_coverage' ? 'Terrain unknown' : 'Severity: n/a'}${f.type === 'steep_slope' ? ` · ${LEVEL_TEXT[f.level]}` : ''}</span>${sev ? pips(sev, c) : ''}</div>
      <div>${tagsHTML(tags)}</div></div>
    <div class="ev">${esc(f.evidence)}</div></div>`;
}

function inspectCard() {
  const p = state.inspect, s = p.sample;
  let body = '<div class="row"><span>Terrain</span><b>loading…</b></div>';
  if (s) {
    if (s.status === 'ok') {
      const lvl = levelFor(s.slope, state.mode);
      const dm = state.R.demById[s.dem] || {};
      body = `<div class="row"><span>Slope (${s.baseline_m} m baseline)</span><b style="color:${COLORS[lvl]}">${s.slope.toFixed(1)}° · ${MODE_NAME[state.mode]}: ${LEVEL_TEXT[lvl]}</b></div>
        <div class="row"><span>Elevation (model height)</span><b>${s.elev != null ? `${Math.round(s.elev)} m` : '—'}</b></div>
        ${s.rough != null ? `<div class="row"><span>Roughness (${dm.rough_window_m ?? '?'} m window)</span><b>${s.rough.toFixed(2)} m</b></div>` : ''}
        <div class="row"><span>Source</span><b>MRO ${s.camera} DEM set ${s.set_id} · ${s.res_m} m grid</b></div>
        ${p.suspect ? `<div class="row"><span>Data quality</span><b style="color:${COLORS.suspect}">suspect pixels here (flagged, not removed)</b></div>` : ''}`;
    } else if (s.status === 'unknown') body = `<div class="row"><span>Terrain</span><b style="color:${COLORS.unknown}">No data (stereo gap or its edge) in ${esc(demLabel(s.dem))}</b></div>`;
    else body = '<div class="row"><span>Terrain</span><b style="color:var(--faint)">Outside all elevation models</b></div>';
  }
  const unit = p.unit ? `<div class="row"><span>Geologic unit (1:20M map)</span><b class="right">${esc(p.unit)}</b></div>` : '';
  const near = p.near != null ? `<div class="row"><span>Mapped steep squares within 500 m</span><b>${p.near}</b></div>` : '';
  return `<div class="summary inspect">
    <div class="row"><b>Selected location</b><a data-close-inspect class="x">✕</a></div>
    <div class="row"><span>LAT / LON</span><b class="mono">${fmtDeg(p.lat, 'lat', state.fmt)}, ${fmtDeg(p.lon, 'lon', state.fmt)}</b></div>
    ${body}${unit}${near}</div>`;
}

function drawProfile(cv) {
  const A = state.analysis; if (!A) return;
  const ctx = cv.getContext('2d'); const W = cv.width, H = cv.height, padL = 64, padR = 16, padT = 22, padB = 26;
  ctx.clearRect(0, 0, W, H);
  const pts = A.samples.filter((s) => s.elev != null);
  ctx.font = '19px Barlow, system-ui'; ctx.fillStyle = '#8d9bb0';
  if (pts.length < 2) { ctx.fillText('No elevation data along this route', padL, H / 2); return; }
  let e0 = Infinity, e1 = -Infinity; for (const s of pts) { e0 = Math.min(e0, s.elev); e1 = Math.max(e1, s.elev); }
  const X = (d) => padL + (d / A.length) * (W - padL - padR), Y = (e) => H - padB - ((e - e0) / Math.max(1, e1 - e0)) * (H - padT - padB);
  // unknown / not-covered spans
  for (const s of A.samples) if (s.level === 'unknown' || s.level === 'outside') { ctx.fillStyle = s.level === 'unknown' ? 'rgba(138,147,163,.28)' : 'rgba(59,70,88,.4)'; ctx.fillRect(X(s.d) - 1, padT - 6, 3, H - padT - padB + 6); }
  ctx.lineWidth = 3.2;
  for (let i = 1; i < A.samples.length; i++) {
    const a = A.samples[i - 1], b = A.samples[i];
    if (a.elev == null || b.elev == null || a.dem !== b.dem || a.part !== b.part) continue;
    ctx.strokeStyle = COLORS[b.level]; ctx.beginPath(); ctx.moveTo(X(a.d), Y(a.elev)); ctx.lineTo(X(b.d), Y(b.elev)); ctx.stroke();
  }
  ctx.fillStyle = '#8d9bb0'; ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(e1)} m`, padL - 6, padT + 6); ctx.fillText(`${Math.round(e0)} m`, padL - 6, H - padB);
  ctx.textAlign = 'left'; ctx.fillText('0', padL, H - 4);
  ctx.textAlign = 'right'; ctx.fillText(fmtDist(A.length), W - padR, H - 4); ctx.textAlign = 'left';
  for (const f of A.flags) { ctx.fillStyle = f.type === 'crater_rim' ? COLORS.crater : COLORS[f.level] || '#fff'; ctx.fillRect(X(f.d) - 1.5, padT - 14, 3, 10); }
}

// ---------------------------------------------------------------------------
// Popover near the selected marker
// ---------------------------------------------------------------------------
function popContent(sel) {
  if (sel.kind === 'hz') {
    const h = sel.item, lvl = hzLevel(h);
    return `<b>${h.n ? `${String(h.n).padStart(2, '0')} · ` : ''}${esc(hzTitle(h))}</b>
      <div class="mono">${fmtDeg(h.lat, 'lat', state.fmt)}, ${fmtDeg(h.lon, 'lon', state.fmt)}</div>
      ${h.type === 'steep_slope' ? `<div>${MODE_NAME[state.mode]}: <b style="color:${COLORS[lvl]}">${LEVEL_TEXT[lvl]}</b> by p95 · steepest spot ${(+h.p.value).toFixed(1)}°</div>` : ''}
      <div class="muted">${tagsHTML(hzTags(h))}</div>`;
  }
  const f = sel.item;
  return `<b>Risk ${String(f.n).padStart(2, '0')} — ${esc(FLAG_TITLES[f.type](f))}</b>
    <div class="mono">${fmtDeg(f.lat, 'lat', state.fmt)}, ${fmtDeg(f.lon, 'lon', state.fmt)}</div>
    <div class="muted">${f.type === 'steep_slope' ? `${LEVEL_TEXT[f.level]} · ${f.camera} set ${f.set_id} · ${f.baseline_m} m baseline · at ${fmtDist(f.d)}` : `at ${fmtDist(f.d)}`}</div>`;
}
function placePop() {
  const el = $('pop'), sel = state.selected;
  if (!sel) { el.classList.remove('show'); return; }
  const [x, y] = map.toScreen(sel.item.lon, sel.item.lat);
  if (x < BAND_LEFT || y < BAND_TOP || x > map.w || y > map.h) { el.classList.remove('show'); return; }
  el.classList.add('show');
  const w = el.offsetWidth, h = el.offsetHeight;
  let px = x + 26, py = y - h - 14;
  if (px + w > map.w - 64) px = x - w - 26;
  if (py < BAND_TOP + 4) py = y + 22;
  el.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px)`;
}
function showPop() {
  const sel = state.selected; if (!sel) { $('pop').classList.remove('show'); return; }
  $('popBody').innerHTML = popContent(sel);
  placePop();
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------
function selectFlag(f, fly) {
  if (!f) return;
  if (f.n > 30) state.showAllFlags = true;
  state.selected = { kind: 'flag', item: f };
  if (fly) map.flyTo(f.lon, f.lat, Math.min(map.res, 0.0006));
  renderRisk(); map.render(); showPop();
  document.querySelector(`[data-flag="${f.n}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function selectHz(h, fly) {
  if (!h) return;
  state.selected = { kind: 'hz', item: h };
  if (fly) map.flyTo(h.lon, h.lat, Math.min(map.res, 0.0006));
  renderRisk(); map.render(); showPop();
  document.querySelector(`[data-hzn="${h.n}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function clearSelection() { state.selected = null; showPop(); }

// ---------------------------------------------------------------------------
// Route planning and assessment
// ---------------------------------------------------------------------------
function setEditing(on) {
  state.route.editing = on;
  $('btnRoute').classList.toggle('active', on);
  $('mapwrap').classList.toggle('routing', on);
  $('hint').classList.toggle('show', on);
  map.dblZoom = !on;
  if (on) { state.analysisKind = 'route'; state.analysis = null; state.nearSet = null; state.route.suggested = null; state.route.choice = null; state.route.suggestError = null; clearSelection(); computeOverview(); }
  renderRisk(); map.render();
}
function finishRoute() {
  const pts = state.route.pts;
  // drop duplicate points created by the double-click
  state.route.pts = pts.filter((p, i) => i === 0 || distance(p, pts[i - 1]) > map.res * M_PER_DEG * 3);
  setEditing(false);
  if (state.route.pts.length > 1) runAnalysis(); else { state.route.pts = []; renderRisk(); }
}
function clearRoute() {
  analysisSeq++;
  state.route.pts = []; state.analysis = null; state.analyzing = false; state.analysisKind = 'route'; state.nearSet = null;
  state.route.suggested = null; state.route.choice = null; state.route.suggestError = null;
  clearSelection(); setEditing(false); computeOverview(); renderLayers();
}

/** Plan the lowest-risk route through the user's own points, compare it with theirs, and show it. */
async function runSuggest() {
  if (!state.R) return;
  const user = state.route.choice?.userPts || state.route.pts.slice();
  if (user.length < 2) return;
  const seq = ++analysisSeq;
  state.analysis = null; state.nearSet = null; state.route.suggestError = null; clearSelection();
  state.analyzing = 'Planning the lowest-risk route…';
  renderRisk(); map.render();
  let res = null, userSum = null;
  try {
    userSum = summarize(await analyzeRoute(state.R, user, state.mode));
    res = await lowestRiskRoute(state.R, user, state.mode, (m) => { if (seq === analysisSeq) { state.analyzing = m; updateAnalyzing(); } });
  } catch (e) {
    if (seq !== analysisSeq) return;
    state.route.suggestError = e.message;
  }
  if (seq !== analysisSeq) return;
  if (res) {
    state.route.choice = { mode: state.mode, userPts: user, userSum, low: { pts: res.pts, info: res, sum: null } };
    state.route.pts = res.pts.slice(); state.route.suggested = { ...res, userPts: user };
  } else { state.route.pts = user; state.route.suggested = null; state.route.choice = null; }
  state.analyzing = false;
  return runAnalysis();
}
function backToUserRoute() {
  const ch = state.route.choice; if (!ch) return;
  state.route.pts = ch.userPts.slice(); state.route.suggested = null; state.route.suggestError = null;
  runAnalysis();
}
function showLowRoute() {
  const ch = state.route.choice; if (!ch?.low) return;
  state.route.pts = ch.low.pts.slice(); state.route.suggested = { ...ch.low.info, userPts: ch.userPts };
  runAnalysis();
}
function traverseParts(R) {
  const parts = [];
  for (const f of R.traverse?.features || []) eachRing(f.geometry, (r) => parts.push(r.map((c) => [c[0], c[1]])));
  return parts;
}
function assessTraverse() {
  if (!state.R?.traverse) return;
  $('modal').classList.remove('show');
  state.route.pts = []; setEditing(false);
  state.analysisKind = 'traverse';
  if (!state.layers.traverse) { state.layers.traverse = true; renderLayers(); applyVisibility(); }
  const bb = state.R.traverse.features.reduce((b, f) => { const g = bboxOfGeom(f.geometry); return [Math.min(b[0], g[0]), Math.min(b[1], g[1]), Math.max(b[2], g[2]), Math.max(b[3], g[3])]; }, [Infinity, Infinity, -Infinity, -Infinity]);
  map.fitBounds(bb, 60);
  runAnalysis();
}

let analysisSeq = 0;
async function runAnalysis() {
  if (!state.R) return;
  const kind = state.analysisKind;
  const input = kind === 'traverse' ? traverseParts(state.R) : state.route.pts;
  if (kind === 'route' && input.length < 2) { state.analysis = null; renderRisk(); return; }
  const seq = ++analysisSeq;
  state.analysis = null; state.nearSet = null; state.showAllFlags = false; clearSelection();
  state.analyzing = kind === 'traverse' ? 'Assessing the rover traverse…' : 'Assessing route…';
  renderRisk(); map.render();
  try {
    const A = await analyzeRoute(state.R, input, state.mode, (msg) => { if (seq === analysisSeq) { state.analyzing = msg; updateAnalyzing(); } },
      { walkback: kind !== 'traverse', flagLevels: kind === 'traverse' ? ['nogo'] : ['caution', 'nogo'] });
    if (seq !== analysisSeq) return;
    A.kind = kind;
    state.analysis = A;
    const ch = state.route.choice;
    if (kind === 'route' && ch && ch.mode === state.mode) { if (state.route.suggested) ch.low.sum = summarize(A); else ch.userSum = summarize(A); }
    computeNear(A);
    setTimeout(() => $('riskSection').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  } catch (e) {
    console.error(e); toast(`Route assessment failed: ${e.message}`);
  }
  if (seq !== analysisSeq) return;
  state.analyzing = false;
  computeOverview(); renderRisk(); map.render();
}
function updateAnalyzing() {
  const el = $('risk').querySelector('.empty');
  if (el && state.analyzing) el.textContent = state.analyzing; else renderRisk();
}

/** Mapped hazard points within ROUTE.hazardBuffer of the assessed path (grid hash of the samples). */
function computeNear(A) {
  const buf = ROUTE.hazardBuffer;
  const cy = buf / M_PER_DEG, cx = cy / Math.cos((A.samples[0]?.lat || 0) * Math.PI / 180);
  const hash = new Map();
  for (const s of A.samples) {
    const k = `${Math.floor(s.lon / cx)}_${Math.floor(s.lat / cy)}`;
    let a = hash.get(k); if (!a) hash.set(k, (a = [])); a.push(s);
  }
  const near = new Set();
  for (const h of state.hz) {
    if (h.type === 'crater_rim') continue; // crater rims are checked as crossings on the route itself
    const i = Math.floor(h.lon / cx), j = Math.floor(h.lat / cy);
    let hit = false;
    for (let a = -1; a <= 1 && !hit; a++) for (let b = -1; b <= 1 && !hit; b++) {
      for (const s of hash.get(`${i + a}_${j + b}`) || []) if (distance([h.lon, h.lat], [s.lon, s.lat]) < buf) { hit = true; break; }
    }
    if (hit) near.add(h);
  }
  state.nearSet = near;
}

function copyRoute() {
  const A = state.analysis, pts = state.route.pts; if (!A) return;
  const th = A.thresholds, f = (v, k) => fmtDeg(v, k, state.fmt);
  const T = A.totals, tot = Object.values(T).reduce((a, b) => a + b, 0) || 1, p = (k) => `${(100 * T[k] / tot).toFixed(1)}%`;
  const lines = [
    `SOLUS route — ${state.R.region.name} — ${MODE_NAME[state.mode]} mode (caution ≥ ${th.caution_deg}°, no-go ≥ ${th.nogo_deg}°, walk-back ${th.walkback_km} km)`,
    ...(state.route.suggested ? state.route.suggested.userPts : pts).map((q, i, arr) => `P-${i}  LAT ${f(q[1], 'lat')}  LON ${f(q[0], 'lon')}${i === 0 ? '  (START)' : i === arr.length - 1 ? '  (GOAL)' : ''}`),
    ...(state.route.suggested ? [`Lowest-risk route through these points (${pts.length} vertices): planned on MRO CTX DEM set ${[...new Set(state.route.suggested.legs.map((l) => l.set))].join(', ')} slope, checked with the most detailed data and re-planned ${state.route.suggested.passes} time(s); avoids no-go (≥ ${state.route.suggested.nogo}°) and no-data ground, uses caution ground only where no detour exists. The lowest risk the slope data can show, not a safety guarantee.`] : []),
    `Distance ${fmtDist(A.length)} · est. ${A.hours < 1 ? `${Math.round(A.hours * 60)} min` : `${A.hours.toFixed(1)} h`} at ${SPEEDS_KMH[state.mode]} km/h on level ground`,
    `Max slope ${A.maxSlope != null ? `${A.maxSlope.toFixed(1)}°` : '—'} · climb +${Math.round(A.gain)} m / descent −${Math.round(A.loss)} m (within one elevation model)`,
    `Within limits where data exists ${p('ok')} · caution ${p('caution')} · no-go ${p('nogo')} · no data ${p('unknown')} · not covered ${p('outside')}`,
    A.walkback.exceeded ? `Walk-back: route reaches ${fmtDist(A.walkback.max_m)} from start (limit ${th.walkback_km} km)` : `Farthest from start: ${fmtDist(A.walkback.max_m)} (limit ${th.walkback_km} km)`,
    `Assessed with: ${A.sources.join(', ') || '—'}`,
    'Flags:',
    ...A.flags.map((x) => `${String(x.n).padStart(2, '0')}  ${FLAG_TITLES[x.type](x)}  at ${fmtDist(x.d)}  (LAT ${f(x.lat, 'lat')}, LON ${f(x.lon, 'lon')})${x.dem ? `  ${x.dem}${x.baseline_m ? `, ${x.baseline_m} m baseline` : ''}` : ''}${x.suspect ? '  [suspect data]' : ''}`),
    'Not a safety verification: slope cannot show sand vs rock or rocks under ~1 m.',
    `SOLUS ${APP_VERSION} · terrain from NASA MRO HiRISE/CTX DEMs (Day et al. 2023) · not an operational safety tool.`,
  ];
  const text = lines.join('\n');
  const done = () => toast('Route copied to the clipboard');
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch { toast('Copy failed: select the text manually'); }
  ta.remove();
}

// drag route points (and insert new ones from the ⊕ handles)
map.dragHook = (x, y) => {
  if (!canEditRoute()) return null;
  const pts = state.route.pts;
  const i = pts.findIndex(([lon, lat]) => { const [px, py] = map.toScreen(lon, lat); return Math.hypot(px - x, py - y) < 10; });
  const m = i < 0 ? midHandles().find((h) => Math.hypot(h.x - x, h.y - y) < 9) : null;
  if (i < 0 && !m) return null;
  let idx = i, inserted = false;
  return {
    move(lon, lat) {
      if (state.route.choice || state.route.suggested) { state.route.suggested = null; state.route.choice = null; state.route.suggestError = null; }
      if (m && !inserted) { pts.splice(m.k, 0, [lon, lat]); idx = m.k; inserted = true; } else pts[idx] = [lon, lat];
      if (state.analysis) { analysisSeq++; state.analysis = null; state.nearSet = null; clearSelection(); }
      map.render();
    },
    end(moved) { if (moved) { computeOverview(); runAnalysis(); } },
  };
};

// ---------------------------------------------------------------------------
// Point inspection
// ---------------------------------------------------------------------------
async function inspectAt(lon, lat) {
  const insp = { lon, lat, sample: null };
  state.inspect = insp;
  const g = state.R?.geology?.features?.find((f) => pointInGeom([lon, lat], f.geometry));
  if (g) insp.unit = `${unitCode(g.properties || {})}${unitName(g.properties || {}) ? ` — ${unitName(g.properties)}` : ''}`;
  insp.near = state.hz.filter((h) => h.type === 'steep_slope' && distance([lon, lat], [h.lon, h.lat]) < 500).length;
  renderRisk(); map.render();
  if (state.R) {
    await prefetch(state.R, [{ lon, lat }]);
    if (state.inspect !== insp) return;
    insp.sample = sampleAt(state.R, lon, lat);
    if (insp.sample.status === 'ok') insp.suspect = await suspectNear(state.R, insp.sample.dem, lon, lat, 0).catch(() => false);
    if (state.inspect === insp) renderRisk();
  }
}
function pointInGeom(pt, geom) {
  if (!geom) return false;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  return polys.some((rings) => { let inside = false; rings.forEach((r) => { if (pir(pt, r)) inside = !inside; }); return inside; });
}
function pir([x, y], ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// ---------------------------------------------------------------------------
// Region switching
// ---------------------------------------------------------------------------
async function selectRegion(id, opts = {}) {
  if (!REGION_ORDER.includes(id)) id = 'jezero';
  analysisSeq++;
  state.region = id;
  state.route = { pts: [], editing: false }; state.analysis = null; state.analyzing = false; state.analysisKind = 'route';
  state.nearSet = null; state.inspect = null; clearSelection();
  setEditing(false);
  renderRegionTabs();
  $('loading').classList.remove('hide'); $('loading').textContent = 'Loading region…';
  const R = await loadRegion(id, (m) => { $('loading').textContent = m; });
  if (state.region !== id) return;
  state.R = R;
  prepareHazards(R);
  if (state.layers.waypoints && hasData('waypoints')) loadWaypoints(R).then(() => map.render());
  buildRegionLayers(R);
  renderRegionTabs(); renderLayers(); renderStatus();
  $('regionMission').textContent = missionOf(id);
  if (!opts.keepView) {
    const r = R.region, bb = r.focus_bbox || REGION_FALLBACK[id].focus_bbox;
    const m = r.default_view?.zoom_hint_m_per_px;
    if (r.default_view?.center && m) map.setView(r.default_view.center[0], r.default_view.center[1], m / M_PER_DEG / Math.cos(r.default_view.center[1] * Math.PI / 180));
    else map.fitBounds(bb);
  }
  $('loading').classList.add('hide');
  writeHash();
  computeOverview(); renderRisk();
  console.info(`SOLUS: ${id} loaded in ${R.loadMs} ms (${state.hz.length} hazard features)`);
}

function renderStatus() {
  const pills = [];
  if (!store.available) pills.push('<div class="pill warn-pill">Processed data not found: NASA imagery only</div>');
  else {
    pills.push(`<div class="pill"><b>NASA-derived terrain data</b> · contract ${esc(store.manifest.contract_version || '?')}</div>`);
    if (state.R?.region?._fallback) pills.push('<div class="pill warn-pill">region.json missing</div>');
  }
  if (state.imageryOffline) pills.push('<div class="pill warn-pill" title="NASA Mars Trek tiles could not be loaded">Imagery offline: showing shaded relief</div>');
  const notes = state.R?.region?.notes || [];
  if (notes.length) pills.push(`<button class="pill" data-open="limits" title="${esc(notes.join('\n'))}">ⓘ ${notes.length} region note${notes.length > 1 ? 's' : ''}</button>`);
  $('status').innerHTML = pills.join('');
  $('status').querySelectorAll('[data-open]').forEach((p) => { p.onclick = () => openModal('limits'); });
}

// imagery offline fallback: no Trek tile has loaded but several failed → shaded relief from the DEMs
setInterval(() => {
  const offline = tileStats.ok === 0 && tileStats.error >= 6;
  if (offline && !state.imageryOffline) {
    state.imageryOffline = true;
    if (!state.layers.hillshade) { state.layers.hillshade = true; renderLayers(); applyVisibility(); }
    renderStatus();
  } else if (!offline && state.imageryOffline && tileStats.ok > 0) { state.imageryOffline = false; renderStatus(); }
}, 2500);

// shareable starting view: #jezero, #gale/marswalk …
function writeHash() {
  const h = `#${state.region}${state.mode === 'marswalk' ? '/marswalk' : ''}`;
  if (location.hash !== h) history.replaceState(null, '', h);
}
function readHash() {
  const [r, m] = location.hash.replace(/^#/, '').split('/');
  return { region: REGION_ORDER.includes(r) ? r : null, mode: m === 'marswalk' ? 'marswalk' : m === 'rover' ? 'rover' : null };
}

// ---------------------------------------------------------------------------
// Bottom bar
// ---------------------------------------------------------------------------
function updateScale() {
  const mpp = map.metresPerPx(M_PER_DEG);
  const maxPx = 190, target = mpp * maxPx;
  const pow = 10 ** Math.floor(Math.log10(target));
  const nice = [5, 2, 1].map((k) => k * pow).find((v) => v <= target) || pow;
  $('sbLine').style.width = `${nice / mpp}px`;
  $('scalebar').style.width = `${nice / mpp}px`;
  $('sbMid').textContent = fmtDist(nice / 2);
  $('sbEnd').textContent = fmtDist(nice);
}
let hoverTimer = 0;
function onHover(e) {
  $('roLat').textContent = fmtDeg(e.lat, 'lat', state.fmt);
  $('roLon').textContent = fmtDeg(e.lon, 'lon', state.fmt);
  if (state.route.editing) { state.cursor = [e.lon, e.lat]; map.render(); }
  // waypoint tilt tooltip
  const tip = $('tip');
  const wp = state.layers.waypoints ? waypointAt(e.x, e.y) : null;
  if (wp) {
    const p = wp.properties, lvl = levelFor(p.tilt, state.mode);
    tip.innerHTML = `<b>Sol ${p.sol}</b> · site ${p.site}, drive ${p.drive}<br>On-board tilt <b style="color:${COLORS[lvl]}">${p.tilt.toFixed(1)}°</b> · ${MODE_NAME[state.mode]}: ${LEVEL_TEXT[lvl]}`;
    tip.style.transform = `translate(${e.x + 14}px, ${e.y + 12}px)`; tip.classList.add('show');
  } else tip.classList.remove('show');
  if (!state.R) return;
  $('roTerrain').innerHTML = terrainText(sampleAt(state.R, e.lon, e.lat));
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(async () => {
    await prefetch(state.R, [{ lon: e.lon, lat: e.lat }]);
    $('roTerrain').innerHTML = terrainText(sampleAt(state.R, e.lon, e.lat));
  }, 100);
}
function terrainText(s) {
  if (s.status === 'ok') { const l = levelFor(s.slope, state.mode); return `<span style="color:${COLORS[l]}">${s.slope.toFixed(1)}°</span> · ${s.camera} ${s.baseline_m} m`; }
  if (s.status === 'loading') return '<span style="color:#5d6b80">…</span>';
  if (s.status === 'unknown') return '<span style="color:#8a93a3">no data</span>';
  return '<span style="color:#5d6b80">not covered</span>';
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------
async function openModal(kind) {
  const box = $('modalBox');
  let html = '<button class="close" id="mClose">Close</button>';
  const th = thresholds();
  if (kind === 'limits') {
    const L = limitations();
    const notes = state.R?.region?.notes || [];
    html += `<h2>Limitations</h2><p class="lead">What the data can and cannot tell a crew. SOLUS shows these openly rather than hiding them.</p>
      ${L.length ? `<ol>${L.map((l) => `<li>${esc(l)}</li>`).join('')}</ol>` : '<p class="muted">Limitations list not loaded (manifest.json missing).</p>'}
      ${notes.length ? `<h3>Notes for ${esc(state.R.region.name)}</h3><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}`;
  } else if (kind === 'thresholds') {
    const sf = th.sources_full || {};
    const srcList = (ids) => (ids || []).map((id) => `<li><b>${esc(id)}</b> — ${esc(typeof sf[id] === 'string' ? sf[id] : JSON.stringify(sf[id] ?? ''))}</li>`).join('');
    html += `<h2>Danger thresholds</h2><p class="lead">Status: ${esc(th.status || '')}. ${esc(th.slope_baseline_note || '')}</p>
      <table><tr><th>Mode</th><th>Caution from</th><th>No-go from</th><th>Walk-back limit</th><th>Evidence</th></tr>
      ${Object.entries(th.modes).map(([m, t]) => `<tr><td><b>${MODE_NAME[m] || m}</b></td><td>${t.caution_deg}°</td><td>${t.nogo_deg}°</td><td>${t.walkback_km} km</td><td>${(t.sources || []).map(esc).join(', ')}</td></tr>`).join('')}</table>
      <p class="callout"><b>No published slope limit exists for a crewed Mars rover or for suited walking on Mars.</b> Rover limits come from the Apollo Lunar Roving Vehicle and NASA's robotic Mars rovers; Marswalk limits from NASA's Artemis EVA suit requirement and Apollo experience on the Moon.</p>
      ${store.manifest?.thresholds?.level_rule ? `<p class="muted">Rule: ${esc(store.manifest.thresholds.level_rule)}.</p>` : ''}
      ${Object.entries(th.modes).map(([m, t]) => (t.sources?.length && Object.keys(sf).length ? `<h3>${MODE_NAME[m] || m} evidence</h3><ul class="src">${srcList(t.sources)}</ul>` : '')).join('')}
      <h3>Severity scale (1–6)</h3><table><tr><th>Severity</th><th>Slope</th></tr>${severityClasses().map((c) => `<tr><td>${c.severity}</td><td>${c.min_deg}°${c.max_deg == null ? ' and steeper' : ` – ${c.max_deg}°`}</td></tr>`).join('')}</table>
      <p class="muted">Mapped 1 km-square points are coloured by the 95th-percentile slope in the square; the steepest single spot is shown in the detail text.</p>
      <h3>Travel-time estimate</h3><p class="muted">Rover ${SPEEDS_KMH.rover} km/h (NASA Space Exploration Vehicle concept, FS-2011-08-045-JSC); walking ${SPEEDS_KMH.marswalk} km/h on relatively level regolith (NASA EVA-EXP-0075, 2020). Neither accounts for slope or obstacles.</p>`;
  } else if (kind === 'validation') {
    box.innerHTML = `${html}<p class="muted">Loading validation data…</p>`;
    $('modal').classList.add('show');
    $('mClose').onclick = closeModal;
    const V = await loadAllValidation();
    html += validationHTML(V, esc);
  } else if (kind === 'about') {
    html += `<h2>About SOLUS</h2><p class="lead">A 2D scientific map for planning crewed-rover drives and Marswalks in three NASA landing-site regions. Every warning traces back to a named NASA elevation model, its resolution and an explicit slope calculation.</p>
      <ol class="steps">
        <li><b>Pick a region and a mission mode.</b> Jezero, Gale or West Candor; Rover (caution ≥ 15°, no-go ≥ 25°) or Marswalk (caution ≥ 15°, no-go ≥ 20°).</li>
        <li><b>Read the map.</b> Numbered triangles are 1 km squares coloured by their typical (95th-percentile) slope. Click one for its evidence. Grey areas have no elevation data: unknown, never assumed safe.</li>
        <li><b>Plan a route.</b> Use the route tool (top right), click points, double-click to finish. SOLUS samples the slope every few metres, numbers each steep stretch, data gap and crater rim, and shows the profile and the walk-back distance.</li>
      </ol>
      <p class="callout">SOLUS never calls a route safe. Slope cannot show loose sand or rocks smaller than about 1 m, and no published slope limit exists for crewed vehicles or suited walking on Mars.</p>
      <p><button class="btn" id="aboutGo">Start exploring</button> <a class="lnk" data-open-modal="validation">How well does it match real rovers?</a></p>
      <p class="muted">SOLUS ${APP_VERSION} · team SOLUS · NASA Space Apps Challenge 2026 · Madinah. Terrain derived from NASA data; not an operational safety tool.</p>`;
  } else if (kind === 'sources') {
    const C = citations();
    html += `<h2>Data sources</h2><p class="lead">All terrain data comes from NASA missions, archived in the NASA Planetary Data System or published by USGS for NASA.</p>
      ${C.length ? `<ul>${C.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : '<p class="muted">Citation list not loaded (manifest.json missing).</p>'}
      <h3>Basemap imagery (display only)</h3><ul>
        <li>NASA/JPL-Caltech Mars Trek (trek.nasa.gov): MRO HiRISE and CTX mosaics per region.</li>
        <li>NASA Viking Orbiter colour mosaic (USGS MDIM 2.1, 232 m) via Mars Trek: global base, and the optional colour tint of the grey HiRISE/CTX mosaics.</li></ul>
      <h3>Threshold evidence</h3><p class="muted">Apollo LRV performance (Apollo 15/16/17 mission reports via the NASA Apollo Lunar Surface Journal; NTRS 20250011301); MSL Landing Site Selection User's Guide to Engineering Constraints (2006); Rankin et al., Driving Curiosity (IEEE Aerospace 2020); NASA Exploration EVA System ConOps EVA-EXP-0075 (2020); NASA SEV fact sheet FS-2011-08-045-JSC. Full list in reports/THRESHOLDS_RESEARCH.md.</p>
      <p class="muted">SOLUS ${APP_VERSION} · NASA Space Apps Challenge 2026 · Madinah · Terrain derived from NASA data; not an operational safety tool.</p>`;
  }
  box.innerHTML = html;
  $('modal').classList.add('show');
  $('mClose').onclick = closeModal;
  const go = $('aboutGo'); if (go) go.onclick = closeModal;
  box.querySelectorAll('[data-open-modal]').forEach((a) => { a.onclick = () => openModal(a.dataset.openModal); });
  box.querySelectorAll('[data-run-traverse]').forEach((b) => {
    if (!state.R?.traverse) { b.disabled = true; b.textContent += ' (switch to Jezero or Gale)'; }
    b.onclick = () => { closeModal(); assessTraverse(); };
  });
}
const closeModal = () => $('modal').classList.remove('show');
$('modal').onclick = (e) => { if (e.target === $('modal')) closeModal(); };

let toastTimer = 0;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3500); }

// ---------------------------------------------------------------------------
// Wire-up
// ---------------------------------------------------------------------------
let moveTimer = 0;
map.on('move', () => { updateScale(); placePop(); clearTimeout(moveTimer); moveTimer = setTimeout(() => { computeOverview(); map.render(); }, 120); });
map.on('hover', onHover);
map.on('leave', () => { $('roLat').textContent = '—'; $('roLon').textContent = '—'; $('roTerrain').textContent = '—'; $('tip').classList.remove('show'); });
map.on('click', (e) => {
  if (state.route.editing) { state.route.pts.push([e.lon, e.lat]); renderRisk(); map.render(); return; }
  if (e.hit?.layer === routeLayer) return selectFlag(e.hit.feature, false);
  if (e.hit?.layer === hazardLayer) {
    const h = e.hit.feature;
    if (h.cluster) { map.flyTo(...map.toWorld(h.x, h.y), map.res / 3, 400); return; }
    if (!h.n && !routeMode()) {
      // bring the clicked point into the numbered list
      for (const x of state.overview) x.n = 0;
      state.overview = [h, ...state.overview.filter((x) => x !== h)].slice(0, 25);
      state.overview.forEach((x, i) => { x.n = i + 1; });
    }
    return selectHz(h, false);
  }
  clearSelection();
  inspectAt(e.lon, e.lat);
});
map.on('dblclick', () => { if (state.route.editing) finishRoute(); });
map.on('contextmenu', (e) => {
  if (state.route.editing && state.route.pts.length) { state.route.pts.pop(); renderRisk(); map.render(); return; }
  if (canEditRoute()) {
    const i = state.route.pts.findIndex(([lon, lat]) => { const [px, py] = map.toScreen(lon, lat); return Math.hypot(px - e.x, py - e.y) < 10; });
    if (i >= 0 && state.route.pts.length > 2) { state.route.suggested = null; state.route.choice = null; state.route.suggestError = null; state.route.pts.splice(i, 1); runAnalysis(); }
  }
});
map.on('rendered', placePop);

$('btnRoute').onclick = () => {
  if (state.route.editing) return finishRoute();
  state.route.pts = []; state.inspect = null; setEditing(true);
};
$('btnUndo').onclick = () => {
  if (state.route.suggested && !state.route.editing) { backToUserRoute(); return; }
  if (!state.route.pts.length) return;
  state.route.pts.pop();
  if (!state.route.editing) { if (state.route.pts.length > 1) runAnalysis(); else clearRoute(); }
  renderRisk(); map.render();
};
$('btnClear').onclick = clearRoute;
$('btnZoomIn').onclick = () => map.zoomAt(2, map.w / 2, map.h / 2);
$('btnZoomOut').onclick = () => map.zoomAt(0.5, map.w / 2, map.h / 2);
$('btnFit').onclick = () => map.fitBounds(state.R?.region?.focus_bbox || REGION_FALLBACK[state.region].focus_bbox);
$('popClose').onclick = () => { clearSelection(); renderRisk(); map.render(); };

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (state.route.editing && e.key === 'Enter') finishRoute();
  else if (state.route.editing && e.key === 'Escape') { state.route.pts = []; setEditing(false); }
  else if (state.route.editing && e.key === 'Backspace') { e.preventDefault(); state.route.pts.pop(); renderRisk(); map.render(); }
  else if (e.key === 'Escape') { closeModal(); if (state.selected) { clearSelection(); renderRisk(); map.render(); } }
});

function setMode(mode) {
  state.mode = mode; state.route.suggestError = null;
  $('modeTabs').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x.dataset.mode === mode));
  renderModeNote(); renderLayers(); computeOverview(); map.render(); writeHash();
  if (state.route.choice && state.analysisKind === 'route' && !state.route.editing) {
    if (state.route.suggested) runSuggest();                         // re-plan for the new limits
    else { state.route.choice = null; runAnalysis(); }               // showing their own route: drop the old comparison
  }
  else if (state.analysis || (state.analysisKind === 'route' && state.route.pts.length > 1 && !state.route.editing)) runAnalysis();
  else renderRisk();
}
$('modeTabs').querySelectorAll('button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
$('fmtSel').onchange = (e) => { state.fmt = e.target.value; renderRisk(); showPop(); map.render(); };
$('searchInput').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const p = parseLatLon(e.target.value);
  if (!p) { toast('Enter coordinates as "LAT, LON", e.g. 18.44, 77.23'); return; }
  const [lon, lat] = p;
  const inside = (id) => { const b = store.regions[id]?.region?.search_bbox || REGION_FALLBACK[id].search_bbox || REGION_FALLBACK[id].focus_bbox; return lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3]; };
  const target = REGION_ORDER.find(inside);
  const go = () => { map.flyTo(lon, lat, Math.min(map.res, 0.0015)); inspectAt(lon, lat); };
  if (target && target !== state.region) selectRegion(target, { keepView: true }).then(go); else go();
  if (!target) toast('That point is outside the three SOLUS demo regions: imagery only.');
});
$('lnkLimits').onclick = () => openModal('limits');
$('lnkThresholds').onclick = () => openModal('thresholds');
$('lnkValidation').onclick = () => openModal('validation');
$('lnkSources').onclick = () => openModal('sources');
$('lnkAbout').onclick = () => openModal('about');
window.addEventListener('hashchange', () => {
  const h = readHash();
  if (h.mode && h.mode !== state.mode) setMode(h.mode);
  if (h.region && h.region !== state.region) selectRegion(h.region);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Navigation view (nav.html): rover tablet and wrist display for the route shown
// ---------------------------------------------------------------------------
async function shareRoute() {
  const payload = {
    region: state.region, mode: state.mode,
    pts: state.route.pts.map(([lon, lat]) => [+lon.toFixed(6), +lat.toFixed(6)]),
    label: state.route.suggested ? 'lowest-risk route' : 'your route',
  };
  try {
    const r = await fetch('/api/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (r.ok) return { id: (await r.json()).id, payload };
  } catch { /* plain static server: fall back to a long link */ }
  return { id: null, payload };
}
/** A short link that works on any web host: the user's points; the phone re-plans the lowest-risk route itself. */
function compactLink(view) {
  const low = !!state.route.suggested;
  const pts = (low ? state.route.choice.userPts : state.route.pts).map(([a, b]) => `${a.toFixed(5)},${b.toFixed(5)}`).join(';');
  const r = { jezero: 'j', gale: 'g', west_candor: 'w' }[state.region];
  return new URL(`nav.html?view=${view}#c=${r}~${state.mode === 'marswalk' ? 'm' : 'r'}~${low ? 'l' : 'u'}~${pts}`, location.href).href;
}
async function openNav(view) {
  const { id, payload } = await shareRoute();
  const url = id ? `/${view === 'wrist' ? 'w' : 't'}/${id}` : compactLink(view);
  state.navShare = { id, view, label: payload.label, phone: compactLink('wrist') };
  window.open(url, '_blank');
  renderRisk();
}
function navInfo() {
  const n = state.navShare; if (!n) return '';
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (!local) {
    return `<div class="navinfo">Wrist display on a phone: copy this link, send it to your phone, open it and turn the phone sideways.
      <div class="linkrow"><input readonly value="${esc(n.phone)}"><button class="btn" data-copy-nav>Copy</button></div></div>`;
  }
  if (!n.id) return '';
  return state.lanUrl
    ? `<div class="navinfo">On a phone on the same Wi-Fi, open <b class="mono">${esc(state.lanUrl.replace(/^https?:\/\//, ''))}w/${esc(n.id)}</b> and turn it sideways for the wrist display (${esc(n.label)}).</div>`
    : `<div class="navinfo">To use a phone as the wrist display, start SOLUS with <b>start_lan.bat</b> instead of start.bat, then press Navigate again for a short phone link.</div>`;
}
fetch('/lan.json').then((r) => (r.ok ? r.json() : null)).then((j) => { state.lanUrl = j?.url || null; }).catch(() => {});

(async function start() {
  $('ver').textContent = APP_VERSION;
  rebuildLayers();
  const h = readHash();
  if (h.mode) { state.mode = h.mode; $('modeTabs').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x.dataset.mode === h.mode)); }
  map.fitBounds(REGION_FALLBACK[h.region || 'jezero'].focus_bbox);
  await loadManifest();
  renderModeNote();
  await selectRegion(h.region || state.region);
  try { if (!localStorage.getItem('solus_about_seen')) { localStorage.setItem('solus_about_seen', '1'); openModal('about'); } } catch { /* storage blocked */ }
  window.SOLUS = { state, map, store, sampleAt, prefetch }; // handy for debugging and tests
})();
