// src/lib/order-duplicate.js — the Duplicate panel's rules, PURE (v1.106.0).
//
// Chad, 2026-10-02: "make it where i can duplicate an order essentially we can do it as creating a
// new order and way we make the pro number is its original pro-1 then if we duplicate the same
// order twice it would be original pro-2 so on an so forth."
//
// THE SERVER DECIDES (netlify/functions/lib/nuvizz-write.mts runDuplicateOrder): it reads the
// original, finds the first {original}-N NuVizz answers NOT FOUND, creates it and reads it back.
// This file only says on screen what that will be, in the server's own terms; the number rule is
// restated from nuvizz-write-ops.mts copyBaseNbr, and test/order-duplicate.test.mjs runs both over
// one table so they cannot drift.

import { parsePieceDraft, piecesLine } from './stop-pieces.js';

/** The ORIGINAL order number a duplicate is numbered from — see copyBaseNbr on the server.
 *  007174789-1 → 007174789; ESTES-0538243875 stays whole (a carrier id is one identifier). */
export function copyBaseNbr(stopNbr) {
  const s = String(stopNbr ?? '').trim();
  const m = /^(.*\d)-(\d{1,2})$/.exec(s);
  return m ? m[1] : s;
}

/** Can this card be duplicated here at all? Pickups cannot: the copy is built as a delivery. */
export function duplicateEligible(stop) {
  if (!String(stop?.stopNbr ?? stop?.pro ?? '').trim()) return false;
  return String(stop?.stopType ?? 'DO').trim().toUpperCase() !== 'PU';
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Today in Eastern time — the day the server measures "already gone" against. */
export function etToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
}

/**
 * The delivery day the panel opens on: the original's own day, or today when that day has gone —
 * a copy of last week's order is for delivering now, and the server refuses a day already past.
 */
export function defaultCopyDate(stop, today) {
  const own = [stop?.scheduledFrom, stop?.scheduledDate, stop?.boardDate]
    .map((v) => String(v ?? '').slice(0, 10)).find((d) => DAY.test(d)) || '';
  return own && own >= today ? own : today;
}

/** The weight box: blank keeps the original's; otherwise a number of pounds from 0 up. */
export function parseCopyWeight(v) {
  if (v == null || String(v).trim() === '') return { weight: null };
  const s = String(v).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return { error: 'weight must be a number of pounds from 0 up, or blank to keep the original order\'s' };
  const n = Number(s);
  return Number.isFinite(n) && n <= 9999999999 ? { weight: n } : { error: 'weight is out of range' };
}

/** Everything the panel needs to know before a call is spent: the counts, the weight, the day. */
export function duplicateDraft({ pallets, loose, weight, date }, today) {
  const p = parsePieceDraft(pallets, loose);
  if (p.error) return { error: p.error };
  const w = parseCopyWeight(weight);
  if (w.error) return { error: w.error };
  if (!DAY.test(String(date ?? ''))) return { error: 'pick the delivery day for the copy' };
  if (today && date < today) return { error: `${date} has already gone — a new order goes on today or a later day` };
  return { pallets: p.pallets, loose: p.loose, total: p.total, weight: w.weight, date };
}

/**
 * The line the panel shows for a server answer: { kind: 'ok' | 'warn' | 'err', text, created, nbr }.
 * `created` is true whenever NuVizz confirmed the create — including the unverified case, where the
 * order exists and pressing again would make a second copy, which the text says.
 */
export function duplicateOutcome(r) {
  const out = r?.result || r || {};
  const replay = r?.idempotent === true ? ' (an earlier try of this same request had already made it — nothing new was sent)' : '';
  if (out.created && out.ok) {
    const day = out.deliveryDate ? ` for ${out.deliveryDate}` : '';
    const notes = Array.isArray(out.warnings) && out.warnings.length ? ` Note: ${out.warnings.join('; ')}.` : '';
    return {
      kind: 'ok', created: true, nbr: out.stopNbr,
      text: `Created ${out.stopNbr} in NuVizz${replay} — ${piecesLine(out.now)}${day}, unplanned. It reaches the board through the scans, as a New Order does; plan it in Routing.${notes}`,
    };
  }
  if (out.created) return { kind: 'warn', created: true, nbr: out.stopNbr, text: (r?.error || out.error || `${out.stopNbr} was created but could not be verified.`) + replay };
  return { kind: 'err', created: false, nbr: null, text: r?.error || out.error || 'Could not duplicate the order.' };
}
