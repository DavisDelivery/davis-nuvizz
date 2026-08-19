// lib/flag-alert.mts
//
// EMAIL CUSTOMER SERVICE THE FIRST TIME A STOP GOES CRITICAL.
//
// Chad: "if something gets a red flag, that we should send a email to customer service at
// Davis delivery dot com" and, on when: "needs to only send the email the first time the
// flag appears as a red flag which could come later in day if a driver gets behind. We want
// every red. Amber is a screen thing. Yeah if we are already past the time shouldn't send."
//
// WHY THIS ALERTS ON CRITICAL AND NOT ON THE OLD 'red'. Until v0.55.4 the tier meant only
// where the receiving hours came from — red if a dispatcher typed them, amber if they were
// parsed from Uline's order text. Wiring an alert to that would have paged customer service
// based on the PROVENANCE of a time, not on whether freight was about to be refused: a stop
// predicted 155 minutes late read as advisory while a 5-minute overrun against typed hours
// read as red. Severity now comes from slack measured against the model's own known error,
// and 'critical' means the overrun survives the model being as wrong as it usually is.
//
// THE FOUR RULES, each of which exists because breaking it produces a specific bad morning:
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
// DELIBERATELY NOT THE CUSTOMER-COMMS CAP. Chad: "the flag emails should not be bound to the
// resend cap we set for customer communications." They never shared code — this module reads
// no comms config and increments no comms counter, and the two only meet at the Resend
// account itself. But the first number here was 25, which is exactly the figure the customer
// email trial ran at, and a constant that LOOKS borrowed will eventually be treated as
// borrowed by whoever tunes the other one.
//
// So it is sized as what it is: an anti-runaway ceiling, an order of magnitude above any
// plausible day. Operational alerts are not a marketing budget — a day with forty trucks in
// trouble is a day when customer service needs forty emails, not the first twenty-five.
export const DAILY_ALERT_CAP = 200;

export function alertClaimPath(tenant: string, date: string, stopNbr: string): string {
  const safe = String(stopNbr).replace(/[^A-Za-z0-9_.-]/g, '_');
  return `${ALERT_COLLECTION}/${tenant}__${date}__${safe}`;
}

export interface AlertCandidate {
  stopNbr: string; customer: string; route: string;
  closeMin: number; etaMin: number; lateBy: number; tier: string;
  anchored?: boolean; detail?: string;
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
export function selectAlertable(rows: any[], nowMin: number | null): AlertCandidate[] {
  const out: AlertCandidate[] = [];
  for (const r of rows || []) {
    if (r?.rule !== 'hours_risk') continue;
    if (r?.tier !== 'critical') continue;          // amber and red stay on the screen
    if (!r?.stopNbr) continue;                     // a collapsed summary row is not a stop
    if (r?.collapsed) continue;
    const closeMin = Number(r.closeMin);
    if (!Number.isFinite(closeMin)) continue;
    // Rule 2 — the window has already shut. Nothing actionable is left in this message.
    if (nowMin != null && nowMin >= closeMin) continue;
    out.push({
      stopNbr: String(r.stopNbr), customer: String(r.customer || r.businessName || ''),
      route: String(r.routeName || ''), closeMin, etaMin: Number(r.etaMin),
      lateBy: Number(r.lateBy), tier: r.tier, anchored: !!r.anchored, detail: String(r.detail || ''),
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
): Promise<{ sent: number; claimed: number; failed: number; skippedAlreadySent: number; capped: number }> {
  const send = io.send || sendEmail;
  let sent = 0, claimed = 0, failed = 0, skippedAlreadySent = 0, capped = 0;
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
    if (!won) { skippedAlreadySent += 1; continue; }
    claimed += 1;
    const msg = buildAlert(c, date);
    const res = await send({ to: [to], subject: msg.subject, text: msg.text, html: msg.html });
    if (res?.ok) sent += 1; else failed += 1;
  }
  return { sent, claimed, failed, skippedAlreadySent, capped };
}
