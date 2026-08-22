import { flattenForConsumers } from './flag-rows.mts';
// lib/flag-sms.mts
//
// THE EVENING FLAG TEXT — pure rules for who gets texted, about which board, saying what.
//
// Chad: "Flags need to show up on tomorrow's board for deliveries tomorrow soon as we
// start routing at 8pm tonight — shouldn't wait until 7. Trying to catch the clearly
// obvious problems or critical ones sooner." And: "Stop flag texts to Zach by 6am —
// after that he's no longer routing, so don't send him any more texts."
//
// The engine already judges any date; what never existed was a server pass outside
// 7:00a-7:40p and a channel that reaches a phone at 9pm. This module holds the pure
// decisions so the sweep stays a thin edge and every rule here is unit-tested:
//
//   * WHICH BOARD an evening/overnight sweep judges (8p-11p ET -> tomorrow's; after
//     midnight -> today's — the same board, crossing the date line).
//   * WHO is texted: FLAG_SMS_TO always; FLAG_SMS_TO_NIGHT (the router on duty) only
//     while routing is on — Zach's line goes quiet AT 6:00a ET sharp.
//   * WHAT the text says: facts in one breath — customer, stop position, estimated
//     arrival vs close, board date — nothing a phone screen truncates into mystery.
//
// Recipients live in ENV (FLAG_SMS_TO / FLAG_SMS_TO_NIGHT, comma-separated), never in
// code: phone numbers are personal data and rosters change without a deploy.

export const NIGHT_CUTOFF_MIN = 6 * 60;    // 6:00a ET — the router is done routing
export const EVENING_START_HOUR = 19;      // ET hour from which a sweep aims at TOMORROW
export const SMS_PER_SWEEP_CAP = 8;        // worst-first; the rest wait for the next pass
export const CLAIM_COLLECTION = 'eta_flag_sms';

const splitList = (v: any): string[] =>
  String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * PURE. Who gets this sweep's texts, given the ET minutes-past-midnight of the sweep.
 * The always-list rides every sweep; the night list (the router building loads) rides
 * only from the evening start THROUGH 5:59a — at 6:00a exactly it is dropped, per Chad.
 */
export function smsRecipients(env: any, etMin: number): string[] {
  const always = splitList(env?.FLAG_SMS_TO);
  const night = splitList(env?.FLAG_SMS_TO_NIGHT);
  const routing = etMin >= EVENING_START_HOUR * 60 || etMin < NIGHT_CUTOFF_MIN;
  const out = [...always, ...(routing ? night : [])];
  return [...new Set(out)];
}

/**
 * PURE. Which board date an evening/overnight sweep judges, given ET now.
 * From EVENING_START_HOUR onward the routers are building TOMORROW; after midnight the
 * same board has become TODAY. Outside both windows (the live day sweep's territory)
 * the answer is null — this sweep stands down rather than double-alerting.
 */
export function eveningTargetDate(etDate: string, etMin: number): { date: string; offsetDays: number } | null {
  if (etMin >= EVENING_START_HOUR * 60) {
    const d = new Date(`${etDate}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return { date: d.toISOString().slice(0, 10), offsetDays: 1 };
  }
  if (etMin < NIGHT_CUTOFF_MIN + 60) return { date: etDate, offsetDays: 0 }; // through 6:59a, before the 7:00a day sweep
  return null;
}

const fmtMin = (m: any): string => {
  if (!Number.isFinite(m)) return '?';
  const mm = ((Math.round(m) % 1440) + 1440) % 1440;
  const h12 = ((Math.floor(mm / 60) + 11) % 12) + 1;
  const ap = mm < 720 ? 'a' : 'p';
  return `${h12}:${String(mm % 60).padStart(2, '0')}${ap}`;
};

/**
 * PURE. One flag as one text. Facts only, one breath — and it always names the board
 * day, because a 9pm text about "tomorrow" and a 5am text about "today" are the same
 * board and must not read like two different problems.
 */
export function smsText(row: any, boardDate: string): string {
  const cust = String(row?.customer || row?.stopNbr || 'stop');
  const route = String(row?.routeName || '').trim();
  const late = Number.isFinite(row?.lateBy) ? ` (~${row.lateBy}m past close)` : '';
  const eta = `est ${fmtMin(row?.etaMin)} vs close ${fmtMin(row?.closeMin)}`;
  return `DDS flag ${boardDate}: ${cust}${route ? ` on ${route}` : ''} — ${eta}${late}. Auto-alert, reply to Davis dispatch.`;
}

/** PURE. The claim key: one text per stop per board day, shared across every sweep. */
export function smsClaimPath(tenant: string, date: string, stopNbr: string): string {
  return `${CLAIM_COLLECTION}/${tenant}__${date}__${String(stopNbr)}`;
}

/**
 * PURE. Which rows an evening sweep may text: the emailable rule and tiers — red and
 * critical hours_risk occurrences with a real close ("clearly obvious problems or
 * critical ones", not ambers) — worst first, capped per sweep so a pathological board
 * cannot empty the SMS allowance overnight.
 */
export function selectTextable(rows: any[], cap = SMS_PER_SWEEP_CAP): any[] {
  // Same un-collapse as the email path: on a capped board this selector saw one summary row
  // with no stopNbr and texted nobody, on exactly the night the board was worst.
  const out = flattenForConsumers(rows).filter((r) =>
    r?.rule === 'hours_risk'
    && (r?.tier === 'critical' || r?.tier === 'red')
    && r?.scope === 'occurrence'
    && r?.stopNbr != null
    && Number.isFinite(r?.closeMin));
  // `??` does not protect from NaN: `undefined ?? 0` is 0 but `NaN ?? 0` is NaN, and a NaN
  // comparator makes the whole ordering undefined — so at the 8-per-sweep cap the texts that
  // got dropped were chosen arbitrarily rather than by how late they were.
  const worst = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : -Infinity);
  out.sort((a, b) => worst(b?.lateBy) - worst(a?.lateBy));
  return out.slice(0, Math.max(0, cap));
}
