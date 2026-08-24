import { flattenForConsumers } from './flag-rows.mts';
export { flattenForConsumers };
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

// ONE STOP GETS AT MOST TWO MESSAGES A DAY: THE HEADS-UP, AND "IT GOT WORSE".
//
// The claim used to key on the stop alone, which is right while only red and critical can
// email — the ratchet means a stop that has reached red never comes back down, so the one
// message it earns is the urgent one. The amber gate breaks that assumption: with the gate
// on, the FIRST message a stop earns is the early, inside-the-error-band one, and the
// escalation to red or critical then finds the claim already taken and sends NOTHING.
// Customer service would be told "we may run close, ETA 2:10p, 10 minutes late" and never
// told the truck is now 105 minutes late. The mild message would arrive and the actionable
// one would not — worse than the silence it replaced.
//
// So the claim carries a BAND, not a tier: 'early' for a gated amber, 'urgent' for red and
// critical. A stop can therefore send once as a heads-up and once more if it hardens, and
// no more than that — an escalation from red to critical shares the 'urgent' band and stays
// a single message, which is the behaviour that shipped and the one the caps were sized for.
export type AlertBand = 'early' | 'urgent';
export function alertBandOf(tier: string): AlertBand {
  // Fail toward LOUD. Only amber earns the soft early wording; anything unrecognised gets
  // the urgent message and the original claim key. The reverse polarity was unreachable
  // today (selectAlertable admits only amber past the tier gate), but the next person to
  // widen that gate should not also have to remember to widen this.
  return String(tier) === 'amber' ? 'early' : 'urgent';
}
export function alertClaimPath(tenant: string, date: string, stopNbr: string, band: AlertBand = 'urgent'): string {
  const safe = String(stopNbr).replace(/[^A-Za-z0-9_.-]/g, '_');
  // The urgent band keeps the ORIGINAL key, so every claim already written today still
  // counts and flipping the gate cannot re-send this morning's alerts.
  return band === 'urgent'
    ? `${ALERT_COLLECTION}/${tenant}__${date}__${safe}`
    : `${ALERT_COLLECTION}/${tenant}__${date}__${safe}__early`;
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

// THE CLOCK WRAPS, AND THIS DID NOT. A projected arrival can land past midnight — a route
// departing late on a bad day walks its last stops into tomorrow — and the board's own
// minutes just keep counting (1470 is 12:30am). Unwrapped, `h >= 12` read 24 as afternoon
// and the subject line a rep opens said "ETA 12:30p" for a truck arriving at 12:30 IN THE
// MORNING. Twelve hours wrong, in the direction that looks entirely plausible: nobody
// double-checks a same-day-looking time. Negative minutes (the evening sweep rebases its
// clock onto tomorrow's board with etMin - 1440) printed "-1:-30a".
//
// Normalised the same way flag-sms.fmtMin already does it — that path got this right and
// this one did not, which is how one message was correct and its sibling was not.
const hhmm = (m: number) => {
  if (!Number.isFinite(m)) return 'unknown';
  const mm = ((Math.round(m) % 1440) + 1440) % 1440;
  const h12 = ((Math.floor(mm / 60) + 11) % 12) + 1;
  const ap = mm < 720 ? 'a' : 'p';
  return `${h12}:${String(mm % 60).padStart(2, '0')}${ap}`;
};

/**
 * A TIME PAST MIDNIGHT HAS TO SAY SO. "closes 8:30a, ETA 12:30a" reads as arriving four
 * hours EARLY, which is the opposite of what it means — the wrap alone is not enough to make
 * the sentence true. Same-day times are left exactly as they were.
 */
const hhmmDay = (m: number) => {
  if (!Number.isFinite(m)) return 'unknown';
  const t = hhmm(m);
  if (m >= 1440) return `${t} next day`;
  if (m < 0) return `${t} (previous day)`;
  return t;
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

// AMBER, BUT ONLY WHEN THE DOOR IS ABOUT TO SHUT — SHIPPED OFF.
//
// Chad: "some of our flags have shown up too late to do anything about." Replaying 15 sealed
// weekdays (12,370 board stops, 1,132 with a judgeable close, 99 real misses) says the engine
// is not mostly blind — it is mostly SILENT. Of the 99 misses, 44 became email-eligible
// before their close; 30 more reached red or critical ON THE BOARD and never emailed (most
// crossed the line only at or after the close, when rule 2 rightly refuses); 9 topped out at
// amber; 16 were never seen at all. Of the 39 that never went email-eligible, 31 were
// flagged before their close with a median 60 minutes of warning. Amber is the early tier by
// construction: severityTier calls a row amber when the predicted overrun is inside the
// model's own error band, which overnight is 90 minutes.
//
// A blanket "email every amber" is the wrong answer and the corpus says so: 28 more false
// emails across 15 days to buy 2 more catches, of 39 and 16 minutes late, with the flood
// landing in the 7:00-8:00a sweeps where the clock is an unanchored guess against a 90-minute
// band. Measured alert precision by how early it fires: 80% inside 30 minutes, 62% at 1-2
// hours, 45% beyond four. Long-lead alerts are coin flips, and a coin-flip inbox is what
// teaches customer service to stop opening it — which would cost the 44 catches the rule
// already gets right.
//
// The gate is a CLIFF that was measured, not a threshold that was fitted. Of amber sightings
// within two hours of the close, 59% (29 of 49) were real misses; beyond two hours, 7%
// (2 of 30). At 120 minutes: recall 44.4% -> 73.7% for 20 extra false alarms over 15 days —
// 1.45 extra catches per extra false alarm, and 73 of the 75 misses ANY tier-based rule can
// reach. The 29 it newly catches ran a median 38 minutes late, up to 297, with 12 over an hour:
// a truck at a shut dock and a redelivery on our own dime.
//
// WHY IT SHIPS AT 0 (OFF). Where to set it is Chad's call, not an engineering one, because the
// two candidates trade different things and both are defensible:
//   120 — maximises catches (+29 over 15 days) at +1.33 emails/day.
//   180 — buys ZERO extra catches, but moves 11 real warnings a median 80 minutes earlier
//         (three of them from under an hour of lead to over it, all three ending critical at
//         44, 97 and 115 minutes late) for +0.93 emails/day.
// If the complaint is "too late to act on", 180 is the better number. Either is one env var
// and no deploy. At 0 this file behaves exactly as it did before.
//
// HONEST LIMIT ON THE NUMBERS ABOVE. They were simulated by gating at a row's FIRST sighting;
// this gate is evaluated on every sweep, which is a strictly wider rule (a row first seen at
// 6am and still amber at noon alerts here, and did not in the simulation). Its true position is
// bounded: catches 73-75, false alarms 34-62. Thirty rows sit in that gap and the field that
// would settle them (the tier at each sweep) is computed inside flag-replay-core and dropped
// before the rows are returned. Carrying it is a Firestore-only re-run, zero vendor calls.
//
// Amber is gated to hours_risk ONLY. An R6 no_driver_hours card takes its tier from provenance
// rather than from severityTier, so an amber one is not "a small predicted overrun" — it is a
// driverless load whose hours the scanner invented, and its volume is unmeasured here.
export const AMBER_LEAD_GATE_MIN = Number(process.env.AMBER_LEAD_GATE_MIN ?? 0);
// A SWITCH WHOSE POSITION CANNOT BE READ IS NOT A SWITCH. "120 minutes", "2h" and "120min"
// all coerce to NaN, which the clamp below turns into 0 — off, silently, and
// indistinguishable from a quiet day. Say so once at load, loudly, rather than letting the
// first question after the flip be an unanswerable "did that do anything?".
if (process.env.AMBER_LEAD_GATE_MIN != null
    && !(Number.isFinite(AMBER_LEAD_GATE_MIN) && AMBER_LEAD_GATE_MIN >= 0)) {
  console.error(`[flag-alert] AMBER_LEAD_GATE_MIN="${process.env.AMBER_LEAD_GATE_MIN}" is not a number of minutes — the amber gate is OFF.`);
}
const AMBER_GATED_RULES = new Set(['hours_risk']);

export function selectAlertable(rows: any[], nowMin: number | null, amberGateMin = AMBER_LEAD_GATE_MIN): AlertCandidate[] {
  const out: AlertCandidate[] = [];
  // A malformed env var must not silently open the gate to every amber on the board.
  const gate = Number.isFinite(amberGateMin) && amberGateMin > 0 ? amberGateMin : 0;
  // A BROKEN CLOCK IS NOT A CLOCK, AND IT MUST NOT READ AS "NO CLOCK".
  //
  // The two clock rules below were written against `nowMin != null`, and NaN passes that
  // test while failing every comparison it is then used in: `NaN >= closeMin` is false, so
  // the past-close refusal lets the row through, and `closeMin - NaN > gate` is false, so
  // the amber gate lets it through as well. An adversarial probe with Number('abc') as the
  // clock alerted on all three rows on a test board — including one whose close was ten
  // hours away and one whose close had already passed. A pre-day board legitimately has NO
  // clock (the evening sweep withholds nowMin on purpose), and that must keep working; a
  // NaN is a different thing entirely: it means a clock was PASSED and is broken, and the
  // honest response to "I do not know what time it is" is to send nothing this sweep
  // rather than mail whose every timing rule has silently stopped applying. The next
  // sweep with a working clock sends normally; nothing is lost but twenty minutes.
  if (nowMin != null && !Number.isFinite(nowMin as any)) return out;
  const clock = Number.isFinite(nowMin as any) ? (nowMin as number) : null;
  for (const r of flattenForConsumers(rows)) {
    if (!ALERT_RULES.has(String(r?.rule))) continue;
    if (!r?.stopNbr) continue;                     // a collapsed summary row is not a stop
    if (r?.collapsed) continue;
    // The close is parsed BEFORE the tier decision, because the amber gate is measured against
    // it — and because Number(null) is 0 and 0 is finite, which is how a stop with no deadline
    // once earned a midnight one (v0.56.3). finiteMinutes is the guard; it runs first.
    const closeMin = finiteMinutes(r?.closeMin);
    if (closeMin == null) continue;
    // AN ASSUMED CLOSE NEVER ALERTS, WHATEVER THE GATE IS SET TO.
    //
    // board-flags now judges a stop with no hours on file against a house 5pm close, tiered
    // 'assumed' and capped at amber. Amber alone would already keep it off this path — but
    // AMBER_GATED_RULES contains 'hours_risk', so the day somebody sets AMBER_LEAD_GATE_MIN
    // every stop still running at 4:30pm would text, against a deadline nobody recorded.
    // That switch was measured and flipped for auto-detected hours read off real order text;
    // it was not a decision about guesses. This guard sits ABOVE the gate deliberately, so
    // widening the gate later cannot quietly widen this too.
    if (String(r?.hoursTier) === 'assumed') continue;
    if (!ALERT_TIERS.has(String(r?.tier))) {
      // Not red or critical. The ONLY way past this line is an amber hours_risk row whose
      // close is inside the gate — and only when the gate has been switched on.
      if (String(r?.tier) !== 'amber') continue;
      if (!gate) continue;                             // shipped default: amber stays on screen
      if (!AMBER_GATED_RULES.has(String(r?.rule))) continue;
      if (clock == null) continue;                     // no clock, no measurable lead
      if (closeMin - clock > gate) continue;           // the door is not close enough yet
    }
    // Rule 2 — the window has already shut. Nothing actionable is left in this message.
    if (clock != null && clock >= closeMin) continue;
    out.push({
      stopNbr: String(r.stopNbr), customer: String(r.customer || r.businessName || ''),
      route: String(r.routeName || ''), closeMin, etaMin: Number(r.etaMin),
      lateBy: Number(r.lateBy), tier: r.tier, anchored: !!r.anchored, detail: String(r.detail || ''),
      rule: String(r.rule),
    });
  }
  // Worst first, so a cap keeps the most urgent rather than an arbitrary slice. A row with
  // no usable lateBy sorts last rather than poisoning the comparator: `undefined - 60` is
  // NaN, and a NaN comparator makes the whole ordering undefined, which at a cap means the
  // stops that get dropped are chosen arbitrarily rather than by how late they are.
  const worst = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : -Infinity);
  out.sort((a, b) => worst(b.lateBy) - worst(a.lateBy));
  return out;
}

/** PURE. The message. Says what is wrong, when it closes, and what the estimate rests on. */
export function buildAlert(c: AlertCandidate, date: string): { subject: string; text: string; html: string } {
  const eta = hhmmDay(c.etaMin as any);
  const close = hhmmDay(c.closeMin as any);
  const basis = c.anchored
    ? 'projected from a real arrival already recorded on this route'
    : 'projected from the planned start — no stop on this route has reported in yet';
  // AN EARLY WARNING MUST NOT WEAR A CONFIRMED MISS'S CLOTHES.
  //
  // Amber means the predicted overrun is INSIDE the model's own error band — board-flags
  // says of it "at this distance the model simply cannot tell late from on-time". Rendered
  // in the red email's words, a three-minute predicted overrun against a ±90-minute band
  // arrives byte-for-byte identical to a confident 115-minute miss, over a footer promising
  // it is "confidently late". A rep who chases two of those, finds the truck on time and is
  // told nothing distinguished them learns to discount the whole channel — which costs the
  // catches the red path already gets right. So the tier is on the face of the message.
  const early = alertBandOf(c.tier) === 'early';
  const subject = early
    ? `Heads-up — ${c.customer || c.stopNbr} closes ${close}, we may run it close (ETA ${eta})`
    : `Receiving window at risk — ${c.customer || c.stopNbr} closes ${close}, ETA ${eta}`;
  const opener = early
    ? `${c.customer || 'Stop ' + c.stopNbr} may run past its receiving window — this is an early warning, not a confirmed miss.`
    : `${c.customer || 'Stop ' + c.stopNbr} is predicted to miss its receiving window.`;
  const footer = early
    ? ['This is an EARLY WARNING, sent because the window closes soon and the estimate is past it.',
       'The estimate at this point in the run carries real error in both directions — the stop may',
       'still make it. If it hardens into a confident miss you will get one more message.']
    : ['This is sent once, the first time the stop looks confidently late, and never after the',
       'window has already closed.'];
  const text = [
    opener,
    '',
    `PRO / stop:     ${c.stopNbr}`,
    `Route:          ${c.route || 'unassigned'}`,
    `Receiving close ${close}`,
    `Estimated arrival ${eta}  (${c.lateBy} minutes late)`,
    `Board date:     ${date}`,
    '',
    `Basis: ${basis}.`,
    '',
    ...footer,
  ].join('\n');
  const esc = (v: string) => String(v).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[ch]);
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#0f172a">
<p style="margin:0 0 12px"><strong>${esc(c.customer || 'Stop ' + c.stopNbr)}</strong> ${early ? 'may run past its receiving window — <strong>early warning</strong>, not a confirmed miss.' : 'is predicted to miss its receiving window.'}</p>
<table style="border-collapse:collapse;font-size:14px">
<tr><td style="padding:2px 12px 2px 0;color:#475569">PRO / stop</td><td><strong>${esc(c.stopNbr)}</strong></td></tr>
<tr><td style="padding:2px 12px 2px 0;color:#475569">Route</td><td>${esc(c.route || 'unassigned')}</td></tr>
<tr><td style="padding:2px 12px 2px 0;color:#475569">Receiving close</td><td>${esc(close)}</td></tr>
<tr><td style="padding:2px 12px 2px 0;color:#475569">Estimated arrival</td><td><strong style="color:${early ? '#b45309' : '#b91c1c'}">${esc(eta)}</strong> (${c.lateBy} min late)</td></tr>
<tr><td style="padding:2px 12px 2px 0;color:#475569">Board date</td><td>${esc(date)}</td></tr>
</table>
<p style="margin:12px 0 0;color:#475569">Basis: ${esc(basis)}.</p>
<p style="margin:8px 0 0;color:#94a3b8;font-size:12px">${early ? 'Early warning — the window closes soon and the estimate is past it, but the estimate carries real error in both directions and the stop may still make it. One more message if it hardens.' : 'Sent once, the first time this stop looks confidently late, and never after the window has closed.'}</p>
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
  io: { createDocIfAbsent: (p: string, d: any) => Promise<boolean>; exists?: (p: string) => Promise<boolean>; claimedToday?: number; send?: typeof sendEmail },
  to: string = ALERT_TO,
): Promise<{ sent: number; claimed: number; failed: number; skippedAlreadySent: number; capped: number; emailedStops: Set<string> }> {
  const send = io.send || sendEmail;
  // The runaway ceiling counts the DAY, not the invocation. `claimed` used to start at zero
  // on every sweep, which made "DAILY"_ALERT_CAP a per-sweep throttle: the one scenario the
  // constant exists for — a parser bug marking a whole board urgent — would simply resume
  // twenty minutes later, 39 sweeps a day. Callers that can count today's claims seed it;
  // callers that cannot keep the old per-sweep behaviour, which is still a ceiling.
  let sent = 0, claimed = Number.isFinite(io.claimedToday as any) ? Number(io.claimedToday) : 0,
    failed = 0, skippedAlreadySent = 0, capped = 0;
  // WHICH STOPS AN URGENT MESSAGE ACTUALLY REACHED CUSTOMER SERVICE ABOUT. Returned rather
  // than inferred, because the caller records it as history and the screen renders it as
  // "Emailed CS" — a claim about what a human was told, so it must track sends, not
  // intentions. Three deliberate exclusions, each a bug the session's audit caught:
  //   * a FAILED send no longer counts — it used to be re-added by the next sweep's !won,
  //     making "emailed: true" permanent for a stop nobody was ever told about;
  //   * an EARLY (amber heads-up) send does not count — the study numbers and the screen
  //     both read this field as "the urgent alert went", and letting the soft message
  //     satisfy it would silently change what every historical number means;
  //   * a lost race counts only when the claim it lost to was the URGENT one.
  const emailedStops = new Set<string>();
  for (const c of candidates) {
    if (claimed >= DAILY_ALERT_CAP) { capped += 1; continue; }
    const band = alertBandOf(c.tier);
    let won = false;
    try {
      // THE BANDS MUST ARRIVE IN ORDER. The early message exists to be followed by the
      // urgent one ("one more message if it hardens"); if the urgent claim already stands,
      // an early message now would arrive AFTER the loud one, read as reassurance, and
      // promise a follow-up that can never come — the ratchet normally prevents red→amber,
      // but an R6 card leaves no history row for the floor, so the order is enforced here
      // rather than assumed. io.exists is optional: callers that cannot probe simply keep
      // the (rare) inversion, which costs one confusing email, not a lost alert.
      if (band === 'early' && io.exists) {
        const urgentTaken = await io.exists(alertClaimPath(tenant, date, c.stopNbr, 'urgent')).catch(() => false);
        // NOT added to emailedStops — the same rule the `!won` branch below states and for
        // the same reason. An urgent CLAIM proves an attempt was made on some earlier sweep,
        // not that a message arrived; the claim is deliberately kept even when the send
        // failed, which is what makes it useless as proof of delivery. The sweep that
        // actually sent already recorded the stop, and flag-history keeps that sticky
        // (`prev.emailed || ...`), so nothing is lost by staying quiet here — while adding it
        // turns one failed send into a permanent "Emailed CS" on the very next sweep. This
        // function had already worked that out four lines down and then did the opposite here.
        if (urgentTaken) { skippedAlreadySent += 1; continue; }
      }
      won = await io.createDocIfAbsent(alertClaimPath(tenant, date, c.stopNbr, band), {
        tenant, date, stopNbr: c.stopNbr, customer: c.customer, route: c.route,
        lateBy: c.lateBy, closeMin: c.closeMin, etaMin: c.etaMin, band, tier: c.tier,
        claimed_at: new Date().toISOString(),
      });
    } catch { failed += 1; continue; }
    if (!won) {
      // NOT added to emailedStops. The claim proves an ATTEMPT was made some earlier sweep,
      // not that a message arrived — and the sweep that actually sent already recorded the
      // stop, which flag-history keeps sticky (`prev.emailed || ...`). Re-adding here was
      // how one failed send became a permanent "Emailed CS" one sweep later.
      skippedAlreadySent += 1;
      continue;
    }
    claimed += 1;
    const msg = buildAlert(c, date);
    const res = await send({ to: [to], subject: msg.subject, text: msg.text, html: msg.html });
    if (res?.ok) { sent += 1; if (band === 'urgent') emailedStops.add(String(c.stopNbr)); } else failed += 1;
  }
  return { sent, claimed, failed, skippedAlreadySent, capped, emailedStops };
}
