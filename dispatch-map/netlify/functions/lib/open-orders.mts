// lib/open-orders.mts — the 5:30p open-orders email to customer service. PURE.
//
// Chad, 2026-09-29: "I want to send them an email of everything that's been undelivered that
// is planned, not unplanned, but that is planned that's not been delivered. And we want to
// send that at 5:30. So at 5:25, I want to run a refresh scan so that everything and all the
// data is fresh." And: "the 530 is just showing planned orders that are still undelivered
// which is a little different than the 630 email."
//
// WHO ACTS ON IT: customer service, with an hour of the business day left — the consignee
// who is expecting freight that is still on a truck, or that came back, can be called before
// they close. So this is a work list, one row per ORDER (PRO), not the 6:30 report's
// per-stop summary: two orders for one dock are two PROs a caller may be asked about.
//
// WHICH ORDERS — the same rules as the 6:30 report (lib/day-completion.mts), so the two
// emails cannot disagree about what is open:
//   * PLANNED only: isPlanned false is respected, otherwise a stop with a route is planned.
//   * UNDELIVERED = stopOutcome not delivered and not cancelled. A cancelled order was pulled,
//     not missed. A refused / exception stop (unable) IS listed — it did not get there.
//   * Closed on another day's board (closedOnBoard) is not open.
//   * CHAD and appointment routes (ULINE APPT) are left out — isExcludedRoute, the 6:30's own
//     rule. Freight on ULINE APPT is being held for an appointment, not late.
import { stopOutcome, isDeliveredOutcome, isExcludedRoute, excludedRouteNames, type Outcome } from './day-completion.mts';

export const SEND_HOUR_ET = 17;
export const SEND_MINUTE_ET = 30;
/** The pinned scan it waits for (scan-plan.mts PINNED_SCANS 'pre-open-orders', 5:25p). */
export const FRESH_FROM_MINUTE_ET = 17 * 60 + 20;
/** Past this, send on whatever the board holds and say how old it is — late beats never. */
export const SEND_DEADLINE_MINUTE_ET = 17 * 60 + 45;
/** Last minute a firing may still send. After it, the day is left alone. */
export const SEND_WINDOW_END_MINUTE_ET = 18 * 60;

const str = (v: any) => String(v ?? '').trim();

export interface OpenOrder {
  pro: string; customer: string | null; addr: string | null; city: string | null;
  route: string | null; driver: string | null; seq: number | null;
  outcome: Outcome; status: string;
}
export interface OpenOrders {
  date: string;
  planned: number;       // planned orders counted (set-aside routes and cancellations out)
  delivered: number;
  open: OpenOrder[];
  excludedRoutes: string[];
}

const STATUS_WORDS: Partial<Record<Outcome, string>> = {
  not_attempted: 'Not delivered yet',
  in_flight: 'Out for delivery / on site',
  unable: 'Attempted — not delivered',
};

export function buildOpenOrders(
  stops: any[],
  { date, excludeRoutes = excludedRouteNames() }: { date: string; excludeRoutes?: string[] },
): OpenOrders {
  const open: OpenOrder[] = [];
  const seen = new Set<string>();
  const excluded = new Set<string>();
  let planned = 0;
  let delivered = 0;
  for (const s of stops || []) {
    // Same planned test as buildDayCompletion.
    const isPlanned = s?.isPlanned === false ? false : (s?.isPlanned === true || !!str(s?.loadNbr || s?.routeName));
    if (!isPlanned) continue;
    const closedOn = str(s?.closedOnBoard);
    if (closedOn && closedOn !== date) continue;
    const route = str(s?.loadNbr || s?.routeName);
    if (isExcludedRoute(route, excludeRoutes)) { excluded.add(route); continue; }
    const outcome = stopOutcome(s);
    if (outcome === 'cancelled') continue;
    const pro = str(s?.pro) || str(s?.stopNbr);
    // One row per order. A duplicated board row for the same PRO is one order, not two.
    if (pro && seen.has(pro)) continue;
    if (pro) seen.add(pro);
    planned += 1;
    if (isDeliveredOutcome(outcome)) { delivered += 1; continue; }
    const seq = Number(s?.routeSeq ?? s?.raw?.stop?.to?.seq);
    open.push({
      pro,
      customer: s?.businessName ?? null,
      addr: str(s?.addr1) || null,
      city: [str(s?.city), str(s?.state)].filter(Boolean).join(', ') || null,
      route: route || null,
      driver: str(s?.driverName || s?.driverUserName) || null,
      seq: Number.isFinite(seq) ? seq : null,
      outcome,
      status: STATUS_WORDS[outcome] || outcome,
    });
  }
  open.sort((a, b) => String(a.route).localeCompare(String(b.route)) || ((a.seq ?? 1e9) - (b.seq ?? 1e9)) || a.pro.localeCompare(b.pro));
  return { date, planned, delivered, open, excludedRoutes: [...excluded].sort() };
}

/**
 * PURE. Should this firing send, wait, or leave the day alone?
 *
 * WAIT FOR THE 5:25 SCAN, but not for ever. `stamps` are the scanner's per-kind clocks; the
 * board is fresh when BOTH lists have been pulled since 5:20p ET today. The floor can push
 * the pinned scan to 5:30 or 5:35, so before SEND_DEADLINE a stale board waits for the next
 * firing; at the deadline it sends anyway and the email says how old the board is.
 */
/** PURE. Is this ET instant inside the weekday 5:30–6:00p send window at all? Checked before any read. */
export function inSendWindow(weekday: number, hour: number, minute: number): boolean {
  const m = hour * 60 + minute;
  return weekday >= 1 && weekday <= 5 && m >= SEND_HOUR_ET * 60 + SEND_MINUTE_ET && m < SEND_WINDOW_END_MINUTE_ET;
}

export function sendDecision(opts: {
  weekday: number; hour: number; minute: number; nowMs: number;
  stamps: Record<string, string | null | undefined>;
  alreadySent: boolean;
}): { action: 'send' | 'wait' | 'skip'; fresh: boolean; reason: string } {
  const { weekday, hour, minute, nowMs, stamps, alreadySent } = opts;
  const nowMin = hour * 60 + minute;
  if (weekday < 1 || weekday > 5) return { action: 'skip', fresh: false, reason: 'weekend' };
  if (nowMin < SEND_HOUR_ET * 60 + SEND_MINUTE_ET) return { action: 'skip', fresh: false, reason: 'before 5:30p ET' };
  if (nowMin >= SEND_WINDOW_END_MINUTE_ET) return { action: 'skip', fresh: false, reason: 'past the 5:30p window' };
  if (alreadySent) return { action: 'skip', fresh: false, reason: 'already sent today' };
  const freshFromMs = nowMs - (nowMin - FRESH_FROM_MINUTE_ET) * 60000 - (((nowMs % 60000) + 60000) % 60000);
  const at = (k: string) => { const t = stamps?.[k] ? Date.parse(String(stamps[k])) : NaN; return Number.isFinite(t) ? t : -Infinity; };
  const fresh = at('planned') >= freshFromMs && at('completed') >= freshFromMs;
  if (fresh) return { action: 'send', fresh, reason: 'board scanned since 5:20p' };
  if (nowMin >= SEND_DEADLINE_MINUTE_ET) return { action: 'send', fresh, reason: 'no scan since 5:20p by 5:45p — sending on the board as it stands' };
  return { action: 'wait', fresh, reason: 'waiting for the 5:25p scan' };
}

/** Once-a-day record: sentAt only after the mailer confirms. */
export const openOrdersPath = (date: string, tenant = 'davis') => `nuvizz_ops/open_orders_email__${tenant}__${date}`;

export function openOrdersEmailEnabled(env: any = process.env): boolean {
  const v = String(env?.OPEN_ORDERS_EMAIL ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

export function etClock(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return {
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')),
  };
}

/** "5:27p" on the ET clock, for the email's "board last scanned" line. */
export function etTime(iso: string | null | undefined): string | null {
  const t = iso ? new Date(String(iso)) : null;
  if (!t || !Number.isFinite(t.getTime())) return null;
  const { hour, minute } = etClock(t);
  return `${((hour + 11) % 12) + 1}:${String(minute).padStart(2, '0')}${hour < 12 ? 'a' : 'p'} ET`;
}

/** The older of the two list stamps — the board is only as fresh as its stalest half. */
export function boardAsOf(stamps: Record<string, any>): string | null {
  const ts = ['planned', 'completed'].map((k) => (stamps?.[k] ? Date.parse(String(stamps[k])) : NaN));
  if (ts.some((t) => !Number.isFinite(t))) return null;
  return new Date(Math.min(...ts)).toISOString();
}

const esc = (v: any) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export function openOrdersSubject(r: OpenOrders): string {
  const n = r.open.length;
  return n
    ? `Open orders 5:30p ${r.date} — ${n} planned deliver${n === 1 ? 'y' : 'ies'} not delivered yet`
    : `Open orders 5:30p ${r.date} — every planned delivery is delivered`;
}

function headline(r: OpenOrders, boardAsOf: string | null): string[] {
  const lines = [
    `${r.delivered} of ${r.planned} planned deliveries delivered; ${r.open.length} still open.`,
    boardAsOf ? `Board last scanned ${boardAsOf}.` : 'Board scan time unknown.',
  ];
  if (r.excludedRoutes.length) lines.push(`Not included: ${r.excludedRoutes.join(', ')} (owner / appointment routes).`);
  return lines;
}

export function openOrdersText(r: OpenOrders, boardAsOf: string | null): string {
  const out = headline(r, boardAsOf);
  out.push('');
  for (const o of r.open) {
    out.push(`${o.pro}  ${o.customer || '(no name)'}  ${o.city || ''}  | ${o.route || '—'}${o.driver ? ' · ' + o.driver : ''}  | ${o.status}`);
  }
  return out.join('\n');
}

export function openOrdersHtml(r: OpenOrders, boardAsOf: string | null): string {
  const td = 'style="padding:4px 8px;border-bottom:1px solid #e2e8f0;font-size:13px;vertical-align:top"';
  const th = 'style="padding:4px 8px;border-bottom:2px solid #cbd5e1;font-size:12px;text-align:left;color:#475569"';
  const rows = r.open.map((o) => `<tr><td ${td}><b>${esc(o.pro)}</b></td><td ${td}>${esc(o.customer || '(no name)')}<br><span style="color:#64748b">${esc([o.addr, o.city].filter(Boolean).join(' · '))}</span></td><td ${td}>${esc(o.route || '—')}${o.driver ? `<br><span style="color:#64748b">${esc(o.driver)}</span>` : ''}</td><td ${td}>${esc(o.status)}</td></tr>`).join('');
  const head = headline(r, boardAsOf).map((l) => `<p style="margin:0 0 4px;font-size:14px">${esc(l)}</p>`).join('');
  const table = r.open.length
    ? `<table style="border-collapse:collapse;margin-top:12px;width:100%"><thead><tr><th ${th}>PRO</th><th ${th}>Customer</th><th ${th}>Route / driver</th><th ${th}>Status</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p style="margin-top:12px;font-size:14px">Nothing open.</p>';
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a">${head}${table}</div>`;
}
