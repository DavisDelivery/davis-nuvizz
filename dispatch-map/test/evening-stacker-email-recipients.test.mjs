// THE EVENING STACKER EMAIL ADDRESSES CUSTOMER SERVICE ONCE.
//
// recipientsFor('alertCc') already leads with customerservice@ (the channel's alwaysAlso) and
// de-duplicates it. The evening sweep then prepended ALERT_TO again, so every stacker email
// first seen the evening before — the "day before" case the feature exists for — went out with
// customerservice@ twice on its To: line. The day sweep never did this: it filters ALERT_TO out
// before rebuilding the list.
//
// Run for real: the evening handler at 9:30p EDT over the in-memory Firestore fake, with Resend
// intercepted. No network — the fake throws on anything that is not Firestore or Resend.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { ALERT_TO, ALERT_INTERNAL_SUFFIXES } from '../netlify/functions/lib/flag-alert.mts';

// A role address on the company domain, derived rather than typed (see no-lifelike-addresses).
const OPS = `ops${ALERT_INTERNAL_SUFFIXES[0]}`;

const DATE = '2026-09-01';                    // the board being built tonight
const NOW = '2026-09-01T01:30:00Z';           // 9:30pm EDT on Aug 31: the evening window
const boardPath = `nuvizz_stop_index/davis__${DATE}`;

const stacker = {
  stopNbr: '007180089', primaryPro: '007180089', businessName: 'WEST RIDGE CHURCH', addr1: '1 RIDGE RD',
  city: 'DALLAS', zip: '30132', lat: 33.92, lng: -84.84, normalizedStatus: 'SCHEDULED', status: '20',
  isPlanned: false, stopType: 'DO', orderInstructions: 'ORDER CONTAINS HYDRAULIC STACKER',
};

async function eveningStackerMail(stored) {
  const mail = [];
  const seed = {
    [boardPath]: { last_scanned_at: '2026-09-01T01:25:00Z' },
    [`${boardPath}/stops/${stacker.stopNbr}`]: stacker,
    ...(stored ? { 'nuvizz_ops/alert_recipients': stored } : {}),
  };
  const fake = installFirestoreFake(seed, async (url, init) => {
    if (url.startsWith('https://api.resend.com/')) {
      mail.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: 'm1' }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  try {
    const { default: handler } = await import('../netlify/functions/eta-flag-evening-background.mts');
    const res = await handler(new Request('https://example.test/.netlify/functions/eta-flag-evening-background'));
    const body = await res.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.stacker.sent, 1, JSON.stringify(body.stacker));
    const sent = mail.filter((m) => /tractor trailer/i.test(String(m.subject)));
    assert.equal(sent.length, 1);
    return sent[0].to;
  } finally {
    fake.restore();
  }
}

test('the evening stacker email lists customer service once on its To: line', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  process.env.RESEND_FROM = 'Dispatch <no-reply@example.com>';
  delete process.env.ALERT_CC;
  mock.timers.enable({ apis: ['Date'], now: new Date(NOW) });
  try {
    // Nothing saved, ALERT_CC unset: customer service alone.
    assert.deepEqual(await eveningStackerMail(null), [ALERT_TO]);
    // A saved CC list: customer service first, once, then the list.
    assert.deepEqual(
      await eveningStackerMail({ alertCc: [OPS] }),
      [ALERT_TO, OPS],
    );
  } finally {
    mock.timers.reset();
  }
});
