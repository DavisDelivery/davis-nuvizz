// THE WALL KEEPS ITS PINS — the rule that decides whether a stop's pin can stay on the television's
// live map across a board refresh. See src/lib/tv-pin-reuse.js for the measurement behind it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pinKeyer, iconSig, pinSig } from '../src/lib/tv-pin-reuse.js';

const icon = (url = 'data:image/svg+xml;a', w = 16, x = 8) => ({ url, scaledSize: { width: w, height: w }, anchor: { x, y: x } });
const pin = (o = {}) => ({ position: { lat: 34.05, lng: -84.07 }, icon: icon(), title: 'CUSTOMER 1', opacity: 1, zIndex: undefined, hover: null, ...o });

test('AN UNCHANGED STOP KEEPS ITS PIN — the same stop on the next 2-minute refresh signs the same, so the wall leaves it alone', () => {
  // Fresh objects every time, exactly as a refresh delivers them: equality is by contents.
  assert.equal(pinSig(pin()), pinSig(pin()));
});

test('A CLEARED ICON CACHE DOES NOT REPAINT THE WALL — two icon objects drawing the same picture sign the same', () => {
  const a = icon(); const b = icon();
  assert.notEqual(a, b);
  assert.equal(iconSig(a), iconSig(b));
});

test('A STOP THAT IS DELIVERED GETS A NEW PIN — a different icon is a different pin', () => {
  assert.notEqual(pinSig(pin()), pinSig(pin({ icon: icon('data:image/svg+xml;delivered') })));
});

test('A PIN THAT MOVES SIZE TIER OR ANCHOR IS A NEW PIN, even with the same picture', () => {
  assert.notEqual(iconSig(icon('u', 16, 8)), iconSig(icon('u', 22, 8)));
  assert.notEqual(iconSig(icon('u', 16, 8)), iconSig(icon('u', 16, 11)));
});

test('A STOP WHOSE ADDRESS WAS CORRECTED MOVES — position is part of the pin', () => {
  assert.notEqual(pinSig(pin()), pinSig(pin({ position: { lat: 34.06, lng: -84.07 } })));
  assert.notEqual(pinSig(pin()), pinSig(pin({ position: { lat: 34.05, lng: -84.08 } })));
});

test('DIMMING, STACKING AND THE NAME ALL COUNT — and "no zIndex" is not "zIndex 0"', () => {
  assert.notEqual(pinSig(pin()), pinSig(pin({ opacity: 0.3 })));
  assert.notEqual(pinSig(pin({ zIndex: undefined })), pinSig(pin({ zIndex: 0 })));
  assert.notEqual(pinSig(pin()), pinSig(pin({ title: 'CUSTOMER 1 (RENAMED)' })));
});

test('RECEIVING HOURS TYPED ON A STOP GIVE IT A NEW PIN — the hover text it shows is part of what it does', () => {
  assert.notEqual(pinSig(pin({ hover: null })), pinSig(pin({ hover: '7:00a–3:00p' })));
  assert.notEqual(pinSig(pin({ hover: '7:00a–3:00p' })), pinSig(pin({ hover: '7:00a–2:00p' })));
});

test('TWO ORDERS ON ONE STOP NUMBER KEEP SEPARATE PINS — keys count occurrences, in board order', () => {
  const k = pinKeyer();
  assert.deepEqual(['0071', '0072', '0071', '0071'].map(k), ['0071#1', '0072#1', '0071#2', '0071#3']);
  // A fresh keyer per refresh gives the same keys for the same board.
  const k2 = pinKeyer();
  assert.deepEqual(['0071', '0072', '0071', '0071'].map(k2), ['0071#1', '0072#1', '0071#2', '0071#3']);
});

test('A STOP WITH NO NUMBER STILL GETS A KEY — never undefined, never a crash', () => {
  const k = pinKeyer();
  assert.deepEqual([undefined, null, undefined].map(k), ['#1', '#2', '#3']);
});

test('NO ICON, A STRING ICON, AND NOTHING AT ALL are all answerable', () => {
  assert.equal(iconSig(null), '');
  assert.equal(iconSig('https://x/pin.png'), 'https://x/pin.png');
  assert.equal(typeof pinSig(), 'string');
});
