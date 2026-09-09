// src/lib/uat-write-confirm.js
//
// ── THE BOX THAT STANDS IN FRONT OF A NUVIZZ WRITE ON THE TEST BOARD ─────────
//
// Chad, asked whether UAT should be allowed to write to NuVizz so the cancel-route and
// New-route fixes can actually be exercised there:
//
//   "Allow writes but make it where you have to confirm via box that this is what is
//    about to occur."
//
// So: on the UAT board every real write stops and says what it is about to do, by name,
// before anything leaves the browser. The server enforces the same rule independently
// (lib/mirror-guard.mts, nuvizzWriteGate) — this box is what makes the answer INFORMED,
// not what makes it safe. A confirmation that says "Are you sure?" and nothing else
// trains people to click yes; one that says "CANCEL route TRAILER 5 — 7 orders go back to
// Un-Planned" is a decision.
//
// PURE, so the sentence can be tested without a browser. The React half only renders what
// describeWriteOp returns.

/** The ops that actually change something in NuVizz. Anything not listed reads only, and
 *  never raises a box — a roster pull is not a decision. Mirrors MUTATING_OPS on the
 *  server (netlify/functions/lib/nuvizz-write-ops.mts); the server is the authority, this
 *  is what decides whether to ASK. */
export const MUTATING_WRITE_OPS = new Set([
  'createStop', 'insertStops', 'removeStops', 'assignDriver', 'dispatchLoad',
  'importLoad', 'commitLoad', 'commitBoard', 'commitImport',
  'partialUpdateStop', 'addStopNote', 'setStopDate', 'setStopContact', 'setStopAddress',
  'createRoute', 'newRoute', 'cancelStop', 'cancelOrder', 'cancelLoad',
]);

/** Should this call raise the box? Only on the test board, only for a real write. */
export function needsUatConfirm({ isUat, dryRun, op }) {
  if (!isUat) return false;
  if (dryRun) return false;                 // a dry run touches nothing by construction
  return MUTATING_WRITE_OPS.has(String(op || ''));
}

const n = (v) => (Array.isArray(v) ? v.length : 0);
const name = (l) => String(l?.routeName || l?.loadNbr || l?.loadId || 'a route').trim();

/**
 * PURE. What this write is about to do, in a dispatcher's words.
 * Returns { title, lines } — `lines` is the itemised list the box shows.
 * An op with nothing specific to say still gets an honest generic line rather than a
 * confident wrong one: never describe a write you have not actually read.
 */
export function describeWriteOp(op, payload = {}) {
  const lines = [];
  switch (op) {
    case 'commitBoard': {
      const loads = Array.isArray(payload?.loads) ? payload.loads : [];
      for (const l of loads) {
        const empty = l?.emptyLoad === true
          || (Array.isArray(l?.orderedStopNbrs) && l.orderedStopNbrs.length === 0);
        if (empty) {
          lines.push(`CANCEL ${name(l)} — ${n(l?.removeStopNbrs)} order(s) go back to Un-Planned`);
        } else {
          const bits = [`${name(l)} — set ${n(l?.orderedStopNbrs)} stop(s)`];
          if (n(l?.removeStopNbrs)) bits.push(`${n(l.removeStopNbrs)} removed`);
          if (l?.driverId) bits.push('assign a driver');
          if (l?.dispatch) bits.push('DISPATCH to the driver');
          lines.push(bits.join(', '));
        }
      }
      if (!lines.length) lines.push('save this board');
      return { title: `Save ${loads.length || 'this'} route${loads.length === 1 ? '' : 's'} to NuVizz`, lines };
    }
    case 'newRoute':
    case 'createRoute': {
      const orders = n(payload?.orderedStopNbrs) || n(payload?.route?.seeds);
      lines.push(`CREATE route ${payload?.routeName || payload?.loadNbr || payload?.route?.loadNbr || ''}`.trim());
      lines.push(`${orders} order(s) move onto it`);
      return { title: 'Create a route in NuVizz', lines };
    }
    case 'cancelLoad':
      return { title: 'Cancel a load in NuVizz', lines: [`CANCEL load ${payload?.loadNbr || payload?.loadId || ''}`.trim()] };
    case 'cancelStop':
    case 'cancelOrder':
      return { title: 'Cancel an order in NuVizz', lines: [`CANCEL order ${payload?.stopNbr || payload?.stopId || ''}`.trim()] };
    case 'assignDriver':
      return { title: 'Assign a driver in NuVizz', lines: ['Assign a driver to this route'] };
    case 'dispatchLoad':
      return { title: 'Dispatch a load in NuVizz', lines: ['DISPATCH this route — it reaches the driver’s phone'] };
    case 'setStopDate':
      return { title: 'Move an order’s date in NuVizz', lines: [`Order ${payload?.stopNbr || ''} → ${payload?.date || ''}`.trim()] };
    case 'addStopNote':
      return { title: 'Write a note onto an order in NuVizz', lines: [`Order ${payload?.stopNbr || ''}`.trim()] };
    case 'setStopContact':
      return { title: 'Write a contact onto an order in NuVizz', lines: [`Order ${payload?.stopNbr || ''}`.trim()] };
    case 'setStopAddress':
      return { title: 'Change an order’s address in NuVizz', lines: [`Order ${payload?.stopNbr || ''}`.trim()] };
    default:
      return { title: `Write to NuVizz (${op})`, lines: ['This changes data in NuVizz.'] };
  }
}

/** The standing sentence above the itemised list. Names the environment, because the whole
 *  reason for the box is that the two boards look identical. */
export const UAT_CONFIRM_PREAMBLE =
  'This is the UAT test board, and it is about to write to NuVizz for real. '
  + 'Check that this is what you meant to happen.';
