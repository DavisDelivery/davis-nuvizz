// src/lib/stop-pieces.js — the piece-count editor's rules, PURE (v1.105.0).
//
// Chad, 2026-10-02: "make it where in dispatch map i can edit an order and change piece counts
// and then send it to nuvizz to change as well".
//
// THE SERVER IS THE AUTHORITY (netlify/functions/lib/nuvizz-write-ops.mts, §P parsePieceInput):
// it re-validates everything, writes only what changes, and reads NuVizz back before anything is
// claimed. This file restates the same rule for the screen, so the button can say what is wrong
// before a call is spent. test/stop-pieces.test.mjs runs one table through both, so the two
// cannot drift apart.
//
// THE BOARD KEEPS NUVIZZ'S MISLABELLED NAMES (nuvizz-scan.mts normalizeStop):
//     cartons = pallets (skids)    volume = loose pieces    pallets = TOTAL pieces
// Everything below speaks Davis terms — pallets, loose, total — and translates at the edges.

export const PIECES_MAX = 99999;

const num = (v) => {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Board statuses whose freight is no longer the dispatcher's to change: finished (delivered,
// unable to deliver, cancelled) or already with the driver (out for delivery, arrived). The
// server refuses an executed order on NuVizz's own status whatever the board says; this only
// keeps the button off cards where it could never succeed.
const LOCKED_STATUSES = new Set(['DELIVERED', 'EXCEPTION', 'CANCELLED', 'OUT_FOR_DEL', 'ARRIVED']);

/** May the editor be offered on this card at all? */
export function piecesEditable(stop) {
  return !LOCKED_STATUSES.has(String(stop?.normalizedStatus ?? '').trim().toUpperCase());
}

/** The order's counts as the board row holds them, in Davis terms. Null = no value on file. */
export function boardPiecesOf(stop) {
  return { pallets: num(stop?.cartons), loose: num(stop?.volume), total: num(stop?.pallets) };
}

/** A count as typed: a whole number 0..PIECES_MAX, or null when it is not one. */
function wholeCount(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n <= PIECES_MAX ? n : null;
}

/**
 * What the two boxes say → the counts to send, or why they cannot be sent. Pallets is required
 * (0 is a real answer: an order of loose pieces only); loose may be blank for none; the total is
 * pallets + loose and is never typed. No pieces at all is refused — that order wants cancelling.
 */
export function parsePieceDraft(pallets, loose) {
  const p = wholeCount(pallets);
  if (p == null) return { error: `pallets must be a whole number from 0 to ${PIECES_MAX} (type 0 if there are none)` };
  const l = loose == null || String(loose).trim() === '' ? 0 : wholeCount(loose);
  if (l == null) return { error: `loose must be a whole number from 0 to ${PIECES_MAX}, or blank for none` };
  const total = p + l;
  if (total < 1) return { error: 'an order with no pallets and no loose pieces is not freight to deliver — cancel the order instead of setting it to zero' };
  if (total > PIECES_MAX) return { error: `pallets + loose comes to ${total}, over NuVizz's limit of ${PIECES_MAX}` };
  return { pallets: p, loose: l, total };
}

/** Would sending `want` change anything the card shows? The server's own rule: a null and a 0
 *  are both "none" for pallets and loose; the total compares exactly. */
export function piecesChanged(cur, want) {
  if (!want || want.error) return false;
  return (cur?.pallets ?? 0) !== want.pallets || (cur?.loose ?? 0) !== want.loose || (cur?.total ?? null) !== want.total;
}

/** "6 pallets · 2 loose · 8 pieces". */
export function piecesLine(p) {
  const pallets = p?.pallets ?? 0;
  const loose = p?.loose ?? 0;
  const parts = [`${pallets} pallet${pallets === 1 ? '' : 's'}`];
  if (loose) parts.push(`${loose} loose`);
  parts.push(p?.total == null ? 'no total on file' : `${p.total} piece${p.total === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The board days a Send asks the server to patch: the day this row is STORED under first, then
 * the day it is shown on. They differ for a carried-over row, which is served on today's board
 * but lives in the day it came from (carryover-fold.mts: boardDate = served, scheduledDate = own).
 */
export function piecesBoardDatesOf(stop) {
  const out = [];
  const add = (v) => { const d = String(v ?? '').slice(0, 10); if (DAY.test(d) && !out.includes(d)) out.push(d); };
  if (stop?.carryover) add(stop?.scheduledDate);
  add(stop?.boardDate);
  add(stop?.scheduledDate);
  return out.slice(0, 3);
}

/**
 * The fields to fold into the open card from a CONFIRMED answer — NuVizz's read-back as the
 * server wrote it to the board row (`boardFields`), never what was typed. Pallets and loose go
 * in as 0 rather than null: the card's fold skips nulls, and a loose count that went to none
 * must not keep showing the old number.
 */
export function piecesFoldFrom(out) {
  const f = out?.boardFields;
  if (!f || typeof f !== 'object') return null;
  const fold = {
    cartons: num(f.cartons) ?? 0,
    volume: num(f.volume) ?? 0,
    itemsSummary: f.itemsSummary || '—',
  };
  if (num(f.pallets) != null) fold.pallets = num(f.pallets);
  if (out?.stopId) fold.stopId = String(out.stopId);
  return fold;
}

/** The line the editor shows for a server answer: { kind: 'ok' | 'warn' | 'err', text }. */
export function piecesOutcome(r) {
  const out = r?.result || r || {};
  if (!r?.ok) return { kind: 'err', text: r?.error || out.error || 'Could not change the piece counts.' };
  const warn = out.boardWarning ? ` ${out.boardWarning}` : '';
  if (out.unchanged) return { kind: out.boardWarning ? 'warn' : 'ok', text: out.message || `NuVizz already has ${piecesLine(out.now)} — nothing was sent.` };
  const was = out.was ? ` (was ${piecesLine(out.was)})` : '';
  return { kind: out.boardWarning ? 'warn' : 'ok', text: `Saved in NuVizz — it now reads ${piecesLine(out.now)}${was}.${warn}` };
}
