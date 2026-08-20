// lib/flag-alert.mts
//
// EMAIL CUSTOMER SERVICE THE FIRST TIME A STOP GOES CRITICAL.
//
// Chad: "if something gets a red flag, that we should send a email to customer service at
// Davis delivery dot com" and, on when: "needs to only send the email the first time the
// flag appears as a red flag which could come later in day if a driver gets behind. We want
// every red. Amber is a screen thing. Yeah if we are already past the time shouldn't send."
//
// WHAT THE TIERS MEAN, AND A REGRESSION THAT CAME OUT OF RENAMING THEM. Until v0.55.4 the
// tier meant only where the receiving hours came from — red if a dispatcher typed them,
// amber if they were parsed from Uline's order text. Wiring an alert to that would have
// paged customer service on the PROVENANCE of a time rather than on whether freight was
// about to be refused, so v0.55.4 rebuilt severity around slack measured against the model's
// own known error, and split the old red into 'critical' (the overrun survives the model
// being as wrong as it usually is) and 'red' (it clears the error band once, or the hours
// were typed and the stop is predicted late at all).
//
// The alert was then wired to 'critical' ALONE — and that quietly shrank the feature Chad
// asked for. He said "We want every red"; after the split, "every red" meant only the worst
// of them, and a stop the BOARD was showing as an urgent red flag sent nothing at all. He
// found it exactly that way: a red flag on SIMPLY CHARLOTTE MASON with no email behind it —
// "This popped up as an urgent red flag but no email was sent to customer service."
//
// So the rule is now the one that cannot drift from what he is looking at: IF THE BOARD
// SHOWS IT AS URGENT, CUSTOMER SERVICE HEARS ABOUT IT. Both urgent tiers alert. Amber stays
// a screen thing, as he said. Deliberately NOT a separate lateness threshold invented in
// here — a second, invisible bar is precisely how the screen and the inbox came to disagree,
// and how the disagreement stayed invisible for weeks.
//
// THE FOUR RULES, each of which exists because breaking it produces a specific bad morning:
//   0. EVERY URGENT TIER, matching the board. Chad: "We want every red. Amber is a screen
//      thing."
//   1. FIRST TRANSITION ONLY. One email per stop per board day, claimed atomically before
//      the send. The board recomputes every few minutes; without the claim a truck that
//      stays late emails customer service every sweep for the rest of the day.
//   2. NEVER AFTER THE CLOSE HAS PASSED. Past the close there is nothing anyone can do with
//      the message except feel bad about it, and it competes for attention with stops that
//      can still be saved.
//   3. NEVER FOR A FINISHED STOP. Delivered is delivered.
//   4. A RUNAWAY BACKSTOP. Not a budget. If a parser bug marked a whole 700-stop board
//      critical, that must not become 700 emails — but the ceiling has to sit far above any
//      real day, because suppressing a genuine "this truck is about to miss" is the one
//      failure this whole feature exists to prevent.
//
// Firestore only for state; the send goes through lib/email.mts. ZERO NuVizz calls.
import { sendEmail } from './email.mts';

export const ALERT_COLLECTION = 'eta_flag_alerts';
export const ALERT_TO = 'customerservice@davisdelivery.com';
// DELIBERATELY NOT THE CUSTOMER-COMMS CAP, AND DELIBERATELY NOT ITS NUMBER EITHER.
//
// Chad, twice: "the flag emails should not be bound to the resend cap we set for customer
// communications", and then "what i want to make sure is the alert email to customerservice
// when we are going to miss a delivery window is not bound to that ... cap for the customer
// communications on delivery confirmations."
//
// They are not, and never were, COUPLED: this module's only import is the raw sender, it
// reads no comms config document, and it increments no comms counter. The customer-comms
// daily cap lives in that engine's own config and is consumed only by its sweep. The single
// thing the two share is the Resend account itself, which is nowhere near either ceiling.
//
// The number is the part that kept causing the question. It was first 25 — exactly the
// figure the customer-email trial ran at — and then 200, which collided with the comms cap
// Chad had in mind. A constant that keeps LOOKING like the other one will keep being read as
// the other one, so it is now a value that matches nothing over there and is written as what
// it is: an anti-runaway ceiling for a parser bug marking a whole board critical.
//
// It sits far above any plausible day on purpose. Only stops that carry receiving hours,
// read RED or CRITICAL, and still have an open window can alert at all — a handful on a bad
// day. (Measured on the 2026-08-19 board at 11:07a: 0 critical, 1 red, 2 amber — so widening
// to red moved the day's alertable count from 0 to 1, not into the dozens.)
// Suppressing a real "this truck is about to miss" is the one failure this feature exists to
// prevent, so the ceiling must never be the thing that decides.
export const DAILY_ALERT_CAP = 500;

export function alertClaimPath(tenant: string, date: string, stopNbr: string): string {
  const safe = String(stopNbr).replace(/[^A-Za-z0-9_.-]/g, '_');
  return `${ALERT_COLLECTION}/${tenant}__${date}__${safe}`;
}

export interface AlertCandidate {
  stopNbr: string; customer: string; route: string;
  closeMin: number; etaMin: number; lateBy: number; tier: string;
  anchored?: boolean; detail?: string; rule?: string;
}

// A minutes value, or null — and STRICTLY, because the loose version shipped a real defect.
//
// `Number(r.closeMin)` was the original check, guarded by isFinite. But Number(null) is 0,
// Number('') is 0, and Number([]) is 0 — all finite. So a stop carrying no receiving close
// survived as closeMin 0. With a live clock the close-has-passed rule hid it by accident
// (now >= 0), but judging a past board passes nowMin null, that rule never runs, and it
// became a real email to customer service announcing "Receiving close 12:00a" about a stop
// that has no deadline at all. A midnight close is a legitimate value, so it cannot simply
// be treated as absent — the emptiness has to be rejected before the coercion, not after.
function finiteMinutes(v: any): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const hhmm = (m: number) => {
  const h = Math.floor(m / 60), x = m % 60;
  const ampm = h >= 12 ? 'p' : 'a';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(x).padStart(2, '0')}${ampm}`;
};

/**
 * PURE. Which flag rows deserve an email right now.
 *
 * `nowMin` is the board's own clock. A row whose close has already passed is dropped here
 * rather than at send time, so the reason is testable and the caller cannot forget it.
 */
// The tiers the BOARD paints as urgent. One list, so the screen and the inbox cannot come to
// disagree again without someone editing this line on purpose.
export const ALERT_TIERS = new Set(['critical', 'red']);
export { finiteMinutes };

// The rules that can EARN an email. no_driver_hours is here because it does not merely sit
// beside an hours_risk row — it DELETES it (board-flags R6, "one route, one card"), and a
// supersede that also silenced the alert meant the worst routes on the board were the
// quietest. It only carries a stopNbr and a closeMin when it actually replaced a real
// arrival row, so a screen-only R6 card still sends nothing.
export const ALERT_RULES = new Set(['hours_risk', 'no_driver_hours']);

export function selectAlertable(rows: any[], nowMin: number | null): AlertCandidate[] {
  const out: AlertCandidate[] = [];
  for (const r of rows || []) {
    if (!ALERT_RULES.has(String(r?.rule))) continue;
    if (!ALERT_TIERS.has(String(r?.tier))) continue;   // amber stays on the screen
    if (!r?.stopNbr) continue;                     // a collapsed summary row is not a stop
    if (r?.collapsed) continue;
    const closeMin = finiteMinutes(r?.closeMin);
    if (closeMin == null) continue;
    // Rule 2 — the window has already shut. Nothing actionable is left in this message.
    if (nowMin != null && nowMin >= closeMin) continue;
    out.push({
      stopNbr: String(r.stopNbr), customer: String(r.customer || r.businessName || ''),
      route: String(r.routeName || ''), closeMin, etaMin: Number(r.etaMin),
      lateBy: Number(r.lateBy), tier: r.tier, anchored: !!r.anchored, detail: String(r.detail || ''),
      rule: String(r.rule),
    });
  }
  // Worst first, so a cap keeps the most urgent rather than an arbitrary slice.
  out.sort((a, b) => b.lateBy - a.lateBy);
  return out;
}

/** PURE. The message. Says what is wrong, when it closes, and what the estimate rests on. */
export function buildAlert(c: AlertCandidate, date: string): { subject: string; text: string; html: string } {
  const eta = Number.isFinite(c.etaMin) ? hhmm(c.etaMin) : 'unknown';
  const close = hhmm(c.closeMin);
  const basis = c.anchored
    ? 'projected from a real arrival already recorded on this route'
    : 'projected from the planned start — no stop on this route has reported in yet';
  const subject = `Receiving window at risk — ${c.customer || c.stopNbr} closes ${close}, ETA ${eta}`;
  const text = [
    `${c.customer || 'Stop ' + c.stopNbr} is predicted to miss its receiving window.`,
    '',
    `PRO / stop:     ${c.stopNbr}`,
    `Route:          ${c.route || 'unassigned'}`,
    `Receiving close ${close}`,
    `Estimated arrival ${eta}  (${c.lateBy} minutes late)`,
    `Board date:     ${date}`,
    '',
    `Basis: ${basis}.`,
    '',
    'This is sent once, the first time the stop looks confidently late, and never after the',
    'window has already closed.',
  ].join('\n');
  const esc = (v: string) => String(v).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[ch]);
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#0f172a">
<p style="margin:0 0 12px"><strong>${esc(c.customer || 'Stop ' + c.stopNbr)}</strong> is predicted to miss its receiving window.</p>
<table style="border-collapse:collapse;font-size:14px">
<tr><td style="padding:2px 12px 2px 0;color:#475569">PRO / stop</td><td><strong>${esc(c.stopNbr)}</strong></td></tr>
<tr><td style="padding:2px 12px 2px 0;color:#475569">Route</td><td>${esc(c.route || 'unassigned')}</td></tr>
<tr><td style="padding:2px 12px 2px 0;color:#475569">Receiving close</td><td>${esc(close)}</td></tr>
<tr><td style="padding:2px 12px 2px 0;color:#475569">Estimated arrival</td><td><strong style="color:#b91c1c">${esc(eta)}</strong> (${c.lateBy} min late)</td></tr>
<tr><td style="padding:2px 12px 2px 0;color:#475569">Board date</td><td>${esc(date)}</td></tr>
</table>
<p style="margin:12px 0 0;color:#475569">Basis: ${esc(basis)}.</p>
<p style="margin:8px 0 0;color:#94a3b8;font-size:12px">Sent once, the first time this stop looks confidently late, and never after the window has closed.</p>
</div>`;
  return { subject, text, html };
}

/**
 * Claim-then-send. The claim is written BEFORE the send and is the thing that makes rule 1
 * hold: two overlapping sweeps both compute the same critical row, and only the one that
 * wins the create actually emails. A claim left behind by a send that then failed is the
 * deliberate trade — customer service missing one alert is recoverable, being emailed the
 * same stop every four minutes all afternoon is not.
 */
export async function sendAlerts(
  candidates: AlertCandidate[], date: string, tenant: string,
  io: { createDocIfAbsent: (p: string, d: any) => Promise<boolean>; send?: typeof sendEmail },
  to: string = ALERT_TO,
): Promise<{ sent: number; claimed: number; failed: number; skippedAlreadySent: number; capped: number; emailedStops: Set<string> }> {
  const send = io.send || sendEmail;
  let sent = 0, claimed = 0, failed = 0, skippedAlreadySent = 0, capped = 0;
  // WHICH STOPS A MESSAGE ACTUALLY REACHED CUSTOMER SERVICE ABOUT. Returned rather than
  // inferred, because the caller records it as history and the last thing built here that
  // inferred a send from an intention ran for weeks saying "routed to Google" about nothing.
  // A stop counts when THIS run mailed it, or when an earlier sweep already claimed it —
  // the claim is won once per stop per day, so the claim IS the record of the attempt.
  const emailedStops = new Set<string>();
  for (const c of candidates) {
    if (claimed >= DAILY_ALERT_CAP) { capped += 1; continue; }
    let won = false;
    try {
      won = await io.createDocIfAbsent(alertClaimPath(tenant, date, c.stopNbr), {
        tenant, date, stopNbr: c.stopNbr, customer: c.customer, route: c.route,
        lateBy: c.lateBy, closeMin: c.closeMin, etaMin: c.etaMin,
        claimed_at: new Date().toISOString(),
      });
    } catch { failed += 1; continue; }
    if (!won) { skippedAlreadySent += 1; emailedStops.add(String(c.stopNbr)); continue; }
    claimed += 1;
    const msg = buildAlert(c, date);
    const res = await send({ to: [to], subject: msg.subject, text: msg.text, html: msg.html });
    if (res?.ok) { sent += 1; emailedStops.add(String(c.stopNbr)); } else failed += 1;
  }
  return { sent, claimed, failed, skippedAlreadySent, capped, emailedStops };
}
