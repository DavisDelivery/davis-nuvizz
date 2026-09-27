// src/lib/driver-area-overlay.js — THE DRIVER-AREA RINGS, ON THE LIVE MAP.
//
// Chad, 2026-09-27: "find the circles we were working on for the new trainee learning to route to
// try and guide him to where drivers go and we were going to build an overlay for the map that we
// could toggle on and off."
//
// The rings are page one of the printed driver-area sheet — one hollow ring per cluster of a
// driver's last four weeks of deliveries, his name in the middle — computed by the same function
// (territoryLayer → territoryModel, driver-territory.js) and drawn on the Map tab behind a switch.
// What is different about a LIVE map, and handled here:
//
//   • IT MUST NEVER CHANGE WHAT A CLICK DOES. The Map is the dispatch board. Fifty-odd rings cover
//     the whole metro, so a clickable ring would swallow nearly every click meant for the map, and
//     a name sitting over a pin would swallow the click meant for that stop. So the rings are
//     clickable:false and the names are pointer-events:none. The overlay is paint and nothing else;
//     every pin, line and panel behaves exactly as it does with the switch off.
//   • THE NAMES DECLUTTER BY ZOOM. Paper has one scale and could walk a name out along its ring
//     with a leader line; a live map has every scale. A name that would collide is not drawn at
//     this zoom and appears as you zoom in — how Google's own place names behave, which a
//     dispatcher already reads without being told.
//   • SMALLEST RING PLACES ITS NAME FIRST — the sheet's rule: a small ring is a precise claim about
//     one patch, while a big ring can be read by its outline.
//   • A RING WHOSE CENTRE IS OFF-SCREEN CAN STILL BE NAMED, just inside the arc where it crosses
//     into view — and a crowded centre falls back to its own arc too. Zoomed into one town the
//     rings are arcs, and an arc with no name on it teaches nothing. (A view wholly inside a big
//     ring shows no line at all, and so nothing to name — zoom out to see which ring it is.)
//
// Pure except makeDriverAreaOverlayClass, which is handed `google` and builds the map objects.

export const DRIVER_AREAS_WEEKS = 4;
export const DRIVER_AREAS_URL = `/.netlify/functions/driver-territory?format=layer&weeks=${DRIVER_AREAS_WEEKS}`;

const KM_PER_DEG_LAT = 110.574;
/** A name's box height in px (11px bold type on a 14px line). */
export const NAME_H = 14;

/**
 * WHERE EACH RING'S NAME GOES AT THIS ZOOM, OR NOWHERE.
 *
 * `items`: { id, x, y, r, w, h } in container pixels — the ring's centre, its radius and the
 * name's box. `view`: { width, height } of the map. Returns Map(id → { x, y }); an id that is
 * absent is not drawn at this zoom.
 *
 * Deterministic: the same rings at the same view always lay out the same way.
 */
export function placeRingLabels(items = [], view = {}) {
  const W = Number(view.width) || 0;
  const H = Number(view.height) || 0;
  const gap = view.gap ?? 3;
  const out = new Map();
  if (!(W > 0 && H > 0)) return out;
  const ok = (v) => Number.isFinite(v);
  const order = (items || [])
    .filter((it) => it && ok(it.x) && ok(it.y) && ok(it.r) && ok(it.w) && ok(it.h))
    .sort((a, b) => a.r - b.r || String(a.id).localeCompare(String(b.id)));
  const boxes = [];
  const onScreen = (x, y, w, h) => x - w / 2 >= 0 && x + w / 2 <= W && y - h / 2 >= 0 && y + h / 2 <= H;
  const free = (x, y, w, h) => !boxes.some((b) =>
    Math.abs(b.x - x) < (b.w + w) / 2 + gap && Math.abs(b.y - y) < (b.h + h) / 2 + gap);
  for (const it of order) {
    const tries = [];
    if (it.x >= 0 && it.x <= W && it.y >= 0 && it.y <= H) {
      tries.push([it.x, it.y]);
      // A ring big enough to hold the name above or below its centre may move it there — still
      // plainly inside its own ring, so the name cannot be read as belonging to a neighbour.
      if (it.r > it.h * 2.5) tries.push([it.x, it.y - it.h - gap], [it.x, it.y + it.h + gap]);
    }
    // THEN THE RING ITSELF: just inside it, starting from the point nearest the middle of the view
    // (where the arc the reader can see is) and working out to either side. This is the only place
    // a ring whose centre is off-screen can be named, and the fallback for one whose centre is on
    // screen but crowded or hard against an edge. The name keeps the ring's colour, so a name on
    // an arc still reads as that ring's.
    if (it.r > it.h * 2) {
      const base = Math.atan2(H / 2 - it.y, W / 2 - it.x);
      const k = it.r - it.h;
      for (const deg of [0, -30, 30, -60, 60, -90, 90]) {
        const a = base + (deg * Math.PI) / 180;
        tries.push([it.x + Math.cos(a) * k, it.y + Math.sin(a) * k]);
      }
    }
    const hit = tries.find(([x, y]) => onScreen(x, y, it.w, it.h) && free(x, y, it.w, it.h));
    if (!hit) continue;
    boxes.push({ x: hit[0], y: hit[1], w: it.w, h: it.h });
    out.set(it.id, { x: hit[0], y: hit[1] });
  }
  return out;
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-09-25" → "Sep 25" or "Sep 25, 2026". Anything that is not a day comes back as ''. */
export function fmtDay(day, withYear = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return '';
  return `${MON[Number(m[2]) - 1]} ${Number(m[3])}${withYear ? `, ${m[1]}` : ''}`;
}
/** { from, to } → "Aug 31 – Sep 25, 2026" (the year on both ends when they differ). */
export function fmtWindow(w) {
  const from = String(w?.from || ''), to = String(w?.to || '');
  if (!fmtDay(from) || !fmtDay(to)) return '';
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return `${fmtDay(from, !sameYear)} – ${fmtDay(to, true)}`;
}

const nameList = (names, max = 4) =>
  names.length > max ? `${names.slice(0, max).join(', ')} +${names.length - max} more` : names.join(', ');

/**
 * WHAT THE SWITCH SAYS UNDER ITSELF — and it always says something, because an overlay that is on
 * and drawing nothing looks exactly like one that is off. Loading, failed, empty and "built from
 * less than it claims" are four different facts and each gets its own words.
 *
 * Returns { tone: 'muted' | 'warn' | 'error', lines: string[] }.
 */
export function driverAreasStatus({ on, status, layer, error } = {}) {
  if (!on) return { tone: 'muted', lines: [`Rings round where drivers usually deliver, from the last ${DRIVER_AREAS_WEEKS} weeks of deliveries.`] };
  if (status === 'error') {
    return { tone: 'error', lines: [`Couldn't load driver areas${error ? ` (${error})` : ''}. Turn it off and on to try again.`] };
  }
  if (status !== 'ready' || !layer) return { tone: 'muted', lines: [`Reading the last ${DRIVER_AREAS_WEEKS} weeks of deliveries…`] };
  const rings = layer.rings || [];
  const failed = layer.readFailures || [];
  const deliveries = Number(layer.coverage?.deliveries) || 0;
  const lines = [];
  let tone = 'muted';
  // The days the rings are BUILT FROM, not the window asked for: today is in the window and has
  // no history until tonight's capture, and naming it would claim deliveries nobody has read.
  const when = fmtWindow(layer.dataWindow || layer.window);
  if (rings.length) {
    lines.push(`${rings.length} driver${rings.length === 1 ? '' : 's'}${when ? ` · ${when}` : ''} — usual areas, not today's routes. Zoom in to see more names.`);
  } else if (deliveries > 0) {
    // History came back and nobody earned a ring — a different fact from "no history", and the
    // lines below say who was looked at and why each has none.
    tone = 'warn';
    lines.push(`${deliveries.toLocaleString('en-US')} deliveries came back${when ? ` (${when})` : ''}, but no driver has a settled area to ring.`);
  } else {
    tone = 'warn';
    lines.push(`No delivery history came back for the last ${DRIVER_AREAS_WEEKS} weeks, so there is nothing to draw.`);
  }
  const noRing = layer.noRing || [];
  const spread = noRing.filter((n) => n.why === 'spread out').map((n) => n.label);
  const few = noRing.filter((n) => n.why === 'few coordinates').map((n) => (Number.isFinite(n.mapped) && Number.isFinite(n.stops) ? `${n.label} (${n.mapped} of ${n.stops})` : n.label));
  const none = noRing.filter((n) => n.why === 'no coordinates').map((n) => n.label);
  if (spread.length) lines.push(`No ring — work too spread out for one: ${nameList(spread)}.`);
  if (few.length) lines.push(`No ring — too few stops with a map position: ${nameList(few)}.`);
  if (none.length) lines.push(`No ring — no stops with a map position: ${nameList(none)}.`);
  const gone = (layer.excluded || []).map((e) => e.label).filter(Boolean);
  if (gone.length) lines.push(`Not shown — stopped running or too few stops: ${nameList(gone)}.`);
  if (failed.length) {
    tone = 'warn';
    lines.push(`${failed.length} day${failed.length === 1 ? '' : 's'} of history could not be read, so the rings are built from less than ${DRIVER_AREAS_WEEKS} weeks.`);
  }
  return { tone, lines };
}

// The name: the driver's colour on a white halo, like the sheet's page one. A halo rather than a
// white box, because the box is what hides the pin underneath and the pins are the freight.
const NAME_CSS = 'position:absolute;transform:translate(-50%,-50%);white-space:nowrap;'
  + 'font:700 11px/14px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;'
  + 'text-shadow:0 0 2px #fff,0 0 2px #fff,0 0 3px #fff,0 0 4px #fff;visibility:hidden;display:block;';

/**
 * The map objects, built from `google`. One instance per drawn layer:
 *
 *   const Overlay = makeDriverAreaOverlayClass(google);
 *   const o = new Overlay(layer); o.attach(map); … o.detach();
 */
export function makeDriverAreaOverlayClass(google) {
  class RingNames extends google.maps.OverlayView {
    constructor(labels) {
      super();
      this.labels = labels;
      this.box = null;
      this.els = [];
      this.widths = [];
      this.idle = null;
    }

    onAdd() {
      const box = document.createElement('div');
      box.setAttribute('data-driver-area-names', String(this.labels.length));
      // floatPane puts the names above the pins so they can be READ; pointer-events:none means a
      // click still lands on whatever is underneath. No z-index: the box goes in FIRST (below),
      // so everything else in the pane — the driver-truck plates, the hover cards, an info
      // window — paints over it by document order. A negative z-index would do the same only if
      // Google's pane is its own stacking context, which nothing here can promise; if it were
      // not, the names would sink under the map and the rings would show with no names at all.
      box.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;';
      this.els = this.labels.map((lb) => {
        const el = document.createElement('div');
        el.textContent = lb.text;
        el.setAttribute('data-driver-area-name', lb.text);
        el.style.cssText = `${NAME_CSS}color:${lb.colour};`;
        box.appendChild(el);
        return el;
      });
      const pane = this.getPanes().floatPane;
      pane.insertBefore(box, pane.firstChild);
      this.box = box;
      // Measured once, laid out but invisible. A map that is not on screen yet measures zero, and
      // then the name is sized by its letters rather than drawn with no box at all.
      this.widths = this.els.map((el) => Math.ceil(el.offsetWidth) || Math.ceil(el.textContent.length * 6.6 + 4));
      for (const el of this.els) { el.style.display = 'none'; el.style.visibility = 'visible'; }
      const map = this.getMap();
      // draw() runs on zoom; a PAN changes what is on screen without a zoom, and the names follow
      // the view, so they are laid out again whenever the map comes to rest.
      this.idle = map ? google.maps.event.addListener(map, 'idle', () => this.draw()) : null;
    }

    draw() {
      const proj = this.getProjection();
      const map = this.getMap();
      if (!proj || !map || !this.box) return;
      const div = map.getDiv();
      const centre = map.getCenter();
      if (!div || !centre) return;
      const a = proj.fromLatLngToContainerPixel(centre);
      const b = proj.fromLatLngToDivPixel(centre);
      if (!a || !b) return;
      const items = [];
      this.labels.forEach((lb, i) => {
        const c = proj.fromLatLngToContainerPixel(new google.maps.LatLng(lb.lat, lb.lng));
        const n = proj.fromLatLngToContainerPixel(new google.maps.LatLng(lb.lat + lb.radiusKm / KM_PER_DEG_LAT, lb.lng));
        if (!c || !n) return;
        // The TRUE distance to the ring's north point, not its height on screen: the map can be
        // turned, and a ring measured top-to-bottom on a map rotated 90° measures nothing.
        items.push({ id: i, x: c.x, y: c.y, r: Math.hypot(c.x - n.x, c.y - n.y), w: this.widths[i], h: NAME_H });
      });
      const placed = placeRingLabels(items, { width: div.offsetWidth, height: div.offsetHeight });
      // Laid out in container pixels (what is on screen), drawn in the pane's own pixels.
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      this.els.forEach((el, i) => {
        const p = placed.get(i);
        if (!p) { el.style.display = 'none'; return; }
        el.style.display = 'block';
        el.style.left = `${(p.x + dx).toFixed(1)}px`;
        el.style.top = `${(p.y + dy).toFixed(1)}px`;
      });
    }

    onRemove() {
      // The listener's own remove(), not google.maps.event.removeListener: the same call on the
      // real API, and the one the browser guards' stand-in google.maps also understands.
      if (this.idle) this.idle.remove();
      this.idle = null;
      if (this.box && this.box.parentNode) this.box.parentNode.removeChild(this.box);
      this.box = null;
      this.els = [];
    }
  }

  return class DriverAreaOverlay {
    constructor(layer) {
      this.rings = (layer && layer.rings) || [];
      this.shapes = [];
      this.names = null;
    }

    attach(map) {
      this.detach();
      if (!map) return;
      const drawn = [];
      for (const d of this.rings) {
        for (const c of d.circles || []) {
          if (![c.lat, c.lng, c.radiusKm].every(Number.isFinite)) continue;
          drawn.push({ d, c, at: { map, center: { lat: c.lat, lng: c.lng }, radius: c.radiusKm * 1000, clickable: false, zIndex: 0 } });
        }
      }
      // EVERY HALO FIRST, THEN EVERY RING. A white halo under the coloured line is the sheet's
      // own trick for a ring drawn over busy ground — on satellite tiles or through a cluster of
      // pins, a 2px line in a dark print colour otherwise disappears. Drawn ring-by-ring, each
      // later driver's 5px halo would cut a white gap through every earlier driver's line where
      // they cross; drawn all-halos-then-all-rings, no halo is ever above any ring. zIndex 0
      // keeps both under the route lines (1 and up).
      for (const { at } of drawn) {
        this.shapes.push(new google.maps.Circle({ ...at, strokeColor: '#ffffff', strokeOpacity: 0.75, strokeWeight: 5, fillOpacity: 0 }));
      }
      // HOLLOW — no fill at all. The paper's 5% tint reads fine four rings deep; on the live map
      // the metro sits under twenty-odd rings at once, and on the first real render (68 rings,
      // 2026-09-27) even 4% stacked into a brown wash over Gwinnett that hid the streets the
      // trainee is trying to learn. Lines only, so the base map and every pin read as they do
      // with the switch off.
      for (const { d, at } of drawn) {
        this.shapes.push(new google.maps.Circle({ ...at, strokeColor: d.colour, strokeOpacity: 0.95, strokeWeight: 2, fillOpacity: 0 }));
      }
      const labels = drawn.map(({ d, c }) => ({ text: d.label, colour: d.colour, lat: c.lat, lng: c.lng, radiusKm: c.radiusKm }));
      this.names = new RingNames(labels);
      this.names.setMap(map);
    }

    detach() {
      for (const s of this.shapes) s.setMap(null);
      this.shapes = [];
      if (this.names) this.names.setMap(null);
      this.names = null;
    }
  };
}
