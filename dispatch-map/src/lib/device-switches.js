// lib/device-switches.js — the per-device switches, what they do, and what a wrong one looks like.
//
// Chad: "a settings profile or a settings button that we have all those switches in with a UI
// that explains what they do."
//
// WHY THIS EXISTS, measured rather than remembered. The app stores 22 per-device settings in
// localStorage. FOUR of them carry a label anywhere a dispatcher can read. The other eighteen
// silently change the board and nothing tells you they exist — and that is not a hypothetical
// failure, it is the same failure twice in one week:
//
//   v1.36.0  "where is my save send to nuvizz button? … i have no way to send these loads to
//            nuvizz." Four controls were gone. All four were gated on `routing.liveWrite`, a
//            per-device flag that seeds OFF. Nothing was broken. Nothing said so either.
//   v1.36.2  "i didn't ask for the stem out to come back." No PR that day touched the stem
//            line. `routing.hideStem` had simply never been switched on for that browser.
//
// Both cost a morning hunting a code bug that was a hidden switch. THE SYMPTOM LINE BELOW IS THE
// POINT OF THE WHOLE FILE: each switch says what the board looks like when it is not where you
// expect, so the next time a control vanishes this screen answers it in seconds instead of a day.
//
// DEFAULTS ARE READ OFF THE REAL INITIALISERS in App.jsx, not assumed — several are ON by
// default (`compareLive`, `mapSatellite` use `!== 'off'`) and calling those OFF would make this
// screen lie about which device is the odd one out, which is worse than not having it.
//
// LAYOUT MEMORY IS DELIBERATELY EXCLUDED — panel widths, which tab was open, rail positions.
// Chad asked for the ones that change behaviour, and a dispatcher scrolling past "remembered
// panel width" to reach "Live dispatch" is a dispatcher who stops reading the list.

/**
 * THE REGISTRY. Every entry: the localStorage key, the default the app actually uses, what ON
 * means in freight terms, and the symptom it produces when it is not what you expect.
 *
 * `kind` is 'toggle' (on/off) or 'choice' (two named values). Both are per-device and neither
 * touches Firestore or NuVizz — this is browser state, nothing more.
 */
export const DEVICE_SWITCHES = [
  {
    key: 'routing.liveWrite', kind: 'toggle', on: 'on', off: 'off', dflt: false,
    label: 'Live dispatch',
    does: 'Shows the Save / Send to NuVizz button, the engine badge, the LIVE / Beta switch and the driver row on Compare cards.',
    symptom: 'OFF and all four disappear — the usual cause of "where is my Send to NuVizz button?" (v1.36.0).',
  },
  {
    key: 'routing.compareLive', kind: 'toggle', on: 'on', off: 'off', dflt: true,
    label: 'Compare cards follow the live board',
    does: 'Compare cards keep reading the board as it changes.',
    symptom: 'OFF and a card can show a stop the board has already moved.',
  },
  {
    key: 'routing.planMode', kind: 'choice', values: ['loads', 'trucks'], dflt: 'loads',
    label: 'Step 2 plans onto',
    does: 'Whether "Plan onto" in the Build Panel offers loads or trucks.',
    symptom: 'Set to trucks and step 2 lists trucks where you expected load numbers.',
  },
  {
    key: 'routing.engineMode', kind: 'choice', values: ['driver', 'cleanup'], dflt: 'driver',
    label: 'Engine runs',
    does: 'Driver drafts, or the end-of-night cleanup solve.',
    symptom: 'Set to cleanup and the Engine answers a different question than the one you asked.',
  },
  {
    key: 'routing.hideStem', kind: 'toggle', on: 'on', off: 'off', dflt: false,
    label: 'Hide the stem-out line',
    does: 'Hides the line drawn from the depot to stop 1.',
    symptom: 'OFF and a long line runs across the map to the first stop (v1.36.2).',
  },
  {
    key: 'routing.mapUnplannedOnly', kind: 'toggle', on: 'on', off: 'off', dflt: false,
    label: 'Show only unplanned stops',
    does: 'Hides every stop already planned onto a load.',
    symptom: 'ON and most of the day is missing from the map — freight that is there and looks gone.',
  },
  {
    key: 'routing.mapShowRoutes', kind: 'toggle', on: 'on', off: 'off', dflt: false,
    label: 'Draw route lines',
    does: 'Draws the polyline for each route on the routing map.',
    symptom: 'OFF and routes show as pins with nothing joining them.',
  },
  {
    key: 'routing.mapHideTerminal', kind: 'toggle', on: 'on', off: 'off', dflt: false,
    label: 'Hide the terminal pin',
    does: 'Hides the depot pin, so the map shows customer stops only.',
    symptom: 'ON and the depot is not on the map, which makes a stem line look like it starts nowhere.',
  },
  {
    key: 'routing.mapSatellite', kind: 'toggle', on: 'on', off: 'off', dflt: true,
    label: 'Satellite imagery',
    does: 'Satellite tiles instead of the plain road map.',
    symptom: 'Cosmetic. Listed because it is remembered per device and people ask why one screen looks different.',
  },
  {
    key: 'routing.hideLabels', kind: 'toggle', on: 'on', off: 'off', dflt: false,
    label: 'Hide place labels',
    does: "Hides Google's business and place names on the routing map.",
    symptom: 'ON and the map reads bare — useful when pins are dense, confusing if you did not set it.',
  },
];

/** PURE: the stored value for a switch, or null when nothing has been stored on this device. */
export function readSwitch(storage, sw) {
  try {
    const raw = storage?.getItem?.(sw.key);
    return raw === null || raw === undefined ? null : String(raw);
  } catch { return null; }   // private mode, blocked storage — treat as "never set"
}

/**
 * PURE: what this switch is actually doing right now, resolved the way App.jsx resolves it.
 *
 * NOT a plain read. `mapSatellite` is stored as 'off'/'on' but its initialiser is `!== 'off'`,
 * so an ABSENT key means ON; `hideStem` uses `=== 'on'`, so an absent key means OFF. Reading
 * the raw string and calling anything non-'on' false would report the satellite switch as off
 * on every fresh browser — a settings screen that lies about the current state is worse than
 * no settings screen, because it sends you hunting the wrong thing.
 */
export function effectiveValue(storage, sw) {
  const raw = readSwitch(storage, sw);
  if (sw.kind === 'choice') return sw.values.includes(raw) ? raw : sw.dflt;
  if (raw === sw.on) return true;
  if (raw === sw.off) return false;
  return sw.dflt;
}

/** PURE: is this switch sitting where a fresh browser would put it? */
export function isDefault(storage, sw) {
  return effectiveValue(storage, sw) === sw.dflt;
}

/**
 * PURE: the whole screen's state in one pass — and the count that earns the banner.
 *
 * `offDefault` is what makes this screen worth opening: it is the answer to "is this device the
 * odd one out?", which is the question behind every one of the incidents above.
 */
export function switchReport(storage, list = DEVICE_SWITCHES) {
  const rows = list.map((sw) => {
    const value = effectiveValue(storage, sw);
    return { ...sw, value, def: value === sw.dflt, stored: readSwitch(storage, sw) };
  });
  return { rows, offDefault: rows.filter((r) => !r.def) };
}

/** PURE: the string to store for a new value, given the switch's own vocabulary. */
export function encodeValue(sw, value) {
  if (sw.kind === 'choice') return sw.values.includes(value) ? value : sw.dflt;
  return value ? sw.on : sw.off;
}

/** How a value reads in the UI. Choices show their own word; toggles read On / Off. */
export function describeValue(sw, value) {
  if (sw.kind === 'choice') return String(value);
  return value ? 'On' : 'Off';
}
