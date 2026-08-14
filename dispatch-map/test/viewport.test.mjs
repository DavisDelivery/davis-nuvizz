// test/viewport.test.mjs
//
// The grey slab (Chad, v0.54.69 phone screenshot): the board list squeezed into three rows
// with the bottom quarter of the screen dead grey. The shell is pinned to a PIXEL height read
// from visualViewport; he had typed in the search box, and when the keyboard went away iOS
// never fired the final resize. The shell kept the keyboard-sized height, and the grey was
// the page showing through underneath it.
//
// The rule these tests pin: a visual viewport SHORTER than the layout viewport is only
// believable while something is focused. Nothing focused → the layout viewport wins.
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveViewportSize, raisesKeyboard, readViewportSize } from '../src/lib/viewport.js';

// An iPhone 14: 390×844 layout, and 390×630 visible once the keyboard is up.
const PHONE = { innerWidth: 390, innerHeight: 844, clientWidth: 390, clientHeight: 844 };

test('the ordinary case: visible viewport === layout viewport', () => {
  const s = resolveViewportSize({ ...PHONE, vvWidth: 390, vvHeight: 844, keyboardOpen: false });
  assert.deepEqual(s, { h: 844, w: 390, x: 0, y: 0 });
});

test('KEYBOARD UP: the shell shrinks to the visible area, and keeps the offset', () => {
  // This is the behaviour the whole pixel-height design exists for — the UI must sit above
  // the keyboard, not behind it.
  const s = resolveViewportSize({ ...PHONE, vvWidth: 390, vvHeight: 630, vvTop: 24, vvLeft: 8, keyboardOpen: true });
  assert.equal(s.h, 630, 'the shell fits the area above the keyboard');
  assert.equal(s.y, 24, 'and tracks where iOS scrolled the visible area to');
  assert.equal(s.x, 8);
});

test('THE GREY SLAB: a stale keyboard-height reading with nothing focused is discarded', () => {
  // Exactly Chad's screenshot: iOS still reporting 630 after the keyboard closed.
  const s = resolveViewportSize({ ...PHONE, vvWidth: 390, vvHeight: 630, keyboardOpen: false });
  assert.equal(s.h, 844, 'the shell fills the phone again — no dead band under the tab bar');
  assert.equal(s.w, 390);
});

test('a stale visual-viewport OFFSET is dropped too, so the shell can\'t sit skewed', () => {
  const s = resolveViewportSize({ ...PHONE, vvWidth: 390, vvHeight: 630, vvTop: 40, vvLeft: 12, keyboardOpen: false });
  assert.equal(s.x, 0);
  assert.equal(s.y, 0);
});

test('a TALLER visible viewport is real and is kept — scrolled-away iOS toolbars', () => {
  // When Safari's toolbars minimise, the visible area is bigger than the layout viewport.
  // The fix must be a floor, never an overwrite, or the app would shrink as you scroll.
  const s = resolveViewportSize({ ...PHONE, vvWidth: 390, vvHeight: 900, keyboardOpen: false });
  assert.equal(s.h, 900);
});

test('the WIDTH stays pinned to the visible width, idle or not', () => {
  // iOS's layout viewport can be a few px wider than the visible one; matching the wider
  // value is what pushes the last tab and the AI button off the right edge.
  const idle = resolveViewportSize({ ...PHONE, vvWidth: 384, vvHeight: 844, keyboardOpen: false });
  assert.equal(idle.w, 384, 'the narrower VISIBLE width wins — the height rule must not leak into the width');
  const typing = resolveViewportSize({ ...PHONE, vvWidth: 384, vvHeight: 630, keyboardOpen: true });
  assert.equal(typing.w, 384);
});

test('no visualViewport at all (older browsers) falls back to the layout viewport', () => {
  const s = resolveViewportSize({ ...PHONE, vvWidth: 0, vvHeight: 0, keyboardOpen: false });
  assert.deepEqual(s, { h: 844, w: 390, x: 0, y: 0 });
  assert.deepEqual(resolveViewportSize({}), { h: 0, w: 0, x: 0, y: 0 }, 'no measurements at all → zeros, never NaN');
});

test('garbage measurements never become NaN or a negative height', () => {
  for (const bad of [NaN, -1, null, undefined, 'tall']) {
    const s = resolveViewportSize({ ...PHONE, vvHeight: bad, vvWidth: bad, keyboardOpen: false });
    assert.ok(Number.isFinite(s.h) && s.h > 0, `h stayed sane for ${String(bad)}`);
    assert.ok(Number.isFinite(s.w) && s.w > 0, `w stayed sane for ${String(bad)}`);
  }
});

// ── which elements actually raise a keyboard ─────────────────────────────────

const el = (tagName, extra = {}) => ({ tagName, getAttribute: () => null, ...extra });

test('raisesKeyboard: text fields, textareas and iOS\'s select picker', () => {
  assert.equal(raisesKeyboard(el('INPUT', { type: 'text' })), true);
  assert.equal(raisesKeyboard(el('INPUT', { type: 'tel' })), true);
  assert.equal(raisesKeyboard(el('INPUT', {})), true, 'no type attribute means text');
  assert.equal(raisesKeyboard(el('TEXTAREA')), true);
  // A <select> raises the picker wheel, which shrinks the visual viewport exactly like the
  // keyboard — treating it as "nothing focused" would fight the picker for the screen.
  assert.equal(raisesKeyboard(el('SELECT')), true);
  assert.equal(raisesKeyboard({ tagName: 'DIV', isContentEditable: true, getAttribute: () => null }), true);
  assert.equal(raisesKeyboard({ tagName: 'DIV', getAttribute: (k) => (k === 'role' ? 'textbox' : null) }), true);
});

test('raisesKeyboard: buttons and toggles raise nothing', () => {
  for (const type of ['button', 'submit', 'checkbox', 'radio', 'range', 'file']) {
    assert.equal(raisesKeyboard(el('INPUT', { type })), false, type);
  }
  assert.equal(raisesKeyboard(el('BUTTON')), false);
  assert.equal(raisesKeyboard({ tagName: 'DIV', getAttribute: () => null }), false);
  assert.equal(raisesKeyboard(null), false, 'nothing focused');
});

// ── the live reader ──────────────────────────────────────────────────────────

test('readViewportSize: reads the browser and applies the rule', () => {
  const win = {
    visualViewport: { height: 630, width: 390, offsetLeft: 0, offsetTop: 0 },
    innerHeight: 844, innerWidth: 390,
    document: { documentElement: { clientHeight: 844, clientWidth: 390 }, activeElement: { tagName: 'BODY', getAttribute: () => null } },
  };
  assert.equal(readViewportSize(win).h, 844, 'stale shrink with BODY focused is discarded');
  win.document.activeElement = { tagName: 'INPUT', type: 'search', getAttribute: () => null };
  assert.equal(readViewportSize(win).h, 630, 'the same reading is believed while the search box has focus');
  assert.deepEqual(readViewportSize(null), { h: 0, w: 0, x: 0, y: 0 }, 'SSR');
});
