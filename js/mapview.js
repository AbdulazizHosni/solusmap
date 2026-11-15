// SOLUS — a small dependency-free map engine for Mars (plate carrée / equirectangular).
// World coordinates are [lon, lat] in degrees on the Mars 2000 sphere. The view stores a
// centre and a resolution in degrees per CSS pixel. Mars Trek EQ tiles use the same
// plate-carrée grid, so tiles and data share one coordinate system with no reprojection.

const TILE_DEG0 = 180; // degrees spanned by one tile at level 0

export class MapView {
  constructor(el) {
    this.el = el;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'map-canvas';
    el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.layers = [];
    this.cLon = 0; this.cLat = 0; this.res = 0.01;
    this.minRes = 180 / 256 / 2 ** 20;  // ~0.04 m/px
    this.maxRes = 180 / 256 / 2 ** 1;
    this.handlers = {};
    this._raf = 0;
    this._pointers = new Map();
    this._resize();
    new ResizeObserver(() => this._resize()).observe(el);
    this._bindEvents();
  }

  // ---------- events ----------
  on(name, fn) { (this.handlers[name] ||= []).push(fn); return this; }
  emit(name, e) { (this.handlers[name] || []).forEach((fn) => fn(e)); }

  // ---------- geometry ----------
  get zoom() { return Math.log2(TILE_DEG0 / 256 / this.res); }
  toScreen(lon, lat) { return [(lon - this.cLon) / this.res + this.w / 2, (this.cLat - lat) / this.res + this.h / 2]; }
  toWorld(x, y) { return [this.cLon + (x - this.w / 2) * this.res, this.cLat - (y - this.h / 2) * this.res]; }
  bounds() {
    const [a, b] = this.toWorld(0, this.h), [c, d] = this.toWorld(this.w, 0);
    return [a, b, c, d];
  }
  /** metres per CSS pixel along the parallel through the view centre */
  metresPerPx(mPerDeg) { return this.res * mPerDeg * Math.cos(this.cLat * Math.PI / 180); }

  setView(lon, lat, res) {
    if (res != null) this.res = Math.min(this.maxRes, Math.max(this.minRes, res));
    this.cLat = Math.max(-89.9, Math.min(89.9, lat));
    this.cLon = Math.max(-180, Math.min(180, lon));
    this.render();
    this.emit('move', this);
  }
  fitBounds(bb, pad = 40) {
    const [x0, y0, x1, y1] = bb;
    const rx = (x1 - x0) / Math.max(1, this.w - 2 * pad), ry = (y1 - y0) / Math.max(1, this.h - 2 * pad);
    this.setView((x0 + x1) / 2, (y0 + y1) / 2, Math.max(rx, ry));
  }
  zoomAt(factor, x, y) {
    const [lon, lat] = this.toWorld(x, y);
    const res = Math.min(this.maxRes, Math.max(this.minRes, this.res / factor));
    // keep the world point under the cursor fixed
    this.res = res;
    this.cLon = lon - (x - this.w / 2) * res;
    this.cLat = lat + (y - this.h / 2) * res;
    this.setView(this.cLon, this.cLat);
  }
  flyTo(lon, lat, res, ms = 600) {
    const s = { lon: this.cLon, lat: this.cLat, lr: Math.log(this.res) };
    const e = { lon, lat, lr: Math.log(res ?? this.res) };
    const t0 = performance.now();
    cancelAnimationFrame(this._fly);
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms), q = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      this.setView(s.lon + (e.lon - s.lon) * q, s.lat + (e.lat - s.lat) * q, Math.exp(s.lr + (e.lr - s.lr) * q));
      if (k < 1) this._fly = requestAnimationFrame(step);
    };
    this._fly = requestAnimationFrame(step);
  }

  // ---------- layers & rendering ----------
  add(layer) { this.layers.push(layer); layer.map = this; this.render(); return layer; }
  remove(layer) { this.layers = this.layers.filter((l) => l !== layer); this.render(); }
  clearLayers(pred) { this.layers = this.layers.filter((l) => !pred(l)); this.render(); }

  render() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
  }
  _draw() {
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0d1016';
    ctx.fillRect(0, 0, this.w, this.h);
    for (const l of this.layers) {
      if (l.visible === false) continue;
      ctx.save();
      ctx.globalAlpha = l.opacity ?? 1;
      ctx.globalCompositeOperation = l.composite || 'source-over';
      try { l.draw(ctx, this); } catch (err) { console.error('layer draw failed', l.name, err); }
      ctx.restore();
    }
    this.emit('rendered', this);
  }
  _resize() {
    const r = this.el.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    // layout size, not the on-screen box: unaffected by CSS rotation (navigation view)
    this.w = Math.max(1, this.el.clientWidth || r.width); this.h = Math.max(1, this.el.clientHeight || r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.render();
    this.emit('move', this);
  }

  /** Ask layers (top first) for a feature under the cursor. */
  hit(x, y) {
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const l = this.layers[i];
      if (l.visible === false || !l.hit) continue;
      const f = l.hit(x, y, this);
      if (f) return { layer: l, feature: f };
    }
    return null;
  }

  // ---------- interaction ----------
  _bindEvents() {
    const c = this.canvas;
    let drag = null, moved = false, pinch = null;
    const pos = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this._pointers.set(e.pointerId, pos(e));
      if (this._pointers.size === 1) {
        const p = pos(e);
        const custom = e.button === 0 && this.dragHook ? this.dragHook(p[0], p[1]) : null;
        drag = { p, lon: this.cLon, lat: this.cLat, custom }; moved = false;
      }
      if (this._pointers.size === 2) {
        const [a, b] = [...this._pointers.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), res: this.res };
        drag = null;
      }
    });
    c.addEventListener('pointermove', (e) => {
      const p = pos(e);
      if (this._pointers.has(e.pointerId)) this._pointers.set(e.pointerId, p);
      if (pinch && this._pointers.size === 2) {
        const [a, b] = [...this._pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        this.zoomAt(this.res / (pinch.res * pinch.d / d), mx, my);
        moved = true;
        return;
      }
      if (drag) {
        const dx = p[0] - drag.p[0], dy = p[1] - drag.p[1];
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        if (moved && drag.custom) { const w = this.toWorld(p[0], p[1]); drag.custom.move(w[0], w[1]); }
        else if (moved) { c.classList.add('dragging'); this.setView(drag.lon - dx * this.res, drag.lat + dy * this.res); }
      }
      const w = this.toWorld(p[0], p[1]);
      this.emit('hover', { lon: w[0], lat: w[1], x: p[0], y: p[1] });
    });
    const end = (e) => {
      const p = pos(e);
      const wasDrag = moved;
      this._pointers.delete(e.pointerId);
      if (this._pointers.size < 2) pinch = null;
      if (drag?.custom) drag.custom.end(wasDrag);
      if (drag && !wasDrag && e.type === 'pointerup' && e.button === 0) {
        const w = this.toWorld(p[0], p[1]);
        this.emit('click', { lon: w[0], lat: w[1], x: p[0], y: p[1], hit: this.hit(p[0], p[1]), shift: e.shiftKey });
      }
      drag = null; c.classList.remove('dragging');
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => this.emit('leave'));
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = pos(e);
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
      this.zoomAt(f, p[0], p[1]);
    }, { passive: false });
    c.addEventListener('dblclick', (e) => {
      const p = pos(e);
      if (this.dblZoom === false) { const w = this.toWorld(p[0], p[1]); this.emit('dblclick', { lon: w[0], lat: w[1], x: p[0], y: p[1] }); return; }
      this.zoomAt(2, p[0], p[1]);
    });
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const p = pos(e), w = this.toWorld(p[0], p[1]);
      this.emit('contextmenu', { lon: w[0], lat: w[1], x: p[0], y: p[1] });
    });
    c.tabIndex = 0;
    c.addEventListener('keydown', (e) => {
      const step = 80 * this.res;
      if (e.key === '+' || e.key === '=') this.zoomAt(1.5, this.w / 2, this.h / 2);
      else if (e.key === '-') this.zoomAt(1 / 1.5, this.w / 2, this.h / 2);
      else if (e.key === 'ArrowLeft') this.setView(this.cLon - step, this.cLat);
      else if (e.key === 'ArrowRight') this.setView(this.cLon + step, this.cLat);
      else if (e.key === 'ArrowUp') this.setView(this.cLon, this.cLat + step);
      else if (e.key === 'ArrowDown') this.setView(this.cLon, this.cLat - step);
      else return;
      e.preventDefault();
    });
  }
}

// ---------------------------------------------------------------------------
// Tile layer for Mars Trek WMTS (EQ, default028mm)
// ---------------------------------------------------------------------------
const tileCache = new Map(); // url -> {img, state}
const CACHE_MAX = 700;
export const tileStats = { ok: 0, error: 0, loading: 0 }; // loading: tiles requested and not yet answered

function getTile(url, onload) {
  let t = tileCache.get(url);
  if (t && t.state === 'error' && performance.now() - t.at > 30000) t = null; // retry failed tiles after 30 s
  if (t) { tileCache.delete(url); tileCache.set(url, t); return t; } // LRU touch
  const img = new Image();
  t = { img, state: 'loading', at: performance.now() };
  img.decoding = 'async';
  tileStats.loading++;
  img.onload = () => { t.state = 'ok'; tileStats.ok++; tileStats.loading--; onload(); };
  img.onerror = () => { t.state = 'error'; tileStats.error++; tileStats.loading--; onload(); };
  img.src = url;
  tileCache.set(url, t);
  if (tileCache.size > CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
  return t;
}

export class TrekTileLayer {
  constructor(def, urlFn, opts = {}) {
    Object.assign(this, { def, urlFn, name: def.label, opacity: opts.opacity ?? 1, visible: opts.visible ?? true, kind: 'tiles' });
    this.errors = 0; this.loaded = 0;
  }
  draw(ctx, map) {
    const d = this.def;
    const [vx0, vy0, vx1, vy1] = map.bounds();
    const x0 = Math.max(vx0, d.bbox[0]), x1 = Math.min(vx1, d.bbox[2]);
    const y0 = Math.max(vy0, d.bbox[1]), y1 = Math.min(vy1, d.bbox[3]);
    if (x0 >= x1 || y0 >= y1) return;
    // pick the level whose pixels are closest to screen pixels (accounting for tile size and DPR)
    const zWanted = Math.log2(TILE_DEG0 / d.tile / (map.res / map.dpr));
    const z = Math.max(0, Math.min(d.maxZoom, Math.round(zWanted - 0.25)));
    const span = TILE_DEG0 / 2 ** z;
    const c0 = Math.floor((x0 + 180) / span), c1 = Math.floor((x1 + 180 - 1e-9) / span);
    const r0 = Math.floor((90 - y1) / span), r1 = Math.floor((90 - y0 - 1e-9) / span);
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > 600) return; // safety
    const redraw = () => map.render();
    ctx.imageSmoothingEnabled = true;
    // clip to the layer's extent so neighbouring blank tiles don't cover other layers
    const [cx0, cy0] = map.toScreen(d.bbox[0], d.bbox[3]);
    const [cx1, cy1] = map.toScreen(d.bbox[2], d.bbox[1]);
    ctx.beginPath(); ctx.rect(cx0, cy0, cx1 - cx0, cy1 - cy0); ctx.clip();
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const lon = col * span - 180, lat = 90 - row * span;
        const [sx, sy] = map.toScreen(lon, lat);
        const size = span / map.res;
        const t = getTile(this.urlFn(d, z, row, col), redraw);
        if (t.state === 'ok') { ctx.drawImage(t.img, sx, sy, size + 0.5, size + 0.5); continue; }
        // fallback: draw a cached ancestor tile, cropped
        for (let k = 1; k <= 6 && z - k >= 0; k++) {
          const az = z - k, ac = col >> k, ar = row >> k;
          const at = tileCache.get(this.urlFn(d, az, ar, ac));
          if (at && at.state === 'ok') {
            const sub = at.img.naturalWidth / 2 ** k;
            ctx.drawImage(at.img, (col - (ac << k)) * sub, (row - (ar << k)) * sub, sub, sub, sx, sy, size + 0.5, size + 0.5);
            break;
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// A georeferenced image (processed overlays: slope, unknown, suspect, hillshade)
// ---------------------------------------------------------------------------
export class ImageOverlay {
  constructor(url, bounds, opts = {}) {
    Object.assign(this, { url, bounds, opacity: opts.opacity ?? 1, visible: opts.visible ?? true, name: opts.name || url, kind: 'image', smooth: opts.smooth ?? false });
    this.state = 'idle';
  }
  draw(ctx, map) {
    const [x0, y0, x1, y1] = this.bounds;
    const [vx0, vy0, vx1, vy1] = map.bounds();
    if (x1 < vx0 || x0 > vx1 || y1 < vy0 || y0 > vy1) return;
    if (this.state === 'idle') {
      this.state = 'loading';
      this.img = new Image();
      this.img.onload = () => { this.state = 'ok'; map.render(); };
      this.img.onerror = () => { this.state = 'error'; console.warn('overlay failed', this.url); };
      this.img.src = this.url;
    }
    if (this.state !== 'ok') return;
    const [sx0, sy0] = map.toScreen(x0, y1), [sx1, sy1] = map.toScreen(x1, y0);
    ctx.imageSmoothingEnabled = this.smooth;
    ctx.drawImage(this.img, sx0, sy0, sx1 - sx0, sy1 - sy0);
  }
}

// ---------------------------------------------------------------------------
// A layer drawn by a function (vectors, graticule, markers)
// ---------------------------------------------------------------------------
export class FnLayer {
  constructor(name, draw, opts = {}) {
    Object.assign(this, { name, drawFn: draw, hitFn: opts.hit, visible: opts.visible ?? true, opacity: opts.opacity ?? 1, kind: opts.kind || 'vector' });
  }
  draw(ctx, map) { this.drawFn(ctx, map); }
  hit(x, y, map) { return this.hitFn ? this.hitFn(x, y, map) : null; }
}
