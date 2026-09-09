// Google Maps JS API stand-in for the perf probe. Enough of the surface the dispatch map
// touches (Map, Marker, Polyline, OverlayView, LatLng(Bounds), Size, Point, event) to let
// the REAL app code run its marker/polyline effects against real DOM nodes. It is deliberately
// cheaper than Google's renderer, so every number it produces is a LOWER bound on the cost of
// our own code — React reconciliation, icon generation, effect churn — which is the part we own.
(function () {
  const g = (window.google = window.google || {});
  const m = (g.maps = g.maps || {});
  const W = 1200, H = 800;
  const proj = (map, p) => {
    const lat = typeof p.lat === 'function' ? p.lat() : p.lat;
    const lng = typeof p.lng === 'function' ? p.lng() : p.lng;
    const c = map._center; const z = map._zoom || 9;
    const s = Math.pow(2, z) * 256 / 360;
    return { x: W / 2 + (lng - c.lng) * s, y: H / 2 - (lat - c.lat) * s };
  };
  class LatLng { constructor(lat, lng) { this._lat = Number(lat); this._lng = Number(lng); } lat() { return this._lat; } lng() { return this._lng; } toJSON() { return { lat: this._lat, lng: this._lng }; } equals(o) { return o && o.lat() === this._lat && o.lng() === this._lng; } }
  const toLL = (p) => (p instanceof LatLng ? p : new LatLng(typeof p.lat === 'function' ? p.lat() : p.lat, typeof p.lng === 'function' ? p.lng() : p.lng));
  class LatLngBounds {
    constructor(sw, ne) { this._sw = sw ? toLL(sw) : null; this._ne = ne ? toLL(ne) : null; }
    extend(p) { const q = toLL(p); if (!this._sw) { this._sw = new LatLng(q.lat(), q.lng()); this._ne = new LatLng(q.lat(), q.lng()); return this; }
      this._sw = new LatLng(Math.min(this._sw.lat(), q.lat()), Math.min(this._sw.lng(), q.lng()));
      this._ne = new LatLng(Math.max(this._ne.lat(), q.lat()), Math.max(this._ne.lng(), q.lng())); return this; }
    contains(p) { if (!this._sw) return false; const q = toLL(p); return q.lat() >= this._sw.lat() && q.lat() <= this._ne.lat() && q.lng() >= this._sw.lng() && q.lng() <= this._ne.lng(); }
    isEmpty() { return !this._sw; } getSouthWest() { return this._sw; } getNorthEast() { return this._ne; }
    getCenter() { return this._sw ? new LatLng((this._sw.lat() + this._ne.lat()) / 2, (this._sw.lng() + this._ne.lng()) / 2) : new LatLng(0, 0); }
    union(b) { if (b._sw) { this.extend(b._sw); this.extend(b._ne); } return this; }
  }
  class Size { constructor(w, h) { this.width = w; this.height = h; } equals(o) { return o && o.width === this.width && o.height === this.height; } }
  class Point { constructor(x, y) { this.x = x; this.y = y; } equals(o) { return o && o.x === this.x && o.y === this.y; } }
  class MVCObject { constructor() { this._l = {}; } addListener(ev, fn) { (this._l[ev] ||= []).push(fn); const self = this; return { remove() { self._l[ev] = (self._l[ev] || []).filter((f) => f !== fn); } }; } _fire(ev, ...a) { for (const f of (this._l[ev] || [])) f(...a); } set() {} get() {} setValues() {} }
  class Map extends MVCObject {
    constructor(div, opts = {}) {
      super(); this.div = div; this.opts = { ...opts };
      this._center = opts.center ? toLL(opts.center).toJSON() : { lat: 34.1, lng: -84 }; this._zoom = opts.zoom || 9;
      this.pane = document.createElement('div'); this.pane.className = 'pm-pane'; this.pane.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:#dfe7d3';
      div.appendChild(this.pane);
      this.controls = []; for (let i = 0; i < 16; i++) this.controls.push({ push() {}, clear() {}, getLength() { return 0; } });
      this.data = { addListener() { return { remove() {} }; }, setStyle() {}, add() {}, remove() {}, forEach() {} };
      window.__pmMaps = window.__pmMaps || []; window.__pmMaps.push(this);
    }
    getCenter() { const c = this._center; return new LatLng(c.lat, c.lng); } setCenter(c) { this._center = toLL(c).toJSON(); this._fire('center_changed'); }
    getZoom() { return this._zoom; } setZoom(z) { this._zoom = z; this._fire('zoom_changed'); } panTo(c) { this.setCenter(c); } panBy() {}
    fitBounds(b) { if (b && b._sw) { this.setCenter(b.getCenter()); this._fire('bounds_changed'); this._fire('idle'); } }
    getBounds() { const c = this._center; const z = this._zoom || 9; const s = Math.pow(2, z) * 256 / 360; return new LatLngBounds({ lat: c.lat - (H / 2) / s, lng: c.lng - (W / 2) / s }, { lat: c.lat + (H / 2) / s, lng: c.lng + (W / 2) / s }); }
    setOptions(o) { Object.assign(this.opts, o); } setMapTypeId(t) { this.opts.mapTypeId = t; } getMapTypeId() { return this.opts.mapTypeId; } getDiv() { return this.div; }
    getProjection() { return { fromLatLngToPoint: (ll) => new Point(ll.lng(), ll.lat()), fromPointToLatLng: (p) => new LatLng(p.y, p.x) }; }
    setTilt() {} getTilt() { return 0; } setHeading() {} getHeading() { return 0; } setClickableIcons() {} overlayMapTypes = { push() {}, clear() {}, getLength() { return 0; } };
  }
  class Marker extends MVCObject {
    constructor(o = {}) {
      super(); this.o = { ...o }; this._map = null;
      const el = document.createElement('div'); el.className = 'pm-marker'; el.style.cssText = 'position:absolute;width:24px;height:24px;transform:translate(-12px,-24px)';
      this.el = el; this._paint(); if (o.map) this.setMap(o.map);
      window.__pmMarkerCount = (window.__pmMarkerCount || 0) + 1;
    }
    _paint() { const i = this.o.icon; let img = this.el.firstChild; if (i && i.url) { if (!img) { img = document.createElement('img'); img.draggable = false; this.el.appendChild(img); } if (img.src !== i.url) img.src = i.url; if (i.scaledSize) { img.style.width = i.scaledSize.width + 'px'; img.style.height = i.scaledSize.height + 'px'; } } else if (img) img.remove(); if (this.o.title) this.el.title = this.o.title; if (this.o.zIndex != null) this.el.style.zIndex = this.o.zIndex; }
    setMap(map) { if (this._map === map) return; if (this._map) { this.el.remove(); window.__pmDetached = (window.__pmDetached || 0) + 1; } this._map = map; if (map) { const p = proj(map, this.o.position); this.el.style.left = p.x + 'px'; this.el.style.top = p.y + 'px'; map.pane.appendChild(this.el); window.__pmAttached = (window.__pmAttached || 0) + 1; } }
    getMap() { return this._map; } setIcon(i) { this.o.icon = i; this._paint(); } getIcon() { return this.o.icon; } setZIndex(z) { this.o.zIndex = z; this.el.style.zIndex = z; } getZIndex() { return this.o.zIndex; }
    setPosition(p) { this.o.position = p; if (this._map) { const q = proj(this._map, p); this.el.style.left = q.x + 'px'; this.el.style.top = q.y + 'px'; } } getPosition() { return toLL(this.o.position); }
    setTitle(t) { this.o.title = t; this.el.title = t; } getTitle() { return this.o.title; } setLabel(l) { this.o.label = l; } getLabel() { return this.o.label; } setVisible(v) { this.el.style.display = v ? '' : 'none'; } getVisible() { return true; } setAnimation() {} setDraggable(d) { this.o.draggable = d; } getDraggable() { return !!this.o.draggable; } setOptions(o) { Object.assign(this.o, o); this._paint(); } setClickable() {} setCursor() {} setOpacity() {}
    addListener(ev, fn) { const dom = { click: 'click', mouseover: 'mouseover', mouseout: 'mouseout', dblclick: 'dblclick', dragend: 'dragend', mousedown: 'mousedown', mouseup: 'mouseup' }[ev]; const self = this; const h = (e) => fn({ latLng: self.getPosition(), domEvent: e, stop() {} }); if (dom) this.el.addEventListener(dom, h); return { remove() { if (dom) self.el.removeEventListener(dom, h); } }; }
    static MAX_ZINDEX = 1000000;
  }
  class Polyline extends MVCObject {
    constructor(o = {}) { super(); this.o = { ...o }; this._map = null; this.el = document.createElement('div'); this.el.className = 'pm-polyline'; this.el.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px'; if (o.map) this.setMap(o.map); }
    setMap(map) { if (this._map === map) return; if (this._map) this.el.remove(); this._map = map; if (map) map.pane.appendChild(this.el); }
    getMap() { return this._map; } setOptions(o) { Object.assign(this.o, o); } setPath(p) { this.o.path = p; } getPath() { const a = this.o.path || []; return { getArray: () => a, getLength: () => a.length, getAt: (i) => a[i], forEach: (f) => a.forEach(f) }; } setVisible() {}
    addListener(ev, fn) { const dom = { click: 'click', mouseover: 'mouseover', mouseout: 'mouseout' }[ev]; const self = this; const h = (e) => fn({ latLng: null, domEvent: e }); if (dom) this.el.addEventListener(dom, h); return { remove() { if (dom) self.el.removeEventListener(dom, h); } }; }
  }
  class Polygon extends Polyline {}
  class Circle extends Polyline { getBounds() { return new LatLngBounds(); } setCenter() {} setRadius() {} }
  class OverlayView extends MVCObject {
    setMap(map) { this._map = map; if (map) { try { this.onAdd && this.onAdd(); this.draw && this.draw(); } catch {} } else { try { this.onRemove && this.onRemove(); } catch {} } }
    getMap() { return this._map; }
    getPanes() { const p = this._map ? this._map.pane : document.body; return { overlayLayer: p, overlayMouseTarget: p, markerLayer: p, floatPane: p, mapPane: p, overlayShadow: p }; }
    getProjection() { const map = this._map; return { fromContainerPixelToLatLng: (pt) => { const c = map._center; const z = map._zoom || 9; const s = Math.pow(2, z) * 256 / 360; return new LatLng(c.lat - (pt.y - H / 2) / s, c.lng + (pt.x - W / 2) / s); }, fromLatLngToContainerPixel: (ll) => { const q = proj(map, ll); return new Point(q.x, q.y); }, fromLatLngToDivPixel: (ll) => { const q = proj(map, ll); return new Point(q.x, q.y); }, fromDivPixelToLatLng: (pt) => { const c = map._center; const z = map._zoom || 9; const s = Math.pow(2, z) * 256 / 360; return new LatLng(c.lat - (pt.y - H / 2) / s, c.lng + (pt.x - W / 2) / s); } }; }
    static preventMapHitsFrom() {} static preventMapHitsAndGesturesFrom() {}
  }
  class InfoWindow extends MVCObject { open() {} close() {} setContent() {} setPosition() {} }
  class Geocoder { geocode() { return Promise.resolve({ results: [] }); } }
  Object.assign(m, {
    LatLng, LatLngBounds, Size, Point, Map, Marker, Polyline, Polygon, Circle, OverlayView, InfoWindow, Geocoder, MVCObject,
    ControlPosition: { TOP_LEFT: 1, TOP_CENTER: 2, TOP_RIGHT: 3, LEFT_TOP: 5, RIGHT_TOP: 7, LEFT_CENTER: 4, RIGHT_CENTER: 8, LEFT_BOTTOM: 6, RIGHT_BOTTOM: 9, BOTTOM_LEFT: 10, BOTTOM_CENTER: 11, BOTTOM_RIGHT: 12 },
    Animation: { DROP: 2, BOUNCE: 1 }, SymbolPath: { CIRCLE: 0 }, MapTypeId: { ROADMAP: 'roadmap', HYBRID: 'hybrid', SATELLITE: 'satellite', TERRAIN: 'terrain' },
    event: { trigger(obj, ev, ...a) { obj && obj._fire && obj._fire(ev, ...a); }, addListener(obj, ev, fn) { return obj.addListener(ev, fn); }, addListenerOnce(obj, ev, fn) { let h; h = obj.addListener(ev, (...a) => { h.remove(); fn(...a); }); setTimeout(() => { try { fn(); } catch {} }, 0); return h; }, removeListener(h) { h && h.remove && h.remove(); }, clearInstanceListeners() {}, clearListeners() {}, addDomListener(el, ev, fn) { el.addEventListener(ev, fn); return { remove() { el.removeEventListener(ev, fn); } }; } },
    marker: { AdvancedMarkerElement: class {} }, version: 'stub',
  });
  m.importLibrary = () => Promise.resolve(m);
  // The inline bootstrap parked its resolver on google.maps.__ib__ and expects the script to call it.
  const cb = new URLSearchParams((document.currentScript && document.currentScript.src.split('?')[1]) || '').get('callback');
  if (cb === 'google.maps.__ib__' && typeof m.__ib__ === 'function') m.__ib__();
  else if (cb && typeof window[cb] === 'function') window[cb]();
})();
