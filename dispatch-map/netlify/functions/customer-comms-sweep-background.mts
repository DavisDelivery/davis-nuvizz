// customer-comms-sweep-background.mts
//
// THE TRIGGER. Chad: "wire up the trigger now."
//
// The delivery-complete email engine has been complete and dark since v0.54.78:
// lib/customer-comms.mts carries the recipient decision, the per-customer
// opt-out, the one-email-per-PRO ledger, the daily cap, the failure circuit and
// the per-day status record, with 480-odd lines of tests behind them. What it
// never had was a caller. `sweepDelivered` was exported and invoked by nothing,
// and the screen said so honestly: "even switched on, nothing sends on its own
// today". This file is that caller, and it is deliberately the whole of the
// change — every guard it relies on already existed and was already tested.
//
// WHY THIS IS SAFE TO DEPLOY BEFORE IT IS SAFE TO ENABLE. sweepDelivered
// returns `disabled` while the config toggle is off, so merging this sends
// nothing. The toggle, not the deploy, is what starts the mail.
//
// THE ORDER OF THE TWO READS MATTERS. Config first, board second. A board read
// is a full day's stop index — several hundred documents — and running it every
// thirty minutes for ever, only to discover the feature is switched off, would
// be a permanent Firestore bill for a permanent no-op. readConfig() is one
// document, and it fails CLOSED: an unreachable Firestore yields DEFAULT_CONFIG,
// whose `enabled` is false, so a Firestore outage stops the mail rather than
// starting it.
//
// ZERO NUVIZZ CALLS, EVER. The stops come from readStops(), which reads the
// cached board this app already maintains. Nothing here can reach the vendor —
// which is the point, because a scan costs ~3,000 vendor calls and this runs
// forty-eight times a day.
//
// EVERY-30-MINUTES, matching the manifest ingest. Deliveries land all day and
// the board behind them refreshes every 15, so a half-hourly sweep puts a
// customer's email in front of them within about half an hour of the freight
// landing, while keeping each run small. It is also DST-proof by construction:
// an interval schedule has no opinion about whether ET is UTC-4 or UTC-5 today,
// where a fixed-hour cron would silently shift by an hour twice a year.
//
// EACH DATE IS SWEPT INDEPENDENTLY. A thrown board read on yesterday must not
// cost today its run — today is the date carrying the customers who are waiting.

import { isFirestoreEnabled, readStops } from './lib/firestore.mts';
import { readConfig, sweepDates, sweepDelivered } from './lib/customer-comms.mts';

const TENANT = 'davis';

export default async (): Promise<Response> => {
  if (!isFirestoreEnabled()) return Response.json({ ok: true, skipped: 'firestore off' });

  // The cheap gate, before the expensive read. See the note above on fail-closed.
  const cfg = await readConfig();
  if (!cfg.enabled) return Response.json({ ok: true, ran: false, reason: 'disabled' });

  const dates = sweepDates();
  const runs: Record<string, any> = {};

  // ONE CEILING ACROSS BOTH DATES. Each date keeps its own ledger, so each would otherwise
  // start with a full cfg.dailyCap of its own — and in the early-hours window this loop runs
  // two of them, so a cap of N could send 2N inside one calendar day. The enable dialog
  // promises "up to N a day" in as many words. Today is swept first (see sweepDates), so
  // when the allowance runs out it is yesterday's stragglers that wait for tomorrow, not
  // today's customers.
  let remaining = cfg.dailyCap;

  for (const date of dates) {
    if (remaining <= 0) { runs[date] = { ran: false, sent: 0, failed: 0, skipped: {}, reason: 'run_cap_reached' }; continue; }
    try {
      const { stops } = await readStops(TENANT, date);
      const r = await sweepDelivered(stops, date, { budgetCeiling: remaining });
      runs[date] = r;
      remaining -= (r?.sent || 0);
    } catch (e: any) {
      // Fail CLOSED and LOUD: no send happened, and the next run retries. Swallowing
      // this silently is how a feature becomes an invisible no-op, which is the exact
      // failure the per-day status record exists to prevent.
      runs[date] = { ran: false, sent: 0, failed: 0, skipped: {}, reason: 'board_read_failed', error: String(e?.message || e) };
      console.warn(`[customer-comms-sweep] ${date}: board read failed: ${e?.message}`);
    }
  }

  const sent = Object.values(runs).reduce((n: number, r: any) => n + (r?.sent || 0), 0);
  const failed = Object.values(runs).reduce((n: number, r: any) => n + (r?.failed || 0), 0);
  // Quiet on a nothing-happened cycle — forty-eight log lines a day saying "0 sent"
  // is how the one line that matters gets scrolled past.
  if (sent || failed) console.log('[customer-comms-sweep]', JSON.stringify({ dates, sent, failed, runs }));

  return Response.json({ ok: true, dates, sent, failed, runs });
};

export const config = {
  schedule: '*/30 * * * *',
};
