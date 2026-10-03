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
  // v1.111.0: no 'itemDesc' — the Items drawer edits the copy's lines themselves (§DUP-L below).
  { key: 'dispatchNotes', label: 'driver instructions' },
  { key: 'price', label: 'price' },
];

const t = (v) => (v == null ? '' : String(v).trim());

/** What the original holds in NuVizz, as the board row knows it — the server copies these. */
export function duplicateBaseline(stop) {
  return {
    name: t(stop?.businessName), addr1: t(stop?.addr1), addr2: t(stop?.addr2), city: t(stop?.city),
    state: t(stop?.state), zip: t(stop?.zip), phone: t(stop?.contact?.phone), email: t(stop?.contact?.email),
    dispatchNotes: t(stop?.signalSources?.orderInstructions), price: originalPrice(stop),
    lines: duplicateLinesFrom(stop),
  };
}

/** The original's price as the board row holds it: NuVizz's Seal # (sealNbr), kept inside `raw` by
 *  every enrichment and served to the Map feed (board-fields.mts 'raw.stop.sealNbr'). '' = not held. */
export function originalPrice(stop) {
  return t(stop?.raw?.stop?.sealNbr);
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
    // v1.110.0 — Chad: "put the original price in the box but leave the copy to duplicate unchecked
    // default and also make it an editable field". The box opens on the original's price; nothing
    // goes on the copy until the tick is set.
    priceOn: false,
    notes: [],
    // v1.111.0 — the Items drawer opens on the original's lines (§DUP-L).
    lines: duplicateLinesFrom(stop),
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
    if (f.key === 'price') { if (form?.priceOn && t(form?.price)) out.price = t(form.price); continue; }
    if (!same(f.key, form?.[f.key], baseline?.[f.key])) out[f.key] = t(form?.[f.key]);
  }
  return out;
}

/** The changed fields in the panel's own words, for the line that says what the copy changes. */
export const duplicateEditLabels = (edits) =>
  DUPLICATE_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(edits || {}, f.key)).map((f) => f.label);

/** The copy's own boxes, in the panel's words: its item lines, counts, weight and day. */
const COUNT_LABELS = { lines: 'item lines', pallets: 'pallets', loose: 'loose pieces', weight: 'weight', date: 'delivery day' };

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
export function duplicateChangeLabels(edits, countKeys = [], baseline = null) {
  const out = [];
  for (const f of DUPLICATE_FIELDS) {
    // The original's own price put on the copy is a copy, not a change — the price line says it.
    if (f.key === 'price' && baseline && t(edits?.price) === t(baseline.price)) continue;
    // The freight — item lines, counts, weight, day — reads before the driver instructions.
    if (f.key === 'dispatchNotes') for (const k of Object.keys(COUNT_LABELS)) if (countKeys.includes(k)) out.push(COUNT_LABELS[k]);
    if (Object.prototype.hasOwnProperty.call(edits || {}, f.key)) out.push(f.label);
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

/**
 * The whole form checked before a call is spent — what the dispatcher CHANGED must still make a
 * whole address. A field left as it opened is not sent: the server copies the original's own
 * NuVizz value and refuses an original with no complete address itself (buildDuplicateStop). So a
 * board row with no state (the list carries none; only the enrichment fills it) or an odd ZIP does
 * not block a copy the server would make. Without a baseline every field counts as changed.
 */
export function duplicateFormError(form, baseline) {
  const changed = (k) => !baseline || !same(k, form?.[k], baseline?.[k]);
  for (const f of DUPLICATE_FIELDS) {
    if (f.required && changed(f.key) && !t(form?.[f.key])) return `the copy needs a ${f.label}`;
  }
  if (changed('zip') && !/^\d{5}(-\d{4})?$/.test(t(form?.zip))) return `'${t(form?.zip)}' is not a ZIP — 5 digits, or ZIP+4`;
  const c = copyNbrDraft(form?.copyNbr);
  if (c.error) return c.error;
  if (form?.priceOn && t(form?.price).length > 20) return 'the price is longer than NuVizz takes (20 characters)';
  const n = duplicateNotesDraft(form?.notes);
  if (n.error) return n.error;
  const l = duplicateLinesDraft(form?.lines);
  if (l.error) return l.error;
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
      text: `Created ${out.stopNbr} in NuVizz${replay} — ${piecesLine(out.now)}${day}, unplanned${Array.isArray(out.edited) && out.edited.length ? `, with your changes to its ${duplicateEditLabels(Object.fromEntries(out.edited.map((k) => [k, true]))).join(', ')}` : ''}${out.notesAdded ? `, ${out.notesAdded} new note${out.notesAdded === 1 ? '' : 's'}` : ''}${Number.isInteger(out.lines) ? (out.lines ? `, ${out.lines} item line${out.lines === 1 ? '' : 's'}` : ', no item lines') : ''}${out.price ? `, price ${out.price}` : (out.price === null ? ', no price' : '')}. It reaches the board through the scans, as a New Order does; plan it in Routing.${notes}`,
    };
  }
  if (out.created) return { kind: 'warn', created: true, nbr: out.stopNbr, text: (r?.error || out.error || `${out.stopNbr} was created but could not be verified.`) + replay };
  return { kind: 'err', created: false, nbr: null, text: r?.error || out.error || 'Could not duplicate the order.' };
}

// ── THE WINDOW'S READ-ONLY STRIP (v1.109.1) ───────────────────────────────────
// Chad, 10/03: "if i click duplicate order i want a large floating window … so i can see the full
// route profile when duplicating with all the fields i can change." What the form does NOT edit is
// shown too, as the copy will carry it (nuvizz-write-ops.mts buildDuplicateStop): the delivery
// window's times on the day picked, the pickup, the PO and Cust # references — and what is not
// copied at all. Values are the board row's; where the row holds nothing, the server still copies
// the original's own, so the strip says that instead of a blank.

/** '2026-10-03T08:00:00' → '8:00 AM', or '' for anything without a clock time. */
export function clockOf(v) {
  const m = /T(\d{2}):(\d{2})/.exec(String(v ?? ''));
  if (!m) return '';
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * The original's facts the copy takes as they are, in the panel's words: [{ key, label, value }].
 * The window shows only when the row holds BOTH ends (the enrichment's schedule.timeFrom/timeTo — a
 * list-only row's scheduledFrom is its estimated arrival, with no end). The PO follows the server:
 * buildStopPayload writes "PRO <copy number>" and buildDuplicateStop keeps the original's reference1
 * over it unless that is New Order's own "PRO <original number>". The board row cannot say "none":
 * the list carries no references and mergeEnrich skips an empty one, so an empty PO or Cust # on the
 * row is "the original's, if any", never a claim that it has none.
 */
export function duplicateCopiedFacts(stop, copyNbr) {
  const from = clockOf(stop?.scheduledFrom);
  const to = stop?.scheduledTo ? clockOf(stop.scheduledTo) : '';
  const strict = t(stop?.timeConstraint).toUpperCase() === 'STRICT';
  // The Map feed serves the original's own pickup block (board-fields.mts 'raw.stop.from'), never `origin`.
  const o = stop?.origin || stop?.raw?.stop?.from?.address || null;
  const place = [t(o?.city), t(o?.state)].filter(Boolean).join(' ');
  const pickup = [t(o?.name), t(o?.addr1), place].filter(Boolean).join(', ');
  const po = t(stop?.poRef);
  const own = /^PRO\s+/i.test(po) && po.replace(/^PRO\s+/i, '').trim() === t(stop?.stopNbr ?? stop?.pro);
  const proRef = `PRO ${t(copyNbr) || '+ the copy\'s number'}`;
  return [
    { key: 'window', label: 'Delivery window', value: from && to ? `${from} – ${to}${strict ? ', strict' : ''}, on the day picked` : 'the original\'s times, on the day picked' },
    { key: 'pickup', label: 'Pickup', value: pickup || 'the original\'s' },
    { key: 'po', label: 'PO', value: own ? proRef : (po || `the original's, or ${proRef} if it has none`) },
    { key: 'cust', label: 'Cust #', value: t(stop?.custRef) || 'the original\'s, if any' },
  ];
}

/** What the copy does not take from the original, in the panel's words. */
export function duplicateNotCopied(stop) {
  const route = t(stop?.routeName) || t(stop?.loadNbr);
  const driver = t(stop?.driverName);
  const on = [route && `route ${route}`, driver && `driver ${driver}`].filter(Boolean).join(', ');
  return `Not copied: ${on ? `${on}, ` : 'the route, the driver, '}and attachments. The copy lands unplanned.`;
}

// ── PRICE AND NOTES ON THE COPY (v1.110.0) ────────────────────────────────────
// Chad, 10/03: "give me a spot to add notes for dispatcher or driver also put the original price in
// the box but leave the copy to duplicate unchecked default and also make it an editable field the
// price incase it's more or [less]."

/** The server's copyPrice: the tick is set and the box is empty — NuVizz's own price is copied. */
export const duplicateCopyPrice = (form) => !!form?.priceOn && !t(form?.price);

/** The sentence under the form that says what price the copy gets. */
export function duplicatePriceLine(form, baseline) {
  if (!form?.priceOn) return 'No price on the copy.';
  const v = t(form?.price);
  if (!v) return 'Price on the copy: the original\'s, as NuVizz holds it.';
  const was = t(baseline?.price);
  return `Price on the copy: ${v}${was && was !== v ? ` (the original's is ${was})` : ''}.`;
}

/** Who sees a note, in the stop card's own words (its "Show to" picker). */
export const NOTE_SHOW_TO = [['both', 'Both'], ['dispatcher', 'Dispatcher'], ['driver', 'Driver']];
const NOTE_FOR = { both: 'driver and dispatcher', dispatcher: 'dispatcher only', driver: 'driver only' };
export const DUPLICATE_NOTES_MAX = 5;

/** The note rows as typed → the notes to send, checked as the server checks them (parseDuplicateNotes). */
export function duplicateNotesDraft(rows) {
  const notes = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const text = t(r?.text);
    if (!text) continue;
    if (text.length > 500) return { error: 'a note for the copy is longer than NuVizz takes (500 characters)' };
    const audience = NOTE_FOR[r?.audience] ? r.audience : 'both';
    notes.push({ text, audience });
  }
  if (notes.length > DUPLICATE_NOTES_MAX) return { error: `the copy takes up to ${DUPLICATE_NOTES_MAX} new notes` };
  return { notes };
}

/** The sentence that says which notes the copy gets, or '' for none. */
export function duplicateNotesLine(rows) {
  const d = duplicateNotesDraft(rows);
  if (d.error || !d.notes.length) return '';
  return `Adds ${d.notes.length} note${d.notes.length === 1 ? '' : 's'}: ${d.notes.map((n) => NOTE_FOR[n.audience]).join(', ')}.`;
}

// ── THE ITEMS DRAWER (§DUP-L, v1.111.0) ───────────────────────────────────────
// Chad, 10/03: "give me a drawer to edit the actual items". The drawer opens on the original's item
// lines as the board row holds them (stopDetails — the Map feed serves them, board-fields.mts), and the
// copy carries exactly the lines it shows: this panel always sends them, [] when emptied. The server's
// rules are nuvizz-write-ops.mts parseDuplicateLines / duplicateStopDetails, and
// test/order-duplicate.test.mjs runs both checks over one table so they cannot drift.
//  · Pallets / Loose / Weight stay the order's TOTALS. On a create NuVizz keeps the totals and the
//    lines exactly as sent (measured 2026-10-03, with Chad's go-ahead), so the panel says when they
//    disagree and never blocks on it.
//  · A LONE line follows the copy's totals — quantity = Pallets + Loose, weight = the Weight box — as
//    the one line every order this app creates carries. Typing its quantity or weight, or adding a
//    second line, makes it the dispatcher's own from then on.
//  · Dimensions, class and the L flag ride across as NuVizz holds them and are shown, not edited: the
//    route build reads them for oversize freight and deck length (freight-geometry.mts).
// `counts` below is the Pallets / Loose boxes as parsePieceDraft reads them — those two alone, so a
// day already gone or a bad weight never blanks a following line's count; `weightText` is the Weight box.

export const DUPLICATE_LINES_MAX = 200;
const LINE_QTY_MAX = 99999;
const LINE_WEIGHT_MAX = 9999999999;
const DIMS = ['length', 'width', 'height', 'criticalDimension'];
const numText = (v) => (v != null && String(v).trim() !== '' && Number.isFinite(Number(v)) ? String(Number(v)) : '');
const dimOf = (v) => { const n = Number(v); return v != null && String(v).trim() !== '' && Number.isFinite(n) && n > 0 && n <= 99999 ? n : null; };
const round2 = (n) => Math.round(n * 100) / 100;
const lbWord = (u) => { const x = t(u).toUpperCase(); return !x || x === 'LBS' || x === 'LB' ? 'lb' : t(u); };

/** A new, empty line for the drawer. */
export function duplicateLineBlank(id) {
  return {
    id, product: '', quantity: '', quantityUOM: 'PCS', weight: '', weightUOM: 'LBS', referenceText: '', productCategory: '',
    length: null, lengthUOM: '', width: null, widthUOM: '', height: null, heightUOM: '', criticalDimension: null, criticalDimensionUOM: '',
    follows: false,
  };
}

/** The original's item lines as the drawer opens on them. A lone line follows the copy's totals.
 *  A line NuVizz holds with a blank description is still freight: it is kept, and asks for one
 *  before the copy can be made — never dropped from the copy without a word. */
export function duplicateLinesFrom(stop) {
  const rows = (Array.isArray(stop?.stopDetails) ? stop.stopDetails : [])
    .filter((d) => d && typeof d === 'object' && (t(d.product) || numText(d.quantity) || numText(d.weight)))
    .map((d, i) => {
      const row = {
        ...duplicateLineBlank(`o${i}`),
        product: t(d.product).slice(0, 100),
        quantity: numText(d.quantity), quantityUOM: t(d.quantityUOM).slice(0, 20) || 'PCS',
        weight: numText(d.weight), weightUOM: t(d.weightUOM).slice(0, 20) || 'LBS',
        referenceText: t(d.referenceText).slice(0, 50), productCategory: t(d.productCategory).slice(0, 45),
      };
      for (const k of DIMS) {
        const v = dimOf(d[k]);
        if (v != null) { row[k] = v; row[`${k}UOM`] = t(d[`${k}UOM`]).slice(0, k === 'criticalDimension' ? 20 : 10); }
      }
      return row;
    });
  if (rows.length === 1) rows[0].follows = true;
  return rows;
}

/** What line `row`'s quantity and weight boxes show now: a following line shows the copy's totals. */
export function duplicateLineShown(row, rows, counts, weightText) {
  const follows = !!row?.follows && (Array.isArray(rows) ? rows.length : 0) === 1;
  if (!follows) {
    return { follows: false, quantity: t(row?.quantity), quantityUOM: t(row?.quantityUOM) || 'PCS', weight: t(row?.weight), weightUOM: t(row?.weightUOM) || 'LBS' };
  }
  const total = counts && !counts.error ? (counts.total > 0 ? counts.total : 1) : null;
  return { follows: true, quantity: total == null ? '' : String(total), quantityUOM: 'PCS', weight: t(weightText), weightUOM: 'LBS' };
}

// A following line made the dispatcher's own keeps exactly the numbers it showed.
const takeOver = (r, shown) => ({ ...r, follows: false, quantity: shown.quantity, quantityUOM: 'PCS', weight: shown.weight, weightUOM: 'LBS' });

/** The lines after a box in line i changed. Typing a following line's quantity or weight makes it the
 *  dispatcher's own, starting from what it showed; its description alone does not. */
export function duplicateLinesEdit(rows, i, patch, counts, weightText) {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((r, j) => {
    if (j !== i) return r;
    const shown = duplicateLineShown(r, list, counts, weightText);
    return shown.follows && ('quantity' in patch || 'weight' in patch) ? { ...takeOver(r, shown), ...patch } : { ...r, ...patch };
  });
}

/** The lines with one more, empty, at the end. A first line follows the totals; a line that was
 *  following them keeps the numbers it showed, now as the dispatcher's own. */
export function duplicateLinesAdd(rows, id, counts, weightText) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length >= DUPLICATE_LINES_MAX) return list;
  if (!list.length) return [{ ...duplicateLineBlank(id), follows: true }];
  const kept = list.map((r) => { const shown = duplicateLineShown(r, list, counts, weightText); return shown.follows ? takeOver(r, shown) : r; });
  return [...kept, duplicateLineBlank(id)];
}

/** The lines without line i. */
export const duplicateLinesRemove = (rows, i) => (Array.isArray(rows) ? rows : []).filter((_, j) => j !== i);

/** The drawer's lines → the lines to send, checked as the server checks them (parseDuplicateLines). */
export function duplicateLinesDraft(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length > DUPLICATE_LINES_MAX) return { error: `the copy takes up to ${DUPLICATE_LINES_MAX} item lines` };
  const lines = [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i] || {};
    const at = `item line ${i + 1}`;
    const product = t(r.product);
    if (!product) return { error: `${at} needs a description` };
    if (product.length > 100) return { error: `${at}'s description is longer than NuVizz takes (100 characters)` };
    const line = { product };
    if (r.follows && list.length === 1) line.followsTotals = true;
    else {
      const q = Number(t(r.quantity));
      if (!t(r.quantity) || !Number.isFinite(q) || q <= 0 || q > LINE_QTY_MAX) return { error: `${at} needs a quantity above 0 (up to ${LINE_QTY_MAX})` };
      line.quantity = q;
      line.quantityUOM = t(r.quantityUOM) || 'PCS';
      if (t(r.weight)) {
        const w = Number(t(r.weight));
        if (!Number.isFinite(w) || w < 0 || w > LINE_WEIGHT_MAX) return { error: `${at}'s weight must be a number of pounds from 0 up` };
        line.weight = w;
        line.weightUOM = t(r.weightUOM) || 'LBS';
      }
    }
    if (t(r.referenceText)) line.referenceText = t(r.referenceText);
    if (t(r.productCategory)) line.productCategory = t(r.productCategory);
    for (const k of DIMS) {
      if (r[k] == null) continue;
      line[k] = r[k];
      if (t(r[`${k}UOM`])) line[`${k}UOM`] = t(r[`${k}UOM`]);
    }
    lines.push(line);
  }
  return { lines };
}

/** Did the dispatcher change the lines from the ones the drawer opened on? A following line's numbers
 *  are the copy's totals, which the change line names on their own. */
export function duplicateLinesChanged(rows, base) {
  const a = Array.isArray(rows) ? rows : [];
  const b = Array.isArray(base) ? base : [];
  if (a.length !== b.length) return true;
  const n = (v) => (t(v) === '' ? null : Number(t(v)));
  return a.some((r, i) => {
    const o = b[i] || {};
    if (r.id !== o.id || t(r.product) !== t(o.product) || !!r.follows !== !!o.follows) return true;
    return !r.follows && (n(r.quantity) !== n(o.quantity) || n(r.weight) !== n(o.weight) || t(r.quantityUOM) !== t(o.quantityUOM));
  });
}

/** The drawer's one line while it is shut. */
export function duplicateLinesSummary(rows, counts, weightText) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return 'No item lines on the copy';
  const name = (r) => t(r.product) || 'no description yet';
  if (list.length === 1) {
    const s = duplicateLineShown(list[0], list, counts, weightText);
    const bits = [name(list[0]), s.quantity && `${s.quantity} ${s.quantityUOM}`, s.weight && `${s.weight} ${lbWord(s.weightUOM)}`].filter(Boolean);
    return `${bits.join(' · ')}${s.follows ? ' — follows the totals' : ''}`;
  }
  return `${list.length} lines: ${list.slice(0, 2).map(name).join(', ')}${list.length > 2 ? `, +${list.length - 2} more` : ''}`;
}

/** Said under the lines when they and the copy's totals disagree, or '' when they agree. Never a
 *  block: on a create NuVizz keeps the totals and the lines as sent. */
export function duplicateLinesMismatch(rows, counts, weightText) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length || !counts || counts.error) return '';
  if (list.length === 1 && list[0].follows) return '';
  const parts = [];
  const qs = list.map((r) => (t(r.quantity) === '' ? NaN : Number(t(r.quantity))));
  if (qs.every(Number.isFinite)) {
    const sum = round2(qs.reduce((a, b) => a + b, 0));
    if (sum !== counts.total) parts.push(`the item lines' quantities add up to ${sum}; Pallets + Loose make ${counts.total}`);
  }
  const box = t(weightText);
  if (box !== '' && Number.isFinite(Number(box)) && list.every((r) => t(r.weight) !== '' && Number.isFinite(Number(t(r.weight))) && lbWord(r.weightUOM) === 'lb')) {
    const sum = round2(list.reduce((a, r) => a + Number(t(r.weight)), 0));
    if (sum !== Number(box)) parts.push(`their weights add up to ${sum} lb; the Weight box says ${Number(box)}`);
  }
  if (!parts.length) return '';
  const text = parts.join(', and ');
  return `${text[0].toUpperCase()}${text.slice(1)}. NuVizz keeps both as you leave them.`;
}

/** A line's facts the drawer shows but does not edit, in the paperwork's words, or '' for none. */
export function duplicateLineFacts(row) {
  const unit = (u) => { const x = t(u).toLowerCase(); return x === 'inch' || x === 'inches' || x === 'in' ? 'in' : x; };
  const sized = (v, u) => `${v}${unit(u) ? ` ${unit(u)}` : ''}`;
  const parts = [];
  const [L, W, H] = ['length', 'width', 'height'].map((k) => row?.[k] ?? null);
  if (L != null && W != null && H != null && unit(row.lengthUOM) === unit(row.widthUOM) && unit(row.widthUOM) === unit(row.heightUOM)) {
    parts.push(sized(`${L} × ${W} × ${H}`, row.lengthUOM));
  } else {
    for (const k of ['length', 'width', 'height']) if (row?.[k] != null) parts.push(`${k} ${sized(row[k], row[`${k}UOM`])}`);
  }
  if (row?.criticalDimension != null) parts.push(`critical dimension ${sized(row.criticalDimension, row.criticalDimensionUOM)}`);
  if (t(row?.referenceText)) parts.push(`class ${t(row.referenceText)}`);
  const cat = t(row?.productCategory);
  if (cat.toUpperCase() === 'L') parts.push('L (long / oversize)');
  else if (cat) parts.push(`category ${cat}`);
  return parts.join(' · ');
}
