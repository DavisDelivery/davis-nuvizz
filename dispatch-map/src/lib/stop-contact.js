// src/lib/stop-contact.js
//
// THE CUSTOMER # BLOCK on a stop card — who to call at this delivery, and the
// number to call. Pure, so the precedence rules can be unit-tested.
//
// Chad: "make a spot where the customer number is on normal orders — where if
// one of the orders doesn't have a customer name or number we can add it like
// we add notes."
//
// Two ways an order gets a contact:
//   • the ORDER carries one — NuVizz's Ship-To contact (scan: to.contact →
//     stop.contact). Every order we create ourselves has a Phone field on the
//     New Order / Bulk Add forms, so ours arrive with one. The ones that come
//     in from a carrier often don't.
//   • WE SAVED one — a contact on the customer_notes doc for this location,
//     typed either in the notes editor's Contacts rows or, now, right on the
//     card at the spot where the number is printed.
//
// A saved contact WINS: a dispatcher who typed a number did so because the
// order's was missing or wrong. That is the precedence resolveStopPhone has
// always used for the Text button; this module is now its single definition,
// so the number the card prints, the number Text uses and the number Call
// dials can never disagree.

const digitsOf = (v) => String(v ?? '').replace(/\D/g, '');
const str = (v) => String(v ?? '').trim();

// A number we can actually dial or text. The contact slot collects junk — an
// extension on its own, a dock code, "N/A" — so ten digits is the bar, the same
// one the Text button has used since it learned to say "(add #)".
export function isDialable(phone) {
  return digitsOf(phone).length >= 10;
}

// Same number wearing different punctuation? (678) 860-8099 === 6788608099.
export function samePhone(a, b) {
  const da = digitsOf(a), dbb = digitsOf(b);
  if (!da || !dbb) return false;
  return da.replace(/^1(?=\d{10}$)/, '') === dbb.replace(/^1(?=\d{10}$)/, '');
}

// The contact the card should print: { name, phone, role, source, dialable }.
// `source` is 'saved' (typed by a dispatcher) | 'order' (came in on the order) |
// null (nothing on file anywhere — the case this whole block exists for).
//
// NAME AND NUMBER ARE RESOLVED AS A PAIR, from ONE source. The card used to
// print the ORDER's contact name beside whichever number won, so a saved number
// showed up captioned with the name of whoever NuVizz had on file — an
// attribution the data never supported. Whatever is missing is reported missing.
export function resolveStopContact(stop, note) {
  const saved = Array.isArray(note?.contacts) ? note.contacts : [];
  const order = stop?.contact || null;

  const pick = (c, source) => ({
    name: str(c?.name), phone: str(c?.phone), role: str(c?.role),
    source, dialable: isDialable(c?.phone),
  });

  // 1. A saved contact we can dial.
  const savedDialable = saved.find((c) => isDialable(c?.phone));
  if (savedDialable) return pick(savedDialable, 'saved');
  // 2. The order's contact, if it carries a real number.
  if (order && isDialable(order.phone)) return pick(order, 'order');
  // 3. Nothing dialable. A NAME on file is still worth printing — the card says
  //    who to ask for and that the number is what's missing.
  const savedNamed = saved.find((c) => str(c?.name) || str(c?.phone));
  if (savedNamed) return pick(savedNamed, 'saved');
  if (order && (str(order.name) || str(order.phone))) return pick(order, 'order');
  return { name: '', phone: '', role: '', source: null, dialable: false };
}

// The dialable number for texting/calling, or '' when there is none. Byte-for-byte
// the old resolveStopPhone: a saved contact's number wins, the order's is the
// fallback, and a number too short to dial is not a number.
export function resolveStopPhone(stop, note) {
  const c = resolveStopContact(stop, note);
  return c.dialable ? c.phone : '';
}

// When a SAVED number is the one being shown, the order's own number must not
// vanish — the dispatcher who overrode it is entitled to see what the carrier
// sent. Returns { name, phone } for a small secondary line, or null when there's
// nothing to add (no order contact, or it's the same number already on screen).
export function orderContactAside(stop, resolved) {
  const order = stop?.contact;
  if (!order || !isDialable(order.phone)) return null;
  if (!resolved || resolved.source !== 'saved') return null;
  if (samePhone(order.phone, resolved.phone)) return null;
  return { name: str(order.name), phone: str(order.phone) };
}

// Fold an edit from the card into the note's `contacts` array, returning a NEW
// array (never mutates — the caller's draft may be React state).
//
// WHICH ENTRY IS "the customer number"? The one resolveStopContact would pick:
// the first dialable contact, else the first entry carrying anything at all. So
// editing on the card edits the number the card is showing, and the extra
// contacts a customer may have (a dock supervisor, an after-hours cell) are left
// exactly where the notes editor put them. Roles and any other saved keys on the
// edited entry survive the write.
//
// Clearing BOTH fields deletes that entry rather than saving a blank row.
export function mergeSavedContact(contacts, patch) {
  const list = Array.isArray(contacts) ? contacts.map((c) => ({ ...c })) : [];
  const name = str(patch?.name);
  const phone = str(patch?.phone);

  let i = list.findIndex((c) => isDialable(c?.phone));
  if (i < 0) i = list.findIndex((c) => str(c?.name) || str(c?.phone));

  if (!name && !phone) return i < 0 ? list : list.filter((_, idx) => idx !== i);
  if (i < 0) return [...list, { name, phone, role: '' }];
  list[i] = { ...list[i], name, phone };
  return list;
}
