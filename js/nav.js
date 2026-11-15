// SOLUS — navigation view for a planned route: rover tablet (full) and wrist display (phone, landscape).
// The route is checked with the same NASA-derived data and rules as the main app (analyzeRoute).
// There is no GPS on Mars: the position is a SIMULATED playback along the planned route.

import { MapView, TrekTileLayer, FnLayer } from './mapview.js';
import { TREK, GLOBAL_LAYERS, REGION_IMAGERY, SPEEDS_KMH } from './config.js';
import { loadManifest, loadRegion, thresholds } from './data.js';
import { analyzeRoute, FLAG_TITLES } from './route.js';
import { lowestRiskRoute } from './suggest.js';
import { M_PER_DEG, distance, fmtDist } from './geo.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const COL = { ok: '#46b98a', caution: '#f0a43a', nogo: '#e5484d', unknown: '#8a93a3', outside: '#3b4658', crater: '#c9a0ff', cyan: '#6cc4ee' };
const LEVEL_TEXT = { ok: 'within limits', caution: 'caution', nogo: 'no-go', unknown: 'no data', outside: 'not covered' };
const RAD = Math.PI / 180;
const SPEEDS = [1, 10, 60, 300];

const search = new URLSearchParams(location.search), hash = new URLSearchParams(location.hash.slice(1));
const st = {
  view: search.get('view') || (Math.min(innerWidth, innerHeight) < 520 ? 'wrist' : 'tablet'),
  playing: false, mult: 60, d: 0, heading: 0, headingUp: true, alerted: new Set(), last: 0,
};
const app = $('app');
const msg = (html) => { $('msg').innerHTML = html; $('msg').classList.toggle('show', !!html); };

// ---------------------------------------------------------------------------
// Route input: #id=1234 (shared through the local server) or #route=<JSON>
// ---------------------------------------------------------------------------
async function readRoute() {
  if (hash.get('id')) {
    const r = await fetch(`/api/share/${encodeURIComponent(hash.get('id'))}`);
    if (!r.ok) throw new Error('This route link has expired (the SOLUS server was restarted). Send it again from the main app.');
    return r.json();
  }
  if (hash.get('c')) { // compact link that works on any web host: region~mode~kind~lon,lat;lon,lat…
    const [r, m, k, p = ''] = hash.get('c').split('~');
    const region = { j: 'jezero', g: 'gale', w: 'west_candor' }[r];
    const pts = p.split(';').map((q) => q.split(',').map(Number));
    if (!region || pts.length < 2 || pts.some((q) => q.length !== 2 || q.some((v) => !Number.isFinite(v)))) throw new Error('This route link is damaged. Copy it again from SOLUS.');
    return { region, mode: m === 'm' ? 'marswalk' : 'rover', pts, low: k === 'l', label: k === 'l' ? 'lowest-risk route' : 'your route' };
  }
  if (hash.get('route')) return JSON.parse(hash.get('route'));
  throw new Error('No route. In SOLUS, plan a route and press <b>Navigate</b>.');
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
const bearing = (a, b) => { const dx = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * RAD), dy = b[1] - a[1]; return (Math.atan2(dx, dy) / RAD + 360) % 360; };
const angDiff = (a, b) => ((b - a + 540) % 360) - 180; // signed, + = clockwise (right)

/** Douglas–Peucker in metres: the shape a driver would describe, for turn instructions. */
function simplify(pts, tol) {
  const lat0 = pts[0][1] * RAD, P = pts.map(([lon, lat]) => [lon * M_PER_DEG * Math.cos(lat0), lat * M_PER_DEG]);
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop(); if (j <= i + 1) continue;
    const [ax, ay] = P[i], [bx, by] = P[j], ux = bx - ax, uy = by - ay, ul = Math.hypot(ux, uy) || 1;
    let dm = -1, k = i + 1;
    for (let m = i + 1; m < j; m++) { const dd = Math.abs((P[m][0] - ax) * uy - (P[m][1] - ay) * ux) / ul; if (dd > dm) { dm = dd; k = m; } }
    if (dm > tol) { keep[k] = 1; stack.push([i, k], [k, j]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Turn instructions at the corners of the simplified route. */
function maneuvers(pts) {
  const S = simplify(pts, 30), out = [];
  let acc = 0;
  for (let i = 1; i < S.length - 1; i++) {
    acc += distance(S[i - 1], S[i]);
    const a = angDiff(bearing(S[i - 1], S[i]), bearing(S[i], S[i + 1]));
    const m = Math.abs(a);
    if (m < 25) continue;
    const side = a > 0 ? 'right' : 'left';
    out.push({ d: acc, angle: a, label: m < 50 ? `Bear ${side}` : m < 130 ? `Turn ${side}` : `Sharp ${side}` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------
function arrowSVG(angle, color) {
  const a = Math.max(-150, Math.min(150, angle)) * RAD, mx = 50, my = 54, L = 34;
  const ex = mx + L * Math.sin(a), ey = my - L * Math.cos(a);
  const h = 13, l1 = a + 2.6, l2 = a - 2.6;
  return `<svg viewBox="0 0 100 100" width="92" height="92"><path d="M50 94 L50 ${my} L${ex.toFixed(1)} ${ey.toFixed(1)}" fill="none" stroke="${color}" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M${(ex + h * Math.sin(a)).toFixed(1)} ${(ey - h * Math.cos(a)).toFixed(1)} L${(ex + h * Math.sin(l1)).toFixed(1)} ${(ey - h * Math.cos(l1)).toFixed(1)} L${(ex + h * Math.sin(l2)).toFixed(1)} ${(ey - h * Math.cos(l2)).toFixed(1)} Z" fill="${color}"/></svg>`;
}
const ICON = {
  warn: (c) => `<svg viewBox="0 0 100 100" width="92" height="92"><path d="M50 8 L94 88 H6 Z" fill="${c}" stroke="#fff" stroke-width="4" stroke-linejoin="round"/><rect x="45" y="34" width="10" height="30" rx="4" fill="#fff"/><circle cx="50" cy="75" r="6" fill="#fff"/></svg>`,
  stop: (c) => `<svg viewBox="0 0 100 100" width="92" height="92"><path d="M32 6 H68 L94 32 V68 L68 94 H32 L6 68 V32 Z" fill="${c}" stroke="#fff" stroke-width="4"/><rect x="24" y="44" width="52" height="12" rx="4" fill="#fff"/></svg>`,
  unknown: (c) => `<svg viewBox="0 0 100 100" width="92" height="92"><rect x="8" y="8" width="84" height="84" rx="12" fill="none" stroke="${c}" stroke-width="6" stroke-dasharray="10 8"/><path d="M36 38a14 14 0 1 1 20 13c-4 2-6 5-6 9v3" fill="none" stroke="${c}" stroke-width="8" stroke-linecap="round"/><circle cx="50" cy="76" r="5" fill="${c}"/></svg>`,
  crater: (c) => `<svg viewBox="0 0 100 100" width="92" height="92"><ellipse cx="50" cy="54" rx="42" ry="32" fill="none" stroke="${c}" stroke-width="7"/><ellipse cx="54" cy="58" rx="22" ry="14" fill="none" stroke="${c}" stroke-width="5"/></svg>`,
  goal: (c) => `<svg viewBox="0 0 100 100" width="92" height="92"><path d="M28 92 V10" stroke="#fff" stroke-width="7" stroke-linecap="round"/><path d="M30 12 H82 L70 30 L82 48 H30 Z" fill="${c}"/></svg>`,
};

// ---------------------------------------------------------------------------
// Load and check the route
// ---------------------------------------------------------------------------
let R, A, MAN, ROUTE, TOTAL;
try {
  msg('Loading route…');
  ROUTE = await readRoute();
  await loadManifest();
  R = await loadRegion(ROUTE.region);
  if (ROUTE.low) { // the lowest-risk route is re-planned here from the user's points, with the same data and method
    msg('Planning the lowest-risk route with NASA elevation data…');
    ROUTE.pts = (await lowestRiskRoute(R, ROUTE.pts, ROUTE.mode)).pts;
  }
  msg('Checking the route with NASA elevation data…');
  A = await analyzeRoute(R, ROUTE.pts, ROUTE.mode);
  MAN = maneuvers(ROUTE.pts);
  TOTAL = A.length;
  msg('');
} catch (e) {
  msg(`<div>${e.message}</div>`);
  throw e;
}
const TH = thresholds().modes[ROUTE.mode];
const SPEED = SPEEDS_KMH[ROUTE.mode] / 3.6; // m/s, real
document.title = `SOLUS Navigation · ${R.region.name}`;

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
const map = new MapView($('maprot'));
const trekUrl = TREK.url.bind(TREK);
const layers = [new TrekTileLayer(GLOBAL_LAYERS.viking, trekUrl)];
for (const def of REGION_IMAGERY[ROUTE.region] || []) layers.push(new TrekTileLayer(def, trekUrl));
layers.push(Object.assign(new TrekTileLayer(GLOBAL_LAYERS.viking, trekUrl, { opacity: 0.8 }), { composite: 'color' }));
layers.push(new FnLayer('route', drawRoute));
map.layers = layers; for (const l of layers) l.map = map;

function drawRoute(ctx) {
  const S = A.samples;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // casing
  ctx.lineWidth = 15; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.beginPath();
  S.forEach((s, i) => { const [x, y] = map.toScreen(s.lon, s.lat); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
  // coloured by class; the part already driven is dimmed
  ctx.lineWidth = 9;
  let run = null, prev = null;
  const flush = () => { if (run) { ctx.strokeStyle = run.c; ctx.stroke(); run = null; } };
  for (const s of S) {
    const p = map.toScreen(s.lon, s.lat), c = s.d < st.d ? 'rgba(150,160,175,.55)' : COL[s.level];
    if (prev) { if (!run || run.c !== c) { flush(); run = { c }; ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); } ctx.lineTo(p[0], p[1]); }
    prev = p;
  }
  flush();
  // flags ahead
  for (const f of A.flags) {
    if ((f.end_d ?? f.d) < st.d) continue;
    const [x, y] = map.toScreen(f.lon, f.lat), c = f.type === 'crater_rim' ? COL.crater : COL[f.level] || COL.caution;
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = '#fff'; ctx.stroke();
  }
  // goal
  const g = ROUTE.pts[ROUTE.pts.length - 1], [gx, gy] = map.toScreen(g[0], g[1]);
  ctx.beginPath(); ctx.arc(gx, gy, 11, 0, Math.PI * 2); ctx.fillStyle = '#0b1018'; ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = '#fff'; ctx.stroke();
  ctx.beginPath(); ctx.arc(gx, gy, 4, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
  // you are here: chevron, rotated so it points up once the map turns heading-up
  const p = posAt(st.d), [px, py] = map.toScreen(p.lon, p.lat);
  ctx.save(); ctx.translate(px, py); ctx.rotate(st.heading * RAD);
  ctx.beginPath(); ctx.arc(0, 0, 26, 0, Math.PI * 2); ctx.fillStyle = 'rgba(108,196,238,.18)'; ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(14, 14); ctx.lineTo(0, 6); ctx.lineTo(-14, 14); ctx.closePath();
  ctx.fillStyle = '#6cc4ee'; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
  ctx.restore();
}

function layout() {
  app.className = `nav ${st.view}`;
  const box = $('mapbox').getBoundingClientRect(), side = Math.ceil(Math.hypot(box.width, box.height)) + 4;
  const rot = $('maprot');
  rot.style.width = `${side}px`; rot.style.height = `${side}px`; rot.style.marginLeft = `${-side / 2}px`; rot.style.marginTop = `${-side / 2}px`;
  map._resize();
  const mpp = st.view === 'wrist' ? 3.2 : 2.4; // metres per screen pixel
  map.res = mpp / (M_PER_DEG * Math.cos(ROUTE.pts[0][1] * RAD));
  $('bView').textContent = st.view === 'wrist' ? '▭' : '⌚';
  $('bView').title = st.view === 'wrist' ? 'Rover tablet view' : 'Wrist view';
  const u = new URL(location.href); u.searchParams.set('view', st.view); history.replaceState(null, '', u);
  update(true);
}

// ---------------------------------------------------------------------------
// Position along the route
// ---------------------------------------------------------------------------
function idxAt(d) {
  const S = A.samples; let lo = 0, hi = S.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (S[m].d <= d) lo = m; else hi = m - 1; }
  return lo;
}
function posAt(d) {
  const S = A.samples, i = idxAt(d), a = S[i], b = S[Math.min(i + 1, S.length - 1)];
  const t = b.d > a.d ? Math.max(0, Math.min(1, (d - a.d) / (b.d - a.d))) : 0;
  return { lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t, s: a };
}

// ---------------------------------------------------------------------------
// What to tell the crew right now
// ---------------------------------------------------------------------------
function instruction() {
  const d = st.d, here = posAt(d).s;
  const left = TOTAL - d;
  if (left < 15) return { icon: ICON.goal(COL.ok), c: COL.ok, dist: '', main: 'Arrived at GOAL', sub: `${fmtDist(TOTAL)} driven` };
  const span = (f) => [f.start_d ?? f.d, f.end_d ?? f.d];
  const inside = A.flags.find((f) => f.type !== 'crater_rim' && span(f)[0] - 3 <= d && d <= span(f)[1] + 3);
  if (here.level === 'nogo' || inside?.level === 'nogo') {
    return { icon: ICON.stop(COL.nogo), c: COL.nogo, dist: here.slope != null ? `${here.slope.toFixed(0)}°` : '', main: 'No-go ground', sub: `At or above the ${TH.nogo_deg}° limit · stop and re-plan`, alert: true, key: `in-${inside?.n}` };
  }
  if (here.level === 'unknown' || here.level === 'outside') {
    return { icon: ICON.unknown(COL.unknown), c: COL.unknown, dist: '', main: here.level === 'unknown' ? 'No elevation data here' : 'Outside the mapped area', sub: 'Terrain unknown: not checked, not assumed safe' };
  }
  const next = A.flags.find((f) => span(f)[0] > d + 3);
  const nd = next ? span(next)[0] - d : Infinity;
  if (next && next.level === 'nogo' && nd < 400) {
    return { icon: ICON.warn(COL.nogo), c: COL.nogo, dist: fmtDist(nd), main: `No-go slope ahead: ${next.value.toFixed(0)}°`, sub: `${fmtDist(next.length_m)} stretch · ${next.camera} ${next.baseline_m} m data`, alert: nd < 150, key: `ahead-${next.n}` };
  }
  if (here.level === 'caution') {
    return { icon: ICON.warn(COL.caution), c: COL.caution, dist: `${here.slope.toFixed(0)}°`, main: 'Caution slope', sub: `Between ${TH.caution_deg}° and ${TH.nogo_deg}° · slow down` };
  }
  if (next && nd < 250) {
    if (next.type === 'crater_rim') return { icon: ICON.crater(COL.crater), c: COL.crater, dist: fmtDist(nd), main: 'Crater rim ahead', sub: `${next.diam_km.toFixed(1)} km crater (Robbins catalogue)` };
    if (next.type === 'data_gap' || next.type === 'no_coverage') return { icon: ICON.unknown(COL.unknown), c: COL.unknown, dist: fmtDist(nd), main: 'No-data stretch ahead', sub: `${fmtDist(next.length_m)} with no elevation data` };
    return { icon: ICON.warn(COL.caution), c: COL.caution, dist: fmtDist(nd), main: `Caution slope ahead: ${next.value.toFixed(0)}°`, sub: `${fmtDist(next.length_m)} stretch · ${next.camera} ${next.baseline_m} m data` };
  }
  const m = MAN.find((x) => x.d > d + 5), md = m ? m.d - d : Infinity;
  if (m && md < 600) {
    return { icon: arrowSVG(m.angle, COL.cyan), c: COL.cyan, dist: fmtDist(md), main: m.label, sub: next ? `then ${FLAG_TITLES[next.type](next).toLowerCase()} in ${fmtDist(nd)}` : `then ${fmtDist(left - md)} to GOAL` };
  }
  const until = Math.min(md, nd, left);
  return { icon: arrowSVG(0, COL.ok), c: COL.ok, dist: fmtDist(until), main: 'Continue on route', sub: next && nd < left ? `Next: ${FLAG_TITLES[next.type](next)}` : 'Next: GOAL' };
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------
const tm = (h) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${Math.floor(h)} h ${String(Math.round((h % 1) * 60)).padStart(2, '0')} min`);
let lastHero = '';
function update(force) {
  const d = st.d, P = posAt(d), s = P.s, left = TOTAL - d;
  const I = instruction();
  const heroKey = I.main + I.dist + I.sub + I.c;
  if (force || heroKey !== lastHero) {
    lastHero = heroKey;
    $('hero').style.setProperty('--hc', I.c);
    $('heroIco').innerHTML = I.icon; $('heroDist').textContent = I.dist; $('heroMain').textContent = I.main; $('heroSub').textContent = I.sub;
    $('hero').classList.toggle('alert', !!I.alert);
  }
  if (I.alert && I.key && !st.alerted.has(I.key)) { st.alerted.add(I.key); navigator.vibrate?.([220, 90, 220]); }

  const fromStart = distance(ROUTE.pts[0], [P.lon, P.lat]), wbLimit = TH.walkback_km * 1000, wbOver = fromStart > wbLimit;
  const slopeV = s.status === 'ok' ? `<span style="color:${COL[s.level]}">${s.slope.toFixed(1)}°</span>` : `<span style="color:${COL.unknown}">—</span>`;
  const slopeS = s.status === 'ok' ? `${LEVEL_TEXT[s.level]} · ${s.camera} ${s.baseline_m} m` : LEVEL_TEXT[s.level];
  const eta = tm(left / SPEED / 3600);
  if (st.view === 'wrist') {
    $('wstats').innerHTML = `
      <div class="wtile"><div class="k">Slope now</div><div class="v">${slopeV}</div><div class="s">${esc(slopeS)}</div></div>
      <div class="wtile"><div class="k">To goal</div><div class="v">${fmtDist(left)}</div><div class="s">${eta} at ${SPEEDS_KMH[ROUTE.mode]} km/h</div></div>
      <div class="wtile"><div class="k">Walk-back</div><div class="v" style="color:${wbOver ? COL.nogo : '#eef2f7'}">${fmtDist(fromStart)}</div><div class="s">limit ${TH.walkback_km} km</div></div>`;
  } else {
    $('tiles').innerHTML = `
      <div class="tile"><div class="k">Slope now</div><div class="v">${slopeV}</div><div class="s">${esc(slopeS)}</div></div>
      <div class="tile"><div class="k">Elevation</div><div class="v">${s.elev != null ? `${Math.round(s.elev)} m` : '—'}</div><div class="s">model height</div></div>
      <div class="tile"><div class="k">To goal</div><div class="v">${fmtDist(left)}</div><div class="s">${eta} at ${SPEEDS_KMH[ROUTE.mode]} km/h (level ground)</div></div>
      <div class="tile"><div class="k">Walk-back</div><div class="v" style="color:${wbOver ? COL.nogo : '#eef2f7'}">${fmtDist(fromStart)}</div><div class="s">${wbOver ? 'beyond' : 'of'} the ${TH.walkback_km} km limit</div></div>
      <div class="tile wide"><div class="k">${esc(R.region.name)} · ${ROUTE.mode === 'rover' ? 'Rover' : 'Marswalk'} limits · ${esc(ROUTE.label || 'planned route')}</div>
        <div class="s">Caution ≥ ${TH.caution_deg}° · no-go ≥ ${TH.nogo_deg}° · ${fmtDist(d)} of ${fmtDist(TOTAL)} driven · playback ${st.mult}×</div></div>`;
    const ahead = A.flags.filter((f) => (f.end_d ?? f.d) >= d).slice(0, 6);
    $('ahead').innerHTML = ahead.length ? ahead.map((f) => {
      const dd = Math.max(0, (f.start_d ?? f.d) - d), c = f.type === 'crater_rim' ? COL.crater : COL[f.level] || COL.caution;
      return `<div class="ahead-item" style="--c:${c}"><div class="d">${dd < 5 ? 'now' : fmtDist(dd)}</div><div class="t">${esc(FLAG_TITLES[f.type](f))}<small>${f.dem ? `${esc(f.camera)} set ${esc(f.set_id)} · ${f.baseline_m} m baseline` : f.type === 'crater_rim' ? 'Robbins & Hynek 2012' : ''}</small></div></div>`;
    }).join('') : '<div class="ahead-none">No flagged stretches left on this route.</div>';
    drawProfile();
  }
  $('scrub').value = Math.round((d / TOTAL) * 1000);
  $('bPlay').textContent = st.playing ? '❚❚' : '▶';
  $('bSpeed').textContent = `${st.mult}×`;
  $('bNorth').classList.toggle('on', st.headingUp);
  // follow the position, heading-up
  const ahead = posAt(Math.min(TOTAL, d + 30)), behind = posAt(Math.max(0, d - 30));
  const hdg = bearing([behind.lon, behind.lat], [ahead.lon, ahead.lat]);
  st.heading = force ? hdg : (st.heading + angDiff(st.heading, hdg) * 0.12 + 360) % 360;
  const rot = st.headingUp ? -st.heading : 0;
  $('maprot').style.transform = `rotate(${rot}deg)`;
  $('compass').style.transform = `rotate(${rot}deg)`;
  // centre the map ahead of the position, so it sits in the lower part of the screen like a car navigator
  const boxH = $('mapbox').clientHeight, mpp = map.res * M_PER_DEG * Math.cos(P.lat * RAD);
  const off = st.headingUp ? boxH * 0.22 * mpp : 0, h = st.heading * RAD;
  map.cLat = P.lat + (off * Math.cos(h)) / M_PER_DEG;
  map.cLon = P.lon + (off * Math.sin(h)) / (M_PER_DEG * Math.cos(P.lat * RAD));
  map.render();
}

function drawProfile() {
  const cv = $('profile'), ctx = cv.getContext('2d'), W = cv.width, H = cv.height, pl = 14, pr = 14, pt = 16, pb = 16;
  ctx.clearRect(0, 0, W, H);
  const S = A.samples.filter((s) => s.elev != null); if (S.length < 2) return;
  let e0 = Infinity, e1 = -Infinity; for (const s of S) { e0 = Math.min(e0, s.elev); e1 = Math.max(e1, s.elev); }
  const X = (d) => pl + (d / TOTAL) * (W - pl - pr), Y = (e) => H - pb - ((e - e0) / Math.max(1, e1 - e0)) * (H - pt - pb);
  ctx.lineWidth = 4;
  for (let i = 1; i < A.samples.length; i++) {
    const a = A.samples[i - 1], b = A.samples[i];
    if (a.elev == null || b.elev == null || a.dem !== b.dem) continue;
    ctx.strokeStyle = b.d < st.d ? 'rgba(150,160,175,.6)' : COL[b.level]; ctx.beginPath(); ctx.moveTo(X(a.d), Y(a.elev)); ctx.lineTo(X(b.d), Y(b.elev)); ctx.stroke();
  }
  ctx.fillStyle = '#6cc4ee'; ctx.fillRect(X(st.d) - 1.5, 4, 3, H - 8);
  ctx.fillStyle = '#95a3b8'; ctx.font = '600 20px Barlow, sans-serif';
  ctx.fillText(`${Math.round(e1)} m`, pl, 20); ctx.fillText(`${Math.round(e0)} m`, pl, H - 2);
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------
function frame(t) {
  const dt = st.last ? Math.min(0.25, (t - st.last) / 1000) : 0; st.last = t;
  if (st.playing) {
    st.d = Math.min(TOTAL, st.d + SPEED * st.mult * dt);
    if (st.d >= TOTAL) st.playing = false;
  }
  update(false);
  requestAnimationFrame(frame);
}
const toggle = () => { if (st.d >= TOTAL) st.d = 0; st.playing = !st.playing; };
$('bPlay').onclick = toggle;
$('bSpeed').onclick = () => { st.mult = SPEEDS[(SPEEDS.indexOf(st.mult) + 1) % SPEEDS.length]; };
$('bRestart').onclick = () => { st.d = 0; st.alerted.clear(); update(true); };
$('bNorth').onclick = () => { st.headingUp = !st.headingUp; };
$('bView').onclick = () => { st.view = st.view === 'wrist' ? 'tablet' : 'wrist'; layout(); };
$('scrub').oninput = (e) => { st.d = (e.target.value / 1000) * TOTAL; update(true); };
$('hero').onclick = () => { if (st.view === 'wrist') toggle(); };
$('mapbox').onclick = () => { if (st.view === 'wrist') toggle(); };
new ResizeObserver(() => layout()).observe(app);
document.addEventListener('keydown', (e) => { if (e.key === ' ') { e.preventDefault(); toggle(); } });

layout();
window.SOLUS_NAV = { st, A, R, ROUTE, MAN, instruction, update };
setTimeout(() => { st.playing = true; }, 1200);
requestAnimationFrame(frame);
