// order-labels.js — PURE rules for the Davis delivery label (no DOM, no PDF, no network).
//
// Chad, Sep 24 2026: "I want to create a label maker for when we create single order or bulk
// add orders in dispatch map I want the label to take up 1 page i want the address of where it
// is going and skid & loose piece count if applicable as well as a bar code we can scan for our
// load out app and wms app."
//
// Then: "This is supposed to be its own label, separate entity … just something we can print by
// the order … just like we can print a delivery ticket." And: "Labels should be part of the
// orders information in firebase … we should be able to print a new label anytime."
//
// ONE PAGE PER PIECE (every skid and every loose piece gets its own page), ONE Code 128 barcode
// per page carrying DD/<NuVizz stop #>/<piece>. Printed from New Order (single) and Bulk add
// (grid + Estes manifest push; NOT the "A NEW load" import — Chad: "the labels shouldn't touch
// the new load"). Each created order's label record is saved to Firestore (order-labels
// function), so any label can be printed again later. The renderer (label-html.js) only draws
// what these functions return, and it opens in the same print viewer as the Delivery Ticket.

export const LABEL_PREFIX = 'DD';

/** What the QR code in the corner opens, and the tagline beside it (Chad's words). */
export const LABEL_PROMO = {
  url: 'https://davisdelivery.com',
  headline: 'WE CAN DELIVER FOR YOU TOO!',
  // The "call us" / General Info number on davisdelivery.com/contact (read Sep 24 2026).
  phone: '(678) 926-3939',
  site: 'davisdelivery.com',
  qrCaption: 'SCAN TO VISIT OUR WEBSITE',
};

/**
 * The QR code for LABEL_PROMO.url, as module rows ('1' = dark), version 2, error correction M.
 * Precomputed so the label adds no npm dependency; generated with the `qrcode` package
 * (QRCode.create(url, { errorCorrectionLevel: 'M' })) and decoded back to the URL off a
 * rendered page before it shipped. If the URL ever changes, regenerate these rows the same way.
 */
export const LABEL_QR_ROWS = [
  '1111111001110010101111111',
  '1000001001000111101000001',
  '1011101011011001001011101',
  '1011101010001110001011101',
  '1011101011011000101011101',
  '1000001011100011001000001',
  '1111111010101010101111111',
  '0000000011010011100000000',
  '1011111001101110001111100',
  '1101000110101010100100010',
  '1101001000011101101001011',
  '1011110110001001111100001',
  '0001011010101111011010111',
  '1110010011100110110101010',
  '1000011000011001011111011',
  '1001100110110011100110001',
  '1010011110011101111110100',
  '0000000010101101100011000',
  '1111111001000110101010111',
  '1000001011000000100011011',
  '1011101010011111111110100',
  '1011101010110000111011111',
  '1011101010000101000001101',
  '1000001001110010100111001',
  '1111111011011110011111111'
];

/**
 * Barcode payload for ONE physical piece: DD/<NuVizz stop #>/<piece seq>.
 *
 * The stop # is the one NuVizz CONFIRMED (createStop's entityNbr), never a number the form
 * merely typed: a single order can be created with Order # blank and NuVizz assigns it, so a
 * label built before the create answers would carry no number, or the wrong one. Throws
 * rather than print a scannable label for an order that does not exist.
 */
export function labelPayload(stopNbr, seq) {
  const nbr = String(stopNbr ?? '').trim();
  if (!nbr) throw new Error('no confirmed order number — a label is never printed for an order NuVizz did not accept');
  if (!Number.isInteger(seq) || seq < 1 || seq > 999) throw new Error(`bad piece number ${seq}`);
  return `${LABEL_PREFIX}/${nbr}/${seq}`;
}

/** Read a payload back — the rule the load-out app and the WMS apply. Splits from the RIGHT. */
export function parseLabelPayload(raw) {
  const m = /^DD\/(.+)\/(\d{1,3})$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  const seq = Number(m[2]);
  const stopNbr = m[1].trim();
  return stopNbr && seq >= 1 ? { stopNbr, seq } : null;
}

const count = (v) => {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/** The most pages one order may print — a typo'd "500" skids must not send 500 pages to the dock printer. */
export const MAX_LABEL_PAGES = 99;

/**
 * The pages one order prints. Skids first, then loose, numbered 1..N across the order.
 *
 * These are the SAME numbers the create wrote to NuVizz (buildStopPayload: totalCartons =
 * skids, volume = loose, totalPallets = skids + loose or 1 when nothing was entered), which is
 * where the load-out app reads its piece cap — so the stack of labels and the cap agree. An
 * order with no count still prints ONE page, flagged, because NuVizz holds it as one piece.
 */
export function labelPieces(order) {
  const skids = count(order?.pallets);
  const loose = count(order?.loose);
  const total = skids + loose;
  if (total === 0) return [{ seq: 1, kind: 'PIECE', kindIdx: 1, kindTotal: 1, total: 1, countMissing: true }];
  const out = [];
  for (let i = 1; i <= skids; i++) out.push({ seq: i, kind: 'SKID', kindIdx: i, kindTotal: skids, total });
  for (let i = 1; i <= loose; i++) out.push({ seq: skids + i, kind: 'LOOSE', kindIdx: i, kindTotal: loose, total });
  return out;
}

/** Pages a batch will print, and whether any order is over the per-order limit. */
export function labelPageCount(orders) {
  let pages = 0;
  const tooBig = [];
  for (const o of orders || []) {
    const n = labelPieces(o).length;
    if (n > MAX_LABEL_PAGES) tooBig.push(o);
    else pages += n;
  }
  return { pages, tooBig };
}

/**
 * The label order for a row that was just created. `nbr` is the NuVizz stop # the create
 * returned (entityNbr, falling back to the number the row sent — the number NuVizz files the
 * order under when it echoes none). null when there is no number to print: the caller must
 * say so, never print a label without one.
 *
 * This is also the record saved to Firestore, so it carries what a reprint needs later: the
 * reference printed beside the number, the ship-from, and where it was created.
 */
export function labelOrderFromCreate(row, nbr, { serviceDate = '', ref = '', origin = null, source = '' } = {}) {
  const stopNbr = String(nbr ?? '').trim();
  if (!stopNbr || !row) return null;
  const s = (v) => String(v ?? '').trim();
  const o = origin && typeof origin === 'object'
    ? { name: s(origin.name), addr1: s(origin.addr1), city: s(origin.city), state: s(origin.state), zip: s(origin.zip) }
    : null;
  return {
    stopNbr,
    ref: s(ref),
    name: s(row.name), addr1: s(row.addr1), addr2: s(row.addr2),
    city: s(row.city), state: s(row.state), zip: s(row.zip),
    phone: s(row.phone), itemDesc: s(row.itemDesc),
    pallets: s(row.pallets), loose: s(row.loose), weight: s(row.weight),
    dispatchNotes: s(row.dispatchNotes),
    serviceDate: s(serviceDate),
    origin: o && o.name ? o : null,
    source: s(source),
  };
}

/**
 * The label order for a row in the "Pushed to NuVizz" log (manifest-push-log records) —
 * what Reprint uses, so a reprint costs zero NuVizz calls. The log's nuvizzNbr is the stop #.
 */
export function labelOrderFromPushLog(rec) {
  if (!rec) return null;
  return labelOrderFromCreate(rec, rec.nuvizzNbr || rec.orderRef, {
    serviceDate: rec.serviceDate,
    ref: rec.orderRef && rec.orderRef !== rec.nuvizzNbr ? rec.orderRef : '',
  });
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sep 25, 2026" from YYYY-MM-DD — the house date rule (never ISO on screen or paper). */
export function labelDay(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ''));
  return m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${MON[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : '';
}

/** "Sep 24, 2026 4:05 PM" for the footer's print stamp. */
export function labelStamp(d) {
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) return '';
  let h = t.getHours();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${MON[t.getMonth()]} ${t.getDate()}, ${t.getFullYear()} ${h}:${String(t.getMinutes()).padStart(2, '0')} ${ap}`;
}

/**
 * The stop shape buildTicketHtml reads (App.jsx ticketData), made from a saved label record —
 * so New Order can print the Delivery Ticket for an order it just created without asking
 * NuVizz for it. The Delivery Ticket itself is not changed; this only feeds it.
 *
 * Mirrors what the create WROTE (nuvizz-write-ops buildStopPayload): pallets ride "cartons",
 * loose ride "volume", total pieces ride "pallets" (1 when nothing was entered); the item
 * description is the one line item; dispatch notes are the one Stop Instructions comment; and
 * the requested window is the create's default delivery window, 12:00-17:00 on the service date.
 */
export function ticketStopFromLabel(rec) {
  if (!rec) return null;
  const num = (v) => { const n = Number(String(v ?? '').trim()); return String(v ?? '').trim() !== '' && Number.isFinite(n) ? n : null; };
  const pallets = num(rec.pallets), loose = num(rec.loose), weight = num(rec.weight);
  const total = pallets != null || loose != null ? (pallets ?? 0) + (loose ?? 0) : 1;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(rec.serviceDate || '')) ? rec.serviceDate : '';
  return {
    stopNbr: rec.stopNbr, pro: rec.ref || '', stopType: 'DO',
    businessName: rec.name, addr1: rec.addr1, addr2: rec.addr2 || '',
    city: rec.city, state: rec.state, zip: rec.zip,
    contact: { phone: rec.phone || '' },
    scheduledFrom: d ? `${d}T12:00:00` : '', scheduledTo: d ? `${d}T17:00:00` : '',
    weight: weight ?? 0, volume: loose ?? 0, cartons: pallets ?? 0, pallets: total,
    stopDetails: rec.itemDesc
      ? [{ product: rec.itemDesc, productIdentifier: rec.ref || rec.stopNbr, quantity: total > 0 ? total : 1, weight: weight ?? undefined }]
      : [],
    allComments: rec.dispatchNotes ? [{ text: rec.dispatchNotes, addedBy: 'Dispatcher', addedOn: rec.createdAt || '' }] : [],
  };
}

/**
 * The label for an order on the BOARD, printed from its stop card — any order, whenever.
 *
 * The board's own numbers win: skids (NuVizz "cartons"), loose ("volume"), weight and the
 * ship-to as the card shows it (a dispatcher's address fix included) — so a label printed today
 * carries today's count, the one the load-out app caps at. A label saved when the order was
 * created in New Order / Bulk add fills in only what the board does not carry: the reference
 * printed beside the number, the delivery notes, the ship-from. The service date is the day of
 * the order's delivery window.
 */
export function labelOrderFromStop(stop, { saved = null, addressOverride = null, phone = '' } = {}) {
  const stopNbr = String(stop?.stopNbr ?? '').trim();
  if (!stopNbr) return null;
  const s = (v) => (v == null ? '' : String(v).trim());
  const ov = addressOverride && typeof addressOverride === 'object' ? addressOverride : {};
  const pick = (k) => s(ov[k] ?? stop[k] ?? saved?.[k]);
  const items = (Array.isArray(stop.stopDetails) ? stop.stopDetails : [])
    .map((it) => s(it?.product)).filter(Boolean);
  const day = s(stop.scheduledFrom).slice(0, 10);
  const pro = s(stop.pro);
  return {
    stopNbr,
    ref: s(saved?.ref) || (pro && pro !== stopNbr ? pro : ''),
    name: s(stop.businessName) || s(saved?.name),
    addr1: pick('addr1'), addr2: pick('addr2'),
    city: pick('city'), state: pick('state'), zip: pick('zip'),
    phone: s(phone) || s(saved?.phone),
    itemDesc: items.join(', ') || s(saved?.itemDesc),
    // No count on the board → the saved one, never an invented one.
    pallets: stop.cartons != null ? s(stop.cartons) : s(saved?.pallets),
    loose: stop.volume != null ? s(stop.volume) : s(saved?.loose),
    weight: stop.weight != null ? s(stop.weight) : s(saved?.weight),
    dispatchNotes: s(saved?.dispatchNotes),
    serviceDate: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : s(saved?.serviceDate),
    origin: saved?.origin || null,
    source: s(saved?.source),
  };
}
