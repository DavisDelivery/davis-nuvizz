// lib/stacker-alert.mts — FREIGHT THAT NEEDS A TRACTOR, EMAILED THE DAY IT LANDS.
//
// Chad, 2026-09-22, looking at the wall display: "The hydraulic stacker alert. I want those to
// fire an email the moment one of those hits our system so that we can address it hopefully
// the day before we have to deliver it."
//
// ── WHY THIS IS NOT THE EXISTING ALERT PATH ──────────────────────────────────
//
// The flag email (lib/flag-alert.mts) is built around a CLOCK: selectAlertable refuses any row
// without a finite closeMin, because every rule it carries is a prediction about a receiving
// window. A stacker order has no close and nothing to be late for — it is a fact about the
// FREIGHT, true from the moment the order is read, and the whole value is that it is knowable
// before anybody builds a truck. Bolting it onto a selector whose first gate is "is there a
// deadline" would have meant either loosening that gate for every rule or lying about a close.
//
// ── WHY IT IS NOT THE BOX-TRUCK CARD EITHER ──────────────────────────────────
//
// board-flags R4b (`box_truck_conflict`) already fires when such an order is riding a box, and
// that is what the 9pm text is for. But R4b needs a route with a known truck class, so it
// cannot say anything at all about an order that is not planned yet — which is exactly the
// order Chad wants to hear about, while the fix is still free. This alert therefore asks a
// SMALLER question with no truck in it: does this order carry freight that needs a tractor?
//
//   R4b  → "you HAVE put a stacker on a box truck"          → the 9pm text, per route
//   here → "a stacker is on the board for this day"          → the email, per order, once
//
// ── VOLUME, MEASURED BEFORE IT SHIPPED ───────────────────────────────────────
//
// An email per order is the shape that turns into a filter rule if it is wrong. Counted across
// five real boards (2026-09-16/17/18/21/22, 4,008 stops):
//
//     board        stops   stacker orders
//     2026-09-22     835        2
//     2026-09-21     686        0
//     2026-09-18     799        1
//     2026-09-17     832        0
//     2026-09-16     856        1
//
// Four in five days — 0.8 a board. One email a day, about the one order on the board that
// cannot go on most of the fleet. Of those four, exactly one was on a box route, which is why
// the text and the email are two different messages: three of the four would never have been
// mentioned at all under R4b alone.
//
// THAT COUNT IGNORES DELIVERY STATUS ON PURPOSE, and the distinction is worth writing down
// because the first version of this comment got it wrong. Run selectStackerOrders over those
// same boards TODAY and four of the five return zero — not because the freight was not there,
// but because every row on a past board now reads DELIVERED and `finished()` drops it. The
// table above is what this alert would have emailed on the morning of each board, which is
// the number that matters; the selector's answer on a historical board is a different
// question with a different answer, and confusing the two would understate the volume by 3.
//
// CLAIMED ONCE PER ORDER PER BOARD DAY, so the twenty-minute sweep that finds it does not
// re-send it every twenty minutes, and the evening sweep that sees tomorrow's board does not
// duplicate the day sweep's mail. Same createDocIfAbsent ratchet the flag email and the SMS
// both already use — one mechanism, three consumers.
//
// PURE except where marked: the selector and the body are testable on plain data; the caller
// owns the claim and the send.
import { stopHandlingFlags, HANDLING_FLAGS } from '../../../src/lib/handling-flags.js';

export const STACKER_CLAIM_COLLECTION = 'stacker_alert';

/** House shape: default ON, an explicit off-word turns it off, anything malformed leaves it ON
 *  — a typo in an env var must never silently re-silence a safety alert. */
export function stackerAlertEnabled(env: any = process.env): boolean {
  const v = String(env?.STACKER_ALERT ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

/** One claim per ORDER per board day. The order number is made path-safe: a Firestore doc id
 *  treats a slash as a path segment, which is the trap v0.50.8 was spent on. */
export function stackerClaimPath(tenant: string, date: string, stopNbr: string): string {
  const safe = String(stopNbr).replace(/[^A-Za-z0-9_.-]/g, '_') || '_';
  return `${STACKER_CLAIM_COLLECTION}/${tenant}__${date}__${safe}`;
}

export interface StackerOrder {
  stopNbr: string;
  pro: string | null;
  customer: string | null;
  city: string | null;
  routeName: string | null;
  driverName: string | null;
  handling: string[];
  planned: boolean;
}

/** Is this row finished freight? Delivered or written off is history, not a plan. */
const finished = (s: any) => {
  const st = String(s?.normalizedStatus || '').toUpperCase();
  return st === 'DELIVERED' || st === 'EXCEPTION' || st === 'CANCELLED';
};

/**
 * PURE. Every order on this board carrying freight that needs a tractor trailer.
 *
 * THE TRUCK IS DELIBERATELY NOT CONSULTED. An unplanned order is the one this alert exists
 * for — it is the cheapest possible moment to put it on the right truck — so filtering to
 * planned rows would silence the alert precisely when it is most useful. `planned` rides along
 * on the row so the email can say which ones are already committed.
 *
 * Terminal/depot rows and finished freight are dropped: a depot is not a delivery, and where a
 * stacker already went is not a decision anybody can still make.
 */
export function selectStackerOrders(stops: any[]): StackerOrder[] {
  const out: StackerOrder[] = [];
  const seen = new Set<string>();
  for (const s of stops || []) {
    if (!s || s.isTerminal || finished(s)) continue;
    const why = stopHandlingFlags(s)
      .filter((f: string) => (HANDLING_FLAGS as any)[f]?.needsTractor)
      .map((f: string) => String((HANDLING_FLAGS as any)[f]?.label || f).toLowerCase());
    if (!why.length) continue;
    const nbr = String(s.stopNbr ?? '').trim();
    if (!nbr || seen.has(nbr)) continue;           // one row per order, whatever the feed repeats
    seen.add(nbr);
    out.push({
      stopNbr: nbr,
      // Resolved, never assumed equal to stopNbr — a pickup's stop number is an RA-series
      // string and printing that under the word PRO is a number nobody can look up.
      pro: s.primaryPro ?? s.pro ?? nbr ?? null,
      customer: s.businessName ?? null,
      city: s.city ?? null,
      routeName: (s.routeName || s.loadNbr || null) ?? null,
      driverName: String(s.driverName || s.driverUserName || '').trim() || null,
      handling: why,
      planned: s.isPlanned === true,
    });
  }
  // Stable and meaningful: unplanned first (the ones still free to fix), then by order number.
  out.sort((a, b) => (Number(a.planned) - Number(b.planned)) || a.stopNbr.localeCompare(b.stopNbr));
  return out;
}

/** PURE. One order, one line — the same facts the card and the text carry, in reading order. */
export function stackerLine(o: StackerOrder): string {
  const where = [o.customer, o.city].filter(Boolean).join(', ');
  const truck = o.planned
    ? `planned on ${o.routeName || 'a route'}${o.driverName ? ` (${o.driverName})` : ''}`
    : 'not planned onto a route yet';
  return `PRO ${o.pro || o.stopNbr} - ${where || o.stopNbr} - carries ${o.handling.join(', ')} - ${truck}`;
}

/**
 * PURE. The email for one sweep's NEW stacker orders.
 *
 * It says what to DO, because an alert a reader cannot act on is decoration: a stacker rolls
 * off a dock or a trailer deck on its own castors, and every box truck in this fleet has a
 * liftgate instead of a dock. The action is to plan it onto a tractor, or to confirm with the
 * customer that the machine can come down on a gate.
 */
export function stackerEmail(orders: StackerOrder[], boardDate: string): { subject: string; text: string } {
  const n = orders.length;
  const subject = n === 1
    ? `Needs a tractor trailer - ${orders[0].customer || orders[0].stopNbr} (${boardDate})`
    : `Needs a tractor trailer - ${n} orders (${boardDate})`;
  const lines = orders.map((o) => `  * ${stackerLine(o)}`).join('\n');
  const text = [
    `${n === 1 ? 'An order' : `${n} orders`} on the ${boardDate} board carr${n === 1 ? 'ies' : 'y'} freight that needs a tractor trailer:`,
    '',
    lines,
    '',
    'A hydraulic stacker rolls off a dock or a trailer deck on its own castors. Our box',
    'trucks have a liftgate instead of a dock, and a top-heavy machine on a gate platform is',
    'how one gets tipped.',
    '',
    'Plan it onto a tractor trailer, or confirm with the customer that the machine can come',
    'off a liftgate. Sent once per order, the first time it appears on a board.',
    '',
    'Auto-alert from Dispatch Map.',
  ].join('\n');
  return { subject, text };
}

/**
 * THE EDGE. Claim each new stacker order, then email the ones this sweep actually won.
 *
 * Both sweeps call this and nothing else, so the day pass and the evening pass cannot drift
 * into two behaviours — the mistake lib/route-classes.mts was extracted to stop.
 *
 * THE CLAIM COMES FIRST AND THE SEND SECOND, and the order is the whole safety property: two
 * sweeps overlapping (the 7:00a day pass and a 6:59a evening pass both hold today's board)
 * would otherwise both read "not emailed yet" and both send. createDocIfAbsent is atomic, so
 * exactly one of them wins each order.
 *
 * A FAILED SEND DOES NOT UN-CLAIM, deliberately. Re-sending on the next sweep would turn a
 * flaky mail provider into twenty emails an hour about one order; the failure is counted and
 * logged instead. One missed alert is recoverable, an inbox nobody reads is not.
 */
export async function runStackerAlert(
  stops: any[], date: string, tenant: string,
  io: {
    createDocIfAbsent: (p: string, d: any) => Promise<boolean>;
    send: (a: { to: string | string[]; subject: string; text: string }) => Promise<{ ok: boolean; error?: string }>;
    to: string | string[];
    at?: string;
  },
  env: any = process.env,
): Promise<{ enabled: boolean; found: number; claimed: number; sent: number; failed: number; orders: string[] }> {
  const out = { enabled: stackerAlertEnabled(env), found: 0, claimed: 0, sent: 0, failed: 0, orders: [] as string[] };
  if (!out.enabled) return out;
  const orders = selectStackerOrders(stops);
  out.found = orders.length;
  if (!orders.length) return out;

  const fresh: StackerOrder[] = [];
  for (const o of orders) {
    const won = await io.createDocIfAbsent(stackerClaimPath(tenant, date, o.stopNbr), {
      at: io.at ?? null, stopNbr: o.stopNbr, pro: o.pro, customer: o.customer,
      routeName: o.routeName, planned: o.planned, handling: o.handling,
    });
    if (won) fresh.push(o);
  }
  out.claimed = fresh.length;
  if (!fresh.length) return out;                 // everything on this board was already mailed

  const { subject, text } = stackerEmail(fresh, date);
  const r = await io.send({ to: io.to, subject, text });
  if (r.ok) out.sent = 1; else { out.failed = 1; console.error('stacker alert email failed:', r.error); }
  out.orders = fresh.map((o) => o.stopNbr);
  return out;
}
