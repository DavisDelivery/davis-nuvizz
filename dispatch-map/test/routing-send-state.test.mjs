// test/routing-send-state.test.mjs — what is in NuVizz, and what is only on this screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cardSendState, routePaintSource } from '../src/lib/routing-select.js';

// ── the card chip ──
test('A CARD WITH STAGED CHANGES SAYS SO — the old signal was a button disappearing', () => {
  const s = cardSendState({ dirty: true });
  assert.equal(s.kind, 'unsent');
  assert.equal(s.tone, 'amber');
  assert.match(s.label, /Not sent to NuVizz/);
});

test('a confirmed save turns it green, and only a confirmed save can', () => {
  assert.equal(cardSendState({ dirty: false, savedAt: 1757000000000 }).kind, 'sent');
  // Still dirty after a save (the dispatcher moved another stop) → back to not-sent.
  assert.equal(cardSendState({ dirty: true, savedAt: 1757000000000 }).kind, 'unsent');
});

test('an untouched card does not claim to have been sent', () => {
  const s = cardSendState({ dirty: false, savedAt: null });
  assert.equal(s.kind, 'clean');
  assert.equal(s.tone, 'slate');
  assert.ok(!/Sent/.test(s.label), `a card nobody saved must not read as sent: ${s.label}`);
});

test('A NEW ROUTE IS "NOT CREATED" — the load does not exist in NuVizz at all yet', () => {
  assert.equal(cardSendState({ dirty: true, pendingCreate: true }).kind, 'new');
  // …and an EMPTY new-route card still says so: nothing is dirty, but there is no load either.
  assert.equal(cardSendState({ dirty: false, pendingCreate: true }).kind, 'new');
  // Once created and verified, it is an ordinary sent card.
  assert.equal(cardSendState({ dirty: false, pendingCreate: true, savedAt: 1757000000000 }).kind, 'sent');
});

test('BETA WINS OVER EVERY NOT-SENT WORDING — the button is blue and says "Save (2)" and sends nothing', () => {
  assert.equal(cardSendState({ dirty: true, liveMode: false }).kind, 'beta');
  assert.equal(cardSendState({ dirty: true, pendingCreate: true, liveMode: false }).kind, 'beta');
  // A card already written in Live, now viewed in Beta with nothing staged, is still sent.
  assert.equal(cardSendState({ dirty: false, savedAt: 1757000000000, liveMode: false }).kind, 'sent');
});

test('called with nothing, it never claims anything was sent', () => {
  assert.equal(cardSendState().kind, 'clean');
  assert.equal(cardSendState({}).kind, 'clean');
});

// ── what the map paints ──
test('open cards are the working set — the map paints them', () => {
  assert.equal(routePaintSource({ openCards: 2, planStaged: true }), 'cards');
  assert.equal(routePaintSource({ openCards: 1, planStaged: false }), 'cards');
});

test('CLOSING THE LAST STAGED CARD LETS THE STOPS GO — it must not fall back to the engine plan', () => {
  // The v1.19.0 bug: build → auto-staged cards → close them → the same stops came back
  // numbered and route-coloured off the build result, with nothing sent to NuVizz.
  assert.equal(routePaintSource({ openCards: 0, planStaged: true }), 'none');
});

test('a plan that was never staged still paints — that is how you see the build on the map', () => {
  assert.equal(routePaintSource({ openCards: 0, planStaged: false }), 'plan');
  assert.equal(routePaintSource(), 'plan');
});
