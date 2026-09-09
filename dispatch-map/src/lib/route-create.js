// src/lib/route-create.js — deriving a NuVizz load number for a NEW route (PURE).
//
// A route has TWO identifiers and they are not the same thing (see loadDisplayName /
// looksLikeLoadNbr in App.jsx): the human ROUTE NAME the board groups by ("TRAILER 6",
// "SUW 2"), and the LOAD NUMBER NuVizz keys load/info by. Portal-created loads get a
// NuVizz-minted number (DAVIS000000123); a route created through routePlan/update must
// supply its own, unique to the business and capped at 20 characters.
//
// The dispatcher types only the NAME. This derives the number, and the date is part of it
// on purpose: TRAILER 6 runs most days, so the number has to identify THAT DAY'S instance —
// otherwise the second day's create would collide with the first day's route and be refused.
export const ROUTE_FIELD_MAX = 20;

/** Strip a route name to the characters a load number may carry: A-Z, 0-9. */
export function routeNameSlug(routeName) {
  return String(routeName ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

/**
 * Derive the load number for `routeName` on `date` (yyyy-mm-dd) → e.g.
 * ("TRAILER 6", "2026-07-31") → "TRAILER6-0731".
 *
 * The MMDD suffix is never truncated — it is what makes each day's instance distinct — so
 * the NAME is what gives way when the two together would exceed NuVizz's 20-char cap.
 * Returns '' when either input is unusable, so callers can treat '' as "not valid yet".
 */
export function routeLoadNbr(routeName, date) {
  const slug = routeNameSlug(routeName);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? '').trim());
  if (!slug || !m) return '';
  const suffix = `-${m[2]}${m[3]}`;
  return slug.slice(0, ROUTE_FIELD_MAX - suffix.length) + suffix;
}

/**
 * Client-side pre-flight for the New route form. Catches everything that would otherwise
 * cost a NuVizz round-trip to learn, and one thing the server CANNOT catch: a name already
 * on today's board. (The server's own collision guard is the real authority — it refuses on
 * the load NUMBER, read live from NuVizz. This is the courtesy check, not the safety one.)
 *
 * `existingNames` = route names already on the board for that day.
 * Returns { ok, error, loadNbr }.
 *
 * NOTE (Aug 3 2026): NuVizz refuses a route with no stop node (reason 903), but that check
 * does NOT live here — the form only makes a LOCAL Compare card; the create is sent on Save
 * with the card's orders riding along, and Save is where an empty card is refused.
 */
export function validateNewRoute({ routeName, date, existingNames = [], hasOrigin = true } = {}) {
  const name = String(routeName ?? '').trim();
  if (!name) return { ok: false, error: 'Give the route a name (what you want to see on the board, e.g. TRAILER 6).', loadNbr: '' };
  if (name.length > ROUTE_FIELD_MAX) return { ok: false, error: `NuVizz caps a route name at ${ROUTE_FIELD_MAX} characters — "${name}" is ${name.length}.`, loadNbr: '' };
  if (!routeNameSlug(name)) return { ok: false, error: 'A route name needs at least one letter or number.', loadNbr: '' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? '').trim())) return { ok: false, error: 'Pick the day this route runs.', loadNbr: '' };
  const clash = existingNames.map((n) => String(n ?? '').trim().toUpperCase()).includes(name.toUpperCase());
  if (clash) return { ok: false, error: `${name} is already on the board for that day — open it from the Routes list instead of creating a second one.`, loadNbr: '' };
  if (!hasOrigin) return { ok: false, error: 'Set a ship-from address in the New Order tab first — NuVizz will not create a route without one.', loadNbr: '' };
  return { ok: true, error: null, loadNbr: routeLoadNbr(name, date) };
}

// ── WHERE THE ROUTE SHIPS FROM ──────────────────────────────────────────────
//
// Chad, on the ＋ New route form: "This is not functional i should have everything i need to
// create a new route right here in this screen."
//
// THE DEAD END, and it is two readers of one fact disagreeing. NuVizz will not create a route
// without a complete origin (it accepts the call and then creates nothing — see
// buildRouteCreateBody), so the form, the shell tap and the Save all gate on one. All three
// read the LAST-USED New Order pickup address out of localStorage, which is empty on any
// device where nobody has used the New Order tab — a different iPad, a cleared browser, a
// dispatcher who only ever routes. On that device the button never enables, and the message
// sends you to another tab to fix it.
//
// Meanwhile New Order itself has shipped a built-in Davis terminal since v0.50.35, precisely
// so "the pickup dropdown always exists (even on a fresh browser with nothing saved)". The
// address the form needed was in the app the whole time; only this screen could not see it.
//
// So the origin is RESOLVED, never merely read: the last-used pickup, else the first saved
// one, else the company terminal — and the form SHOWS which one it landed on, because a
// route created from the wrong warehouse is not something to discover at the dock.
const originStr = (o, k) => String(o?.[k] ?? '').trim();
/** A pickup address NuVizz can actually use: name + street + city + zip all present. */
export function originUsable(o) {
  return !!(originStr(o, 'name') && originStr(o, 'addr1') && originStr(o, 'city') && originStr(o, 'zip'));
}
/** Identity for de-duping a pickup list — the same pair New Order keys its own list by. */
export function originKeyOf(o) {
  return `${originStr(o, 'name').toLowerCase()}|${originStr(o, 'addr1').toLowerCase()}`;
}
/** One line for the form: "Davis Delivery Service — 943 Gainesville Hwy, Buford, GA 30518". */
export function originLine(o) {
  if (!o) return '';
  const where = [originStr(o, 'addr1'), originStr(o, 'city'), [originStr(o, 'state'), originStr(o, 'zip')].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ');
  return [originStr(o, 'name'), where].filter(Boolean).join(' — ');
}

/**
 * PURE. The ship-from this route will carry, and every one the dispatcher may pick instead.
 *
 * `lastUsed` — the New Order default (localStorage), or null.
 * `saved`    — that device's saved pickup list (New Order's own, terminal-seeded).
 * `fallback` — the company terminal, so a fresh device is never stuck.
 *
 * Returns { origin, source, options }: source is 'saved' when it came from the dispatcher's
 * own pickup list and 'default' when the terminal filled the gap — the form prints the
 * difference. Incomplete entries are dropped rather than offered: a half-address is exactly
 * what NuVizz accepts and silently does nothing with.
 */
export function resolveRouteOrigin({ lastUsed = null, saved = [], fallback = null } = {}) {
  const options = [];
  const seen = new Set();
  const add = (o, source) => {
    if (!originUsable(o)) return;
    const k = originKeyOf(o);
    if (seen.has(k)) return;
    seen.add(k);
    options.push({ origin: o, source, key: k });
  };
  add(lastUsed, 'saved');
  for (const o of Array.isArray(saved) ? saved : []) add(o, 'saved');
  add(fallback, 'default');
  // The fallback may already be in the saved list (New Order seeds it there) — in that case it
  // is the dispatcher's own entry and reads as 'saved', which is the truth.
  const first = options[0] || null;
  return { origin: first?.origin || null, source: first ? first.source : 'none', options };
}

// ── WHICH SELECTED ORDERS MAY RIDE THE CREATE ───────────────────────────────
//
// The form can start the route with what is already selected on the map — that is most of
// what "everything I need to create a new route" means, since a route IS its stops.
//
// But a create is stricter than an ordinary Save, and the server is the authority: runNewRoute
// refuses the WHOLE create if any order on the card is already planned on another load
// ("never silently steal a stop off a live load"). So seeding blindly from the selection would
// build a card that cannot be saved, and the dispatcher would find out at the Save button.
//
// This splits the selection instead: what can ride, and what is held back with the reason.
// Held orders stay selected — they are not dropped on the floor — so the ordinary cross-load
// move (open the source load in Compare, then Send) still does them in the flow that exists.
export function newRouteSeed({ ids = [], stopById = null, stagedElsewhere = null, claimedBy = null } = {}) {
  const seed = [];
  const planned = [];
  const claimed = [];
  const missing = [];
  const get = (id) => (stopById && typeof stopById.get === 'function' ? stopById.get(String(id)) : null);
  // `stagedElsewhere` is the screen's own staged-stop index: Map<stopNbr, card>, where a card
  // is either the display name or the {name,key} record the grid chips already use. Read both,
  // so the caller hands over what it has rather than shaping a third thing for this one rule.
  const holderName = (v) => {
    if (!v) return null;
    if (typeof v === 'string') return v;
    return String(v.name || v.key || '').trim() || 'an open card';
  };
  const stagedOn = (id) => holderName(stagedElsewhere && typeof stagedElsewhere.get === 'function' ? stagedElsewhere.get(String(id)) : null);
  const claimedByWho = (id) => (typeof claimedBy === 'function' ? claimedBy(String(id)) : null);
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw ?? '').trim();
    if (!id || seed.includes(id)) continue;
    const who = claimedByWho(id);
    if (who) { claimed.push({ id, who }); continue; }
    const card = stagedOn(id);
    if (card) { planned.push({ id, holder: card }); continue; }
    const s = get(id);
    if (!s) { missing.push(id); continue; }
    // Planned on a real load → the create would be refused for the whole card.
    if (s.isUnplanned === false || s.routeName || s.loadNbr) {
      planned.push({ id, holder: String(s.routeName || s.loadNbr || 'another load') });
      continue;
    }
    seed.push(id);
  }
  return { seed, planned, claimed, missing };
}

/** One sentence naming what the new card will and will not start with. '' when there is
 *  nothing to say (everything selected can ride). */
export function newRouteSeedNote({ seed = [], planned = [], claimed = [], missing = [] } = {}) {
  const held = [];
  if (planned.length) {
    const names = [...new Set(planned.map((p) => p.holder))];
    held.push(`${planned.length} already planned on ${names.slice(0, 2).join(', ')}${names.length > 2 ? ` and ${names.length - 2} more` : ''}`);
  }
  if (claimed.length) held.push(`${claimed.length} being staged by ${claimed[0].who} on another device`);
  if (missing.length) held.push(`${missing.length} no longer on the board`);
  if (!held.length) return '';
  return `${seed.length} of ${seed.length + planned.length + claimed.length + missing.length} selected order${seed.length + planned.length + claimed.length + missing.length === 1 ? '' : 's'} will start on this route — ${held.join('; ')}. Those stay selected: NuVizz refuses a create that moves an order off a live load, so open that load in Compare and Send them across once the route exists.`;
}
