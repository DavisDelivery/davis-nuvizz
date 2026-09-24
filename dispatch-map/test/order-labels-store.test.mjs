// test/order-labels-store.test.mjs — the labels saved with each created order (order-labels
// function), run against the in-memory Firestore fake. The fake THROWS on any call that is
// not Firestore, so a green run is also the proof that saving and printing cost zero NuVizz calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';

delete process.env.AUTH_REQUIRED;

const fn = (path, init = {}) => new Request(`http://localhost/.netlify/functions/${path}`, init);
const post = (labels) => fn('order-labels', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ labels }) });

test('shapeLabel keeps what a label prints and drops an order with no number', async () => {
  const { shapeLabel, labelDocId } = await import('../netlify/functions/order-labels.mts');
  assert.equal(shapeLabel({ name: 'x' }), null);
  const l = shapeLabel({ stopNbr: ' SO-1 ', name: 'Acme', serviceDate: 'bogus', source: 'hacker', junk: 'x', origin: { name: 'Davis', addr1: '1' } }, '2026-09-24T12:00:00Z');
  assert.equal(l.stopNbr, 'SO-1');
  assert.equal(l.serviceDate, '');
  assert.equal(l.source, '');
  assert.equal(l.junk, undefined);
  assert.equal(l.origin.name, 'Davis');
  assert.notEqual(labelDocId('SO/1'), labelDocId('SO_1'), 'two numbers never share a doc');
});

test('saved labels read back by day and by number, and a re-created order replaces its label', async () => {
  const fake = installFirestoreFake();
  try {
    const { default: handler } = await import('../netlify/functions/order-labels.mts');
    const { etDayString } = await import('../netlify/functions/lib/firestore.mts');
    const day = etDayString();
    const a = { stopNbr: 'SO-1', name: 'Acme', pallets: '2', serviceDate: '2026-09-25', source: 'single' };
    const b = { stopNbr: 'ESTES-0288000001', name: 'Peachtree', loose: '1', serviceDate: '2026-09-25', source: 'manifest' };
    const r1 = await (await handler(post([a, b, { name: 'no number' }]))).json();
    assert.equal(r1.ok, true);
    assert.equal(r1.saved, 2);
    assert.equal(r1.dropped, 1);

    const list = await (await handler(fn(`order-labels?date=${day}`))).json();
    assert.deepEqual(list.labels.map((l) => l.stopNbr).sort(), ['ESTES-0288000001', 'SO-1']);

    await handler(post([{ ...a, pallets: '3' }]));
    const again = await (await handler(fn(`order-labels?date=${day}`))).json();
    assert.equal(again.labels.length, 2, 'the same order is one label, not two');
    assert.equal(again.labels.find((l) => l.stopNbr === 'SO-1').pallets, '3');

    const one = await (await handler(fn('order-labels?stop=ESTES-0288000001'))).json();
    assert.equal(one.label.name, 'Peachtree');
    const none = await (await handler(fn('order-labels?stop=NOPE'))).json();
    assert.equal(none.label, null);

    const days = await (await handler(fn('order-labels?list=1'))).json();
    assert.deepEqual(days.days, [{ date: day, count: 2 }]);

    // Its own collection: nothing it wrote lands anywhere else.
    assert.ok(fake.log.sets.every((s) => /^order_labels(_by_stop)?\//.test(s.path.replace(/^.*\/documents\//, ''))), JSON.stringify(fake.log.sets.map((s) => s.path)));
    assert.equal(fake.log.other.length, 0, 'zero calls outside Firestore');
  } finally { fake.restore(); }
});
