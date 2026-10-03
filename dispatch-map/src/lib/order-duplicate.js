// src/lib/order-duplicate.js — the Duplicate panel's rules, PURE (v1.107.0).
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

import { parsePieceDraft, piecesLine, boardPiecesOf } from './stop-pieces.js';
import { resolveStopPhone } from './stop-contact.js';

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
  const own = ownDay(stop);
  return own && own >= today ? own : today;
}

/** The original's own day as the board row holds it, or '' when it holds none. */
function ownDay(stop) {
  return [stop?.scheduledFrom, stop?.scheduledDate, stop?.boardDate]
    .map((v) => String(v ?? '').slice(0, 10)).find((d) => DAY.test(d)) || '';
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

// ── EDIT THE COPY BEFORE IT IS CREATED (§DUP-E, v1.109.0) ─────────────────────
// Chad, 10/03: "when I duplicate I want to have the option to edit the order. Addresses numbers
// piece counts items pretty much anything." The form opens on what the CARD shows (a corrected
// address from customer notes, the number the card would dial); only what differs from the
// original's own NuVizz values (the board row) is sent, so a field left alone is copied by the server
// exactly as before. The server's rules are nuvizz-write-ops.mts parseDuplicateEdits/parseCopyNumber.

/** The fields the copy can change, in form order, with the words the panel uses for them. */
export const DUPLICATE_FIELDS = [
  { key: 'name', label: 'consignee', required: true },
  { key: 'addr1', label: 'street address', required: true },
  { key: 'addr2', label: 'address line 2' },
  { key: 'city', label: 'city', required: true },
  { key: 'state', label: 'state', required: true },
  { key: 'zip', label: 'ZIP', required: true },
  { key: 'phone', label: 'phone' },
  { key: 'email', label: 'email' },
  { key: 'itemDesc', label: 'items' },
  { key: 'dispatchNotes', label: 'driver instructions' },
  { key: 'price', label: 'price' },
];

const t = (v) => (v == null ? '' : String(v).trim());
const firstProduct = (stop) => {
  const line = (Array.isArray(stop?.stopDetails) ? stop.stopDetails : []).find((d) => d && t(d.product));
  return line ? t(line.product) : '';
};

/** What the original holds in NuVizz, as the board row knows it — the server copies these. */
export function duplicateBaseline(stop) {
  return {
    name: t(stop?.businessName), addr1: t(stop?.addr1), addr2: t(stop?.addr2), city: t(stop?.city),
    state: t(stop?.state), zip: t(stop?.zip), phone: t(stop?.contact?.phone), email: t(stop?.contact?.email),
    itemDesc: firstProduct(stop), dispatchNotes: t(stop?.signalSources?.orderInstructions), price: '',
  };
}

/** The form as it opens: what the CARD shows — its corrected address and the number it would dial. */
export function duplicateFormFrom(stop, note) {
  const base = duplicateBaseline(stop);
  const ov = note?.address_override || null;
  return {
    ...base,
    // The same expressions the card's Address block uses (App.jsx StopDataSections).
    addr1: t(ov?.addr1 || stop?.addr1),
    addr2: t(ov?.addr2 ?? stop?.addr2),
    city: t(ov?.city ?? stop?.city),
    state: t(ov?.state ?? stop?.state),
    zip: t(ov?.zip ?? stop?.zip),
    phone: t(resolveStopPhone(stop, note)) || base.phone,
    copyNbr: '',
  };
}

const same = (key, a, b) => {
  const x = t(a); const y = t(b);
  if (key === 'state') return x.toUpperCase() === y.toUpperCase();
  if (key === 'phone') return x.replace(/\D/g, '') === y.replace(/\D/g, '');
  if (key === 'email') return x.toLowerCase() === y.toLowerCase();
  return x === y;
};

/** Only what the copy changes: { field: value } for each field that differs from the original's. */
export function duplicateEdits(form, baseline) {
  const out = {};
  for (const f of DUPLICATE_FIELDS) {
    if (f.key === 'price') { if (t(form?.price)) out.price = t(form.price); continue; }
    if (!same(f.key, form?.[f.key], baseline?.[f.key])) out[f.key] = t(form?.[f.key]);
  }
  return out;
}

/** The changed fields in the panel's own words, for the line that says what the copy changes. */
export const duplicateEditLabels = (edits) =>
  DUPLICATE_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(edits || {}, f.key)).map((f) => f.label);

/** The copy's own boxes, in the panel's words: its counts, weight and day. */
const COUNT_LABELS = { pallets: 'pallets', loose: 'loose pieces', weight: 'weight', date: 'delivery day' };

/**
 * Which of the copy's counts, weight and day differ from the original's (the board row), so the
 * line that says what the copy changes does not leave out the pallets just typed. The pieces
 * rule is the editor's own (piecesChanged): a null and a 0 are both none. A blank weight keeps
 * the original's, so it never differs. With no day on the original, the day is not claimed.
 */
export function duplicateCountChanges(stop, draft) {
  if (!draft || draft.error) return [];
  const cur = boardPiecesOf(stop);
  const out = [];
  if ((cur.pallets ?? 0) !== draft.pallets) out.push('pallets');
  if ((cur.loose ?? 0) !== draft.loose) out.push('loose');
  if (draft.weight != null) {
    const w = String(stop?.weight ?? '').trim();
    if (w === '' || Number(w) !== draft.weight) out.push('weight');
  }
  const own = ownDay(stop);
  if (own && draft.date !== own) out.push('date');
  return out;
}

/** Everything the copy changes, in the panel's words and in the form's order. */
export function duplicateChangeLabels(edits, countKeys = []) {
  const out = [];
  for (const f of DUPLICATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(edits || {}, f.key)) out.push(f.label);
    if (f.key === 'itemDesc') for (const k of Object.keys(COUNT_LABELS)) if (countKeys.includes(k)) out.push(COUNT_LABELS[k]);
  }
  return out;
}

/** A typed number for the copy, checked as the server checks it; blank keeps the next free -N. */
export function copyNbrDraft(v) {
  const s = t(v);
  if (!s) return { nbr: null };
  if (s.length > 20) return { error: `order number ${s} is longer than NuVizz's 20 characters` };
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/.test(s)) return { error: `order number '${s}' has characters NuVizz does not take — letters, digits, dashes` };
  return { nbr: s };
}

/** The whole form checked before a call is spent — the address must still be a whole address. */
export function duplicateFormError(form) {
  for (const f of DUPLICATE_FIELDS) {
    if (f.required && !t(form?.[f.key])) return `the copy needs a ${f.label}`;
  }
  if (!/^\d{5}(-\d{4})?$/.test(t(form?.zip))) return `'${t(form?.zip)}' is not a ZIP — 5 digits, or ZIP+4`;
  const c = copyNbrDraft(form?.copyNbr);
  if (c.error) return c.error;
  if (t(form?.price).length > 20) return 'the price is longer than NuVizz takes (20 characters)';
  return null;
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
      text: `Created ${out.stopNbr} in NuVizz${replay} — ${piecesLine(out.now)}${day}, unplanned${Array.isArray(out.edited) && out.edited.length ? `, with your changes to its ${duplicateEditLabels(Object.fromEntries(out.edited.map((k) => [k, true]))).join(', ')}` : ''}. It reaches the board through the scans, as a New Order does; plan it in Routing.${notes}`,
    };
  }
  if (out.created) return { kind: 'warn', created: true, nbr: out.stopNbr, text: (r?.error || out.error || `${out.stopNbr} was created but could not be verified.`) + replay };
  return { kind: 'err', created: false, nbr: null, text: r?.error || out.error || 'Could not duplicate the order.' };
}
