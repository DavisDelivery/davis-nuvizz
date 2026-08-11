// src/lib/map-base-options.js
//
// Chad: "hiding place labels is not working."
//
// It wasn't, and it could not have been. "Hide place labels" had two levers and both
// were dead on the roadmap base:
//
//   1. The map TYPE. With satellite on, the toggle swaps hybrid (imagery + labels) for
//      satellite (imagery, no labels) — that half genuinely worked. With satellite OFF
//      the type is 'roadmap', and there is no label-free roadmap type. Nothing to swap.
//   2. The JS `styles` array (poi/transit labels off). Google IGNORES `styles` entirely
//      on a map created with a cloud `mapId` — styling on those maps lives in the Cloud
//      console. This app passes VITE_GOOGLE_MAP_ID, so the style was silently dropped
//      and the code even guarded it away behind `if (!MAP_ID)`.
//
// So on the roadmap the switch moved and nothing happened. The fix is to stop asking a
// vector map to do something it cannot: while labels are hidden, build the map WITHOUT
// the mapId, which makes `styles` live again and strips the POI/transit labels on every
// base — roadmap included.
//
// The cost, stated plainly rather than hidden: a map with no mapId is not a vector map,
// so while the toggle is ON the 3D tilt/rotate compass is unavailable on the dispatch
// Map. Flipping it back restores them. That is the trade the vendor forces; the toggle
// doing nothing at all was the worse half of it.
//
// PURE → unit-tested in test/map-base-options.test.mjs. The callers do the re-init.

/** POI + transit LABELS off. Roads, water and geometry are untouched. */
export const NO_PLACE_LABEL_STYLES = [
  { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', elementType: 'labels', stylers: [{ visibility: 'off' }] },
];

/**
 * Can this map keep its cloud mapId? Only when we are NOT trying to style it at
 * runtime — the two are mutually exclusive in the Maps JS API.
 */
export function usesMapId(mapId, hideLabels) {
  return !!mapId && !hideLabels;
}

/**
 * The identity of the map we need to be looking at. A caller puts this in its init
 * effect's dependencies: it changes ONLY when the map has to be rebuilt to honour the
 * toggle, so a site with no mapId configured never re-inits (its `styles` can just be
 * set on the live map, as before).
 */
export function mapIdKey(mapId, hideLabels) {
  return usesMapId(mapId, hideLabels) ? String(mapId) : '';
}

/**
 * The base options for `new google.maps.Map(...)`.
 *
 * `styles` is only included when there is no mapId in play — passing both is what
 * produces Google's "map styles are ignored" console warning, and it is exactly the
 * combination that made this toggle look broken.
 */
export function mapBaseOptions({ mapId, hideLabels = false, satellite = false } = {}) {
  const keepMapId = usesMapId(mapId, hideLabels);
  return {
    ...(keepMapId ? { mapId: String(mapId) } : {}),
    // Satellite: 'satellite' carries no labels at all, 'hybrid' keeps roads + places.
    mapTypeId: satellite ? (hideLabels ? 'satellite' : 'hybrid') : 'roadmap',
    ...(keepMapId ? {} : { styles: hideLabels ? NO_PLACE_LABEL_STYLES : [] }),
  };
}

/**
 * What to hand `map.setOptions()` on a map that already exists — type and styles only,
 * never mapId (it is immutable after construction, which is why the toggle needs a
 * re-init at all). Returns null for `styles` when the live map is mapId-backed, so the
 * caller can skip a call Google would only warn about.
 */
export function mapLiveOptions({ mapId, hideLabels = false, satellite = false } = {}) {
  const keepMapId = usesMapId(mapId, hideLabels);
  return {
    mapTypeId: satellite ? (hideLabels ? 'satellite' : 'hybrid') : 'roadmap',
    styles: keepMapId ? null : (hideLabels ? NO_PLACE_LABEL_STYLES : []),
  };
}

/**
 * Carry the dispatcher's current view across a re-init. Rebuilding the map at the depot
 * would yank them back across the state every time they decluttered — the toggle has to
 * leave them looking at what they were looking at.
 */
export function keepView(map, fallbackCenter, fallbackZoom) {
  const out = { center: fallbackCenter, zoom: fallbackZoom };
  try {
    const c = map?.getCenter?.();
    const z = map?.getZoom?.();
    if (c && typeof c.lat === 'function' && typeof c.lng === 'function') {
      const lat = c.lat(); const lng = c.lng();
      if (Number.isFinite(lat) && Number.isFinite(lng)) out.center = { lat, lng };
    }
    if (Number.isFinite(z)) out.zoom = z;
  } catch { /* a dead map tells us nothing — fall back */ }
  return out;
}
