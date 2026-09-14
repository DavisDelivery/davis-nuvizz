// test/stop-address-push.test.mjs
//
// WIRING THE ADDRESS CORRECTION TO NUVIZZ — the half that had no button.
//
// Chad: "when we edit an address because it's wrong ... do we change it in nuVizz, or do we
// just change it in dispatch map?" It was dispatch map only. runSetStopAddress had existed and
// been tested since Sep 9 and NOTHING in src/ could reach it: the client's op list carried ten
// ops and not that one. The driver's manifest app never reads customer_notes, and the
// delivered-customer email renders the cached board row, so both quoted the vendor's address
// back at the two people most able to act on it.
//
// These tests pin the WIRING and the PROMISES around it — the payload builders themselves are
// covered by stop-address-write.test.mjs. Several assert against App.jsx's source text: the
// modal cannot be mounted without a browser, Firestore and the Google geocoder, and a rule that
// is only true in a comment is the failure mode this repo keeps finding.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setStopAddress } from '../src/lib/nuvizzWrite.js';
import { addressWriteBlocked } from '../netlify/functions/lib/nuvizz-write.mts';
import { buildAddressChangeRow } from '../netlify/functions/lib/address-history.mts';

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

/** One top-level component's source, start of its `function` line to the start of the next one.
 *  Sliced on a second marker instead (`indexOf` of a comment) silently yielded '' when that
 *  comment also appeared EARLIER in the file — and every assertion against '' passed or failed
 *  for the wrong reason. */
function fnSource(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  const next = APP.indexOf('\nfunction ', start + 1);
  const body = APP.slice(start, next > 0 ? next : undefined);
  assert.ok(body.length > 200, `${name} sliced to nothing — the slicer is broken, not the code`);
  return body;
}
const MODAL = fnSource('AddressEditModal');

// ── the op is reachable at all ───────────────────────────────────────────────

test('THE GAP THAT STARTED THIS: the client can now call setStopAddress', () => {
  assert.equal(typeof setStopAddress, 'function');
  assert.match(APP, /setStopAddress/, 'and App.jsx imports it — an export nothing calls is the bug this fixes');
  assert.match(
    APP,
    /import \{[^}]*setStopAddress[^}]*\} from '\.\/lib\/nuvizzWrite\.js'/,
    'imported from the single door every live NuVizz write goes through',
  );
});

// ── the payload ──────────────────────────────────────────────────────────────
//
// captureWrite stands in for the network: callWrite POSTs through apiFetch, so we intercept
// fetch and read the envelope the browser would have sent.
async function captureWrite(fn) {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { now: '800 N COMMERCE ST, MONROE, GEORGIA 30655' } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  try { await fn(); } finally { globalThis.fetch = realFetch; }
  return seen;
}

test('the correction goes out as the five address fields, and nothing else', async () => {
  const [call] = await captureWrite(() => setStopAddress('ESTES-1', {
    addr1: '800 N COMMERCE ST', addr2: 'DOCK 4', city: 'MONROE', state: 'GA', zip: '30655',
  }, { stopId: 'abc123' }));
  assert.equal(call.body.op, 'setStopAddress');
  assert.deepEqual(call.body.payload.address, {
    addr1: '800 N COMMERCE ST', addr2: 'DOCK 4', city: 'MONROE', state: 'GA', zip: '30655',
  });
  assert.equal(call.body.payload.stopNbr, 'ESTES-1');
});

test('NO NAME GOES OUT — re-addressing freight must never rename the consignee', async () => {
  // buildLiteralAddress falls back to the name already on the order. Sending one from a modal
  // whose fields are addr1/addr2/city/state/zip could only ever send the wrong thing.
  const [call] = await captureWrite(() => setStopAddress('ESTES-1', { addr1: '1 MAIN ST', city: 'BUFORD', state: 'GA', zip: '30518' }));
  assert.ok(!('name' in call.body.payload.address), 'the vendor keeps the consignee it already has');
});

test('NO LAT/LNG GOES OUT — NuVizz re-derives its own from the street we send', async () => {
  // Our Google geocode and the vendor's geocoder disagree, and on the geocode-denied path we
  // have no coordinate at all. Asserting ours into the carrier's record puts a pin there that
  // the carrier never computed.
  const [call] = await captureWrite(() => setStopAddress('ESTES-1', { addr1: '1 MAIN ST', city: 'BUFORD', state: 'GA', zip: '30518' }));
  for (const k of ['latitude', 'longitude', 'lat', 'lng']) {
    assert.ok(!(k in call.body.payload.address), `${k} must not ride along`);
  }
});

test('an emptied suite box CLEARS addr2 rather than leaving the old one on the order', async () => {
  const [call] = await captureWrite(() => setStopAddress('ESTES-1', { addr1: '1 MAIN ST', addr2: '', city: 'BUFORD', state: 'GA', zip: '30518' }));
  assert.equal(call.body.payload.address.addr2, '', 'an explicit empty string is what deletes it server-side');
});

test('stopId pins the write to the record on screen — the wrong-twin rule', async () => {
  const [withId] = await captureWrite(() => setStopAddress('ESTES-1', { addr1: '1 MAIN ST' }, { stopId: 'abc123' }));
  assert.equal(withId.body.payload.stopId, 'abc123');
  const [without] = await captureWrite(() => setStopAddress('ESTES-1', { addr1: '1 MAIN ST' }));
  assert.ok(!('stopId' in without.body.payload), 'absent, not the string "undefined"');
});

test('it is never a dry run, and it always carries a clientOpId for the write ledger', async () => {
  const [call] = await captureWrite(() => setStopAddress('ESTES-1', { addr1: '1 MAIN ST' }));
  assert.equal(call.body.dryRun, false);
  assert.match(String(call.body.clientOpId), /^op_/, 'putOpRecord only records an op that carries one');
});

// ── the brake ────────────────────────────────────────────────────────────────

test('THE WAY BACK: NUVIZZ_ADDRESS_WRITE=off refuses every push', () => {
  const prev = process.env.NUVIZZ_ADDRESS_WRITE;
  try {
    for (const off of ['0', 'false', 'off', 'no', 'OFF', ' Off ']) {
      process.env.NUVIZZ_ADDRESS_WRITE = off;
      assert.equal(addressWriteBlocked(), true, `${JSON.stringify(off)} must stop the vendor write`);
    }
  } finally { if (prev === undefined) delete process.env.NUVIZZ_ADDRESS_WRITE; else process.env.NUVIZZ_ADDRESS_WRITE = prev; }
});

test('the brake is DEFAULT-OFF-THE-BRAKE, and a typo leaves the feature ON', () => {
  // A typo in an env var must never silently disable a rule: that failure is invisible, and a
  // quiet feature looks exactly like a working one.
  const prev = process.env.NUVIZZ_ADDRESS_WRITE;
  try {
    for (const v of [undefined, '', '1', 'true', 'on', 'yes', 'offf', 'disabled', 'nope!']) {
      if (v === undefined) delete process.env.NUVIZZ_ADDRESS_WRITE; else process.env.NUVIZZ_ADDRESS_WRITE = v;
      assert.equal(addressWriteBlocked(), false, `${JSON.stringify(v)} must leave the push working`);
    }
  } finally { if (prev === undefined) delete process.env.NUVIZZ_ADDRESS_WRITE; else process.env.NUVIZZ_ADDRESS_WRITE = prev; }
});

// ── the log row ──────────────────────────────────────────────────────────────

const BEFORE = { addr1: '1 WRONG ST', city: 'BUFORD', state: 'GA', zip: '30518' };
const AFTER = { addr1: '800 N COMMERCE ST', city: 'MONROE', state: 'GA', zip: '30655' };
const base = { at: '2026-09-14T12:00:00.000Z', date: '2026-09-14', stopNbr: 'ESTES-1', source: 'override', before: BEFORE, after: AFTER };

test('HOW FAR IT REACHED is recorded as a tri-state, so "never tried" is not "refused"', () => {
  assert.equal(buildAddressChangeRow({ ...base, nuvizz: true }).nuvizz, true);
  assert.equal(buildAddressChangeRow({ ...base, nuvizz: false }).nuvizz, false, 'attempted and did NOT take');
  assert.equal(buildAddressChangeRow({ ...base }).nuvizz, null, 'board-only — nobody asked for the vendor half');
});

test('only a real boolean counts — a truthy string cannot claim the manifest is fixed', () => {
  for (const junk of ['true', 'yes', 1, {}, 'landed']) {
    assert.equal(buildAddressChangeRow({ ...base, nuvizz: junk }).nuvizz, null, `${JSON.stringify(junk)} is not an observation`);
  }
});

test('it stayed a FIELD, not a new source — or the screen’s own "Us" filter would hide it', () => {
  // The endpoint matches source exactly (selectAddressChanges), and the "Us" pill sends
  // source=override. A pushed correction filed under "override-nuvizz" would vanish from the
  // one filter a dispatcher reaches for — dropping precisely the rows that changed the most.
  assert.equal(buildAddressChangeRow({ ...base, nuvizz: true }).source, 'override');
});

// ── the promises the UI makes ────────────────────────────────────────────────

test('THE BOARD HALF NEVER DEPENDS ON THE VENDOR HALF', () => {
  // Firestore is written before the push is even considered: an address the dispatcher typed
  // is saved whatever NuVizz does with it.
  const save = MODAL;
  const firestoreAt = save.indexOf("setDoc(doc(db, 'customer_notes'");
  const pushAt = save.indexOf('await setStopAddress(');
  assert.ok(firestoreAt > 0 && pushAt > firestoreAt, 'the durable half goes first');
  assert.match(save, /if \(!\(canPush && toNuvizz\)\)/, 'and the push is a choice, not the path');
});

test('NEVER AN INTENT AS AN OUTCOME: the modal reports what NuVizz stored', () => {
  const save = MODAL;
  assert.match(save, /NuVizz now reads \$\{out\.now\}/, 'the read-back, not the payload');
  // The board-only path closes; the pushed path must NOT close before the vendor answers.
  const pushBlock = save.slice(save.indexOf("setPush({ kind: 'busy'"));
  assert.ok(!/onClose\(\)/.test(pushBlock.slice(0, pushBlock.indexOf('logAddressOverride'))),
    'the modal stays open until the write has been read back');
});

test('a REFUSED push is amber, states the saved half first, and names the portal', () => {
  const save = MODAL;
  assert.match(save, /kind: 'warn', text: `Saved on the board, but NuVizz did not take it/);
  assert.match(save, /fix the order in the portal/, 'a dispatcher needs the next action, not just the failure');
});

test('the log records the OUTCOME of the push, not the attempt', () => {
  const save = MODAL;
  assert.match(save, /logAddressOverride\(\{ stop, before: wasShowing, after: fields, source: 'override', nuvizz: landed \}\)/);
  const pushBlock = save.slice(save.indexOf("setPush({ kind: 'busy'"));
  assert.ok(pushBlock.indexOf('await setStopAddress(') < pushBlock.indexOf('nuvizz: landed'),
    'logged after the vendor half resolves');
});

test('DELIVERED FREIGHT IS NOT OFFERED A RE-ADDRESS, and the modal says why', () => {
  const save = MODAL;
  assert.match(save, /const executed = kind === 'DELIVERED' \|\| kind === 'ARRIVED' \|\| kind === 'EXCEPTION'/);
  assert.match(save, /const canPush = !!pro && !executed/);
  assert.match(save, /delivered freight cannot be re-addressed in NuVizz/, 'never silently drop the option');
});

test('THE ONE-CLICK FIX STAYS BOARD-ONLY, and the banner says so', () => {
  const banner = fnSource('AddressFixBanner');
  assert.ok(!/setStopAddress/.test(banner), 'a vendor write from one unconfirmed tap is how the wrong twin gets re-addressed');
  assert.match(banner, /To correct the order in NuVizz too, use Edit…/);
});

test('BOTH VIEWS GET IT: four mounts — Map and Routing, phone and desktop each', () => {
  // Chad, repeatedly: mobile and desktop are TWO VIEWS, and a screen added to one navigation
  // and not the other is a screen that does not exist on a phone. Both screens already mount
  // this editor separately per view (MapScreen's isMobile branch and its desktop one;
  // RoutingScreen's sheet and its desktop rail), so the push cannot reach three of the four.
  assert.equal((APP.match(/<AddressEditModal/g) || []).length, 4,
    'Map phone + Map desktop + Routing phone + Routing desktop');
});

test('A VENDOR-HALF THROW IS STILL AMBER, AND STILL LOGGED', () => {
  // The outer catch ends in setErr — a RED "Could not save" over an address that IS saved,
  // which is the exact lie the amber wording exists to prevent — and it returns before the
  // log, so the one failure most worth a record would leave none. The push gets its own
  // try/catch for both reasons.
  const push = MODAL.slice(MODAL.indexOf("setPush({ kind: 'busy'"));
  const inner = push.indexOf('try {');
  const call = push.indexOf('await setStopAddress(');
  const innerCatch = push.indexOf('} catch (e) {', inner);
  const log = push.indexOf('nuvizz: landed');
  assert.ok(inner > 0 && inner < call, 'the vendor call is inside its own try');
  assert.ok(innerCatch > call && innerCatch < log, 'and its catch falls through to the log, not past it');
  assert.ok(!/setErr\(/.test(push.slice(inner, log)), 'a failed push never renders as a red save error');
});

test('the warn branch is reached by a throw as well as by a refusal', () => {
  const push = MODAL.slice(MODAL.indexOf("setPush({ kind: 'busy'"));
  assert.match(push, /if \(!landed\) \{/, 'one warn for both failure shapes — not a branch each');
  assert.ok(push.indexOf('let landed = false') < push.indexOf('await setStopAddress('),
    'landed starts false, so nothing but an observed ok can set it true');
});
