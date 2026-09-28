// test/stop-lookup-history-button.test.mjs — "Open this order's full history" goes somewhere.
//
// Chad, 2026-09-28, on an order opened from its own full history: "when you click open orders full
// history nothing happens." The button re-runs the lookup for the order's PRO — and on that PRO's
// own history it re-ran the page it sits on. From a customer list it did switch, but on a desktop
// the new page stayed scrolled where the old list was, which also read as nothing happening.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { historyShowsOrder } from '../src/lib/stop-lookup.js';

const HISTORY = {
  ok: true, mode: 'stop', candidates: ['007181840', '7181840'],
  dossier: { found: true, query: '007181840', identity: { pro: '007181840', stopNbr: '007181840' } },
};

test('ON THE ORDER\'S OWN FULL HISTORY, the button would re-run the page it sits on', () => {
  assert.equal(historyShowsOrder(HISTORY, '007181840'), true);
  assert.equal(historyShowsOrder(HISTORY, '7181840'), true, 'leading zeros do not make it another order');
  assert.equal(historyShowsOrder({ ...HISTORY, candidates: [] }, '007181840'), true, 'the identity alone is enough');
});

test('anywhere else it goes somewhere — another order, a customer, an address, a miss', () => {
  assert.equal(historyShowsOrder(HISTORY, '007181841'), false, 'another order on the same screen');
  assert.equal(historyShowsOrder({ ...HISTORY, mode: 'customer' }, '007181840'), false, 'a customer\'s list');
  assert.equal(historyShowsOrder({ ...HISTORY, mode: 'place' }, '007181840'), false, 'an address or city list');
  assert.equal(historyShowsOrder({ ...HISTORY, dossier: { ...HISTORY.dossier, found: false } }, '007181840'), false, 'nothing on file');
  assert.equal(historyShowsOrder(null, '007181840'), false);
  assert.equal(historyShowsOrder(HISTORY, ''), false, 'no PRO is never "this order"');
  assert.equal(historyShowsOrder(HISTORY, '0000'), false, 'all zeros is not a PRO');
});

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
function fnSource(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  const next = APP.indexOf('\nfunction ', start + 1);
  return APP.slice(start, next > 0 ? next : undefined);
}

test('the panel gets the button only when it goes somewhere', () => {
  assert.match(APP, /onClose=\{closeOrder\} onOpenHistory=\{historyShowsOrder\(data, pro\) \? null : \(\) => pick\(pro\)\} \/>/);
  const body = fnSource('OrderDetailBody');
  assert.match(body, /\{onOpenHistory \? \(\s*<button onClick=\{onOpenHistory\}/);
  // …and where it does not, the panel says where the rep already is rather than leaving a gap.
  assert.match(body, /This is the order&rsquo;s full history &mdash; every day it was on file is in the list above\./);
});

test('THE JUMP LANDS ON THE NEW PAGE\'S START — on a desktop too, and upward', () => {
  const screen = fnSource('StopLookupScreen');
  const pick = screen.slice(screen.indexOf('const pick = useCallback('), screen.indexOf('}, [run, closeOrder]);'));
  assert.ok(pick.indexOf('jumpRef.current = true;') > -1 && pick.indexOf('jumpRef.current = true;') < pick.indexOf('run(pro)'), 'marked before the lookup runs');
  assert.match(screen, /if \(!answerTick \|\| !\(jump \|\| isMobileRef\.current\)\) return;/, 'every width when it is the jump');
  assert.match(screen, /if \(jump \? Math\.abs\(top - box\.scrollTop\) > 4 : top > box\.scrollTop\) box\.scrollTo\(/, 'up as well as down');
});
