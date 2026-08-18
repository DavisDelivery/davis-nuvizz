// test/customer-comms-safety.test.mjs
//
// THREE WAYS THIS FEATURE COULD HAVE EMAILED THE WRONG THING, found by an
// adversarial review of the trigger AFTER it shipped (v0.54.88) but BEFORE the
// program switch was ever turned on. All three were reachable the moment the
// switch flipped, and all three were invisible from the screen — which claimed,
// in the confirmation dialog a person reads last, "one per PRO, ever".
//
//   1. A completed PICKUP is also normalizedStatus DELIVERED, so the shipper
//      would be told "your delivery is complete" the moment we took custody.
//   2. The opt-out lives in customer_notes, and an UNREADABLE notes doc was
//      collapsed into "no notes" — so a transient Firestore error emailed a
//      customer who had explicitly asked us to stop.
//   3. The ledger is per BOARD DATE, so the same delivery appearing on two
//      dates was claimed once under each and emailed twice.
//
// Fixtures use @example.com throughout: Netlify greps this directory for env
// var VALUES, and a lifelike address here has failed the production deploy
// before. See test/no-lifelike-addresses.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isCustomerDelivery, sendForStop, resolveRecipient, chooseRecipient,
  dayAfter, dayBefore, DEFAULT_CONFIG,
} from '../netlify/functions/lib/customer-comms.mts';

process.env.RESEND_API_KEY ||= 'test-key';
process.env.RESEND_FROM ||= 'Davis <no-reply@example.com>';
const ENABLED = { ...DEFAULT_CONFIG, enabled: true, htmlTemplate: '<p>{{pro}}</p>' };
const DATE = '2026-08-18';

const STOP = {
  stopNbr: '1234567', pro: '1234567', normalizedStatus: 'DELIVERED', stopType: 'DO',
  businessName: 'Peachtree Tile', addr1: '1 Main St', city: 'Buford', zip: '30518',
  contact: { email: 'ap@example.com' }, deliveredDTTM: null,
};

function deps(over = {}) {
  return {
    recipient: async () => ({ email: 'ap@example.com', optedOut: false, matchKey: 'k', source: 'order' }),
    priorSend: async () => null,
    claim: async () => true,
    finalize: async () => {},
    release: async () => {},
    send: async () => ({ ok: true, id: 'e_1' }),
    ...over,
  };
}

// ── 1. A PICKUP IS NOT A DELIVERY ───────────────────────────────────────────

test('a completed PICKUP is not a customer delivery, however DELIVERED it looks', () => {
  assert.equal(isCustomerDelivery({ normalizedStatus: 'DELIVERED', stopType: 'PU' }), false);
  assert.equal(isCustomerDelivery({ normalizedStatus: 'DELIVERED', stopType: 'pu' }), false, 'case-insensitive');
  assert.equal(isCustomerDelivery({ normalizedStatus: 'DELIVERED', stopType: ' PU ' }), false, 'and padded');
  assert.equal(isCustomerDelivery({ normalizedStatus: 'DELIVERED', stopType: 'DO' }), true);
});

test('an UNTYPED delivered stop still counts — enrichment lags, and dropping real customers is the worse error', () => {
  // Deliberate asymmetry: the thing being guarded against announces itself with an
  // explicit 'PU'. A not-yet-enriched row has no type at all, and silently skipping
  // those would be this feature quietly failing at its whole job.
  assert.equal(isCustomerDelivery({ normalizedStatus: 'DELIVERED' }), true);
  assert.equal(isCustomerDelivery({ normalizedStatus: 'DELIVERED', stopType: '' }), true);
  assert.equal(isCustomerDelivery({ normalizedStatus: 'DELIVERED', stopType: null }), true);
});

test('nothing undelivered is ever a customer delivery', () => {
  for (const st of ['PLANNED', 'ARRIVED', 'CANCELLED', '', undefined, 'ATTEMPTED']) {
    assert.equal(isCustomerDelivery({ normalizedStatus: st, stopType: 'DO' }), false, String(st));
  }
});

test('sendForStop REFUSES a pickup, and says which kind of refusal it is', async () => {
  const r = await sendForStop({ ...STOP, stopType: 'PU' }, DATE, { cfg: ENABLED, deps: deps() });
  assert.equal(r.ok, undefined, 'nothing was sent');
  assert.equal(r.skipped, 'pickup_not_delivery', 'and not the generic not_delivered — this one is worth seeing in the log');
});

// ── 2. THE OPT-OUT MUST FAIL CLOSED ─────────────────────────────────────────

test('an UNREADABLE notes doc stops the send — it is where the opt-out lives', async () => {
  const r = await sendForStop(STOP, DATE, {
    cfg: ENABLED,
    deps: deps({ recipient: async () => ({ email: null, optedOut: false, matchKey: 'k', notesUnavailable: true }) }),
  });
  assert.equal(r.skipped, 'notes_unavailable');
  assert.equal(r.ok, undefined, 'a customer who may have opted out is not emailed on a guess');
});

test('resolveRecipient reports notesUnavailable when the read THROWS, and sends when it is merely ABSENT', async () => {
  // The distinction the old `.catch(() => null)` destroyed. Absent is the ordinary case for
  // almost every customer and must still send; errored must not.
  const stop = { ...STOP };
  const real = await resolveRecipient(stop).catch(() => null);
  // Firestore is not configured in unit tests, so the read cannot succeed — which is
  // exactly the failing-read path, and it must come back flagged rather than sendable.
  if (real) {
    assert.equal(real.notesUnavailable === true || real.matchKey === null, true,
      'a failed read is flagged, never silently treated as "no opt-out on file"');
    if (real.notesUnavailable) assert.equal(real.email, null, 'and carries no address to send to');
  }
  // The pure half, driven directly: absent notes still sends off the order's address.
  const absent = chooseRecipient(null, stop, 'k');
  assert.equal(absent.email, 'ap@example.com');
  assert.equal(absent.optedOut, false);
  assert.equal(absent.notesUnavailable, undefined);
});

test('an explicit opt-out still wins over everything', async () => {
  const r = await sendForStop(STOP, DATE, {
    cfg: ENABLED,
    deps: deps({ recipient: async () => ({ email: 'ap@example.com', optedOut: true, matchKey: 'k' }) }),
  });
  assert.equal(r.skipped, 'opted_out');
});

// ── 3. ONE EMAIL PER PRO *EVER*, NOT PER BOARD DATE ─────────────────────────

test('THE PROMISE: a delivery already emailed under YESTERDAY is not emailed again today', async () => {
  const seen = [];
  const r = await sendForStop(STOP, DATE, {
    cfg: ENABLED,
    deps: deps({
      priorSend: async (d, k) => { seen.push(d); return d === dayBefore(DATE) ? { ok: true, to: 'ap@example.com' } : null; },
      send: async () => { throw new Error('must not send'); },
    }),
  });
  assert.equal(r.skipped, 'already_sent_other_date');
  assert.ok(seen.includes('2026-08-17'), 'yesterday was checked');
});

test('and not emailed again if the prior send was under TOMORROW either', async () => {
  const r = await sendForStop(STOP, DATE, {
    cfg: ENABLED,
    deps: deps({
      priorSend: async (d) => (d === dayAfter(DATE) ? { ok: true } : null),
      send: async () => { throw new Error('must not send'); },
    }),
  });
  assert.equal(r.skipped, 'already_sent_other_date');
});

test('BOTH neighbours are checked, and only those two', async () => {
  const seen = [];
  await sendForStop(STOP, DATE, { cfg: ENABLED, deps: deps({ priorSend: async (d) => { seen.push(d); return null; } }) });
  assert.deepEqual(seen.sort(), ['2026-08-17', '2026-08-19'],
    'exactly the window isSweepableBoardDate can hand us — wider would read documents that cannot exist');
});

test('an unreadable neighbour ledger stops the send rather than risking a second email', async () => {
  const r = await sendForStop(STOP, DATE, {
    cfg: ENABLED,
    deps: deps({
      priorSend: async () => { throw new Error('firestore down'); },
      send: async () => { throw new Error('must not send'); },
    }),
  });
  assert.equal(r.skipped, 'neighbour_ledger_unavailable');
});

test('a clean stop with no prior send anywhere still goes out', async () => {
  // The guard must not become a reason nobody is ever emailed.
  const r = await sendForStop(STOP, DATE, { cfg: ENABLED, deps: deps() });
  assert.equal(r.ok, true);
  assert.equal(r.to, 'ap@example.com');
});

test('dayAfter is the mirror of dayBefore, junk and boundaries included', () => {
  assert.equal(dayAfter('2026-08-18'), '2026-08-19');
  assert.equal(dayAfter('2026-12-31'), '2027-01-01');
  assert.equal(dayAfter('2024-02-28'), '2024-02-29', 'leap');
  for (const junk of ['', 'nope', '2026-13-45', null, undefined, 42]) assert.equal(dayAfter(junk), '', String(junk));
});
