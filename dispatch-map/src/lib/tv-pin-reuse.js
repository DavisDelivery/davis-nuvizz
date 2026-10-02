// lib/tv-pin-reuse.js — THE WALL KEEPS ITS PINS.
//
// Chad, 2026-10-02, with a photo of the office television: "Why are my icons not right. They keep
// disappearing and reappearing."
//
// MEASURED, NOT GUESSED. The board refreshes every two minutes (STOPS_REFRESH_MS) and every refresh
// hands the map a NEW stops array, changed or not. The Map's stop-pin effect answered every new
// array the same way: take every pin off and build every pin again. Counted on the real bundle over
// Google's real map with an 813-stop board that did not change: 813 pins removed and 813 created,
// every two minutes. Google draws pins into canvas tiles, so a rebuild is a redraw from nothing — a
// frame on a desk, long enough to watch on a 2020 television. Dense metro Atlanta empties first and
// refills last, which is the photograph: a few outlying pins standing on an empty city.
//
// THE RULE: a pin stays on the glass when everything it draws and does is what it was — where it
// is, its icon, its title, its opacity, its stacking and its receiving-hours hover text. A stop
// whose pin changed gets a new pin; a stop that left loses its pin; nobody else is touched.
//
// PURE, so the rule is tested without a map (test/tv-pin-reuse.test.mjs); the effect that applies
// it is the Map screen's stop-pin effect, on the television's live map only.

/**
 * Keys that survive duplicate ids: the nth occurrence of an id is `${id}#${n}`. A board can carry
 * the same stop number twice, and two pins sharing one key would trade places on every refresh.
 */
export function pinKeyer() {
  const seen = new Map();
  return (id) => {
    const k = String(id ?? '');
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    return `${k}#${n}`;
  };
}

/**
 * What a marker icon DRAWS. Compared by contents, never by identity: the pin icon cache is
 * cleared once it passes 8,000 entries, and a cleared cache must not repaint the wall.
 * Joined on a control character that neither an encoded data: URL nor a number contains, so
 * no field can run into its neighbour.
 */
export function iconSig(icon) {
  if (icon == null) return '';
  if (typeof icon === 'string') return icon;
  const s = icon.scaledSize || {};
  const a = icon.anchor || {};
  const l = icon.labelOrigin || {};
  return [icon.url ?? '', s.width ?? '', s.height ?? '', a.x ?? '', a.y ?? '', l.x ?? '', l.y ?? ''].join('\u001e');
}

/**
 * Everything one stop's pin draws and does, as one comparable string — built from the SAME
 * options object the pin is constructed with, so the comparison cannot drift from the pin.
 * `hover` is the receiving-hours text its hover tooltip shows (null when it has none).
 */
export function pinSig({ position, icon, title, opacity, zIndex, hover } = {}) {
  const p = position || {};
  return [p.lat ?? '', p.lng ?? '', iconSig(icon), title ?? '', opacity ?? '', zIndex ?? '', hover ?? ''].join('\u001f');
}
