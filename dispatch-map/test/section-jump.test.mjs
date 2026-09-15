// test/section-jump.test.mjs — the Manifest screen's section dropdown.
//
// Chad: "need a dropdown in the ui for all the different sections of this page." Five stacked
// panels, one of which is a suspects table that runs to hundreds of rows on the night it
// matters. These pin the two things that actually break: the sticky-bar offset, and offering a
// section that is not on the screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MANIFEST_SECTIONS, JUMP_OFFSET_DESKTOP, JUMP_OFFSET_PHONE, sectionScrollTop, visibleSections,
} from '../src/lib/section-jump.js';

test('the jump lands the section BELOW the sticky picker, not under it', () => {
  // The failure this prevents: scrolling the section to the top of the container puts it
  // behind the bar you used to get there — the one heading you asked for is the one you
  // cannot see, and it reads as a jump that went to the wrong place.
  const top = sectionScrollTop({ elTop: 900, containerTop: 100, containerScrollTop: 300, offset: 64 });
  assert.equal(top, 900 - 100 + 300 - 64);
  // The phone's picker is taller (it is full width, under the title), so its offset is bigger.
  assert.ok(JUMP_OFFSET_PHONE > JUMP_OFFSET_DESKTOP);
});

test('a section near the very top never asks for a negative scroll', () => {
  // Some browsers honour a negative scrollTop by bouncing the whole pane.
  assert.equal(sectionScrollTop({ elTop: 110, containerTop: 100, containerScrollTop: 0, offset: 64 }), 0);
});

test('a missing measurement returns null rather than scrolling to zero', () => {
  // Absent is not zero: a failed read must not silently fling the page to the top.
  assert.equal(sectionScrollTop({ elTop: null, containerTop: 100, containerScrollTop: 0 }), null);
  assert.equal(sectionScrollTop({}), null);
  assert.equal(sectionScrollTop({ elTop: 900, containerTop: undefined, containerScrollTop: 0 }), null);
});

test("a section that is not on the screen is not in the dropdown", () => {
  // Tonight's check does not exist until a report has been read. An entry that scrolls nowhere
  // is indistinguishable from a broken one.
  const withoutResult = visibleSections(['mailbox', 'arrivals', 'forecast', 'history']);
  assert.deepEqual(withoutResult.map((s) => s.key), ['mailbox', 'arrivals', 'forecast', 'history']);
  const withResult = visibleSections(new Set(['mailbox', 'check', 'arrivals', 'forecast', 'history']));
  assert.deepEqual(withResult.map((s) => s.key), ['mailbox', 'check', 'arrivals', 'forecast', 'history']);
});

test('the dropdown always reads top-to-bottom like the page, whatever order the keys arrive in', () => {
  const jumbled = visibleSections(['history', 'mailbox', 'forecast']);
  assert.deepEqual(jumbled.map((s) => s.key), ['mailbox', 'forecast', 'history']);
});

test('every section carries a label a dispatcher would recognise', () => {
  assert.equal(MANIFEST_SECTIONS.length, 5);
  for (const s of MANIFEST_SECTIONS) {
    assert.ok(s.key && /^[a-z]+$/.test(s.key), `${s.key} is a usable data-section value`);
    assert.ok(s.label && s.label.length > 2);
  }
  assert.equal(visibleSections([]).length, 0);
});
