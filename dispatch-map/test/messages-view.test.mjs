// test/messages-view.test.mjs — the Messages panel's display rules (src/lib/messages-view.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIST_FILTERS, inFilter, filterThreads, listTime, dayLabel, previewOf, threadLayout, outboundState, NO_TEXT,
} from '../src/lib/messages-view.js';

// A fixed local "now": Wednesday 2026-09-30, 3:00 PM.
const NOW = new Date(2026, 8, 30, 15, 0, 0);
const ago = (mins) => new Date(NOW.getTime() - mins * 60000).toISOString();

const T = (over) => ({ phone: '7705550100', name: null, group: 'customer', unread: false, last: { text: 'ok', direction: 'in' }, ...over });

test('a reply from twelve minutes ago reads 12m — is somebody waiting on me', () => {
  assert.equal(listTime(ago(0.5), NOW), 'Now');
  assert.equal(listTime(ago(12), NOW), '12m');
  assert.equal(listTime(ago(59), NOW), '59m');
});

test('a customer who texted this morning reads as a clock time, not "5h"', () => {
  const nineForty = new Date(2026, 8, 30, 9, 40).toISOString();
  assert.match(listTime(nineForty, NOW), /^9:40\s?AM$/);
});

test('older texts read Yesterday, then a weekday, then a date', () => {
  assert.equal(listTime(new Date(2026, 8, 29, 18, 0).toISOString(), NOW), 'Yesterday');
  assert.equal(listTime(new Date(2026, 8, 27, 10, 0).toISOString(), NOW), 'Sun');
  assert.equal(listTime(new Date(2026, 8, 12, 10, 0).toISOString(), NOW), 'Sep 12');
  assert.equal(listTime(new Date(2025, 11, 2, 10, 0).toISOString(), NOW), '12/2/25');
});

test('a text sent at 11:58pm still reads in minutes after midnight', () => {
  const now = new Date(2026, 9, 1, 0, 5);
  assert.equal(listTime(new Date(2026, 8, 30, 23, 58).toISOString(), now), '7m');
});

test('a missing or malformed time reads blank, never "NaN"', () => {
  assert.equal(listTime(null, NOW), '');
  assert.equal(listTime('not a date', NOW), '');
  assert.equal(dayLabel(undefined, NOW), '');
});

test('an inbound text with no words reads "No text" — never a dash, never a guessed "Photo"', () => {
  // The webhook stores text:'' and drops mediaItems, so what it carried is not known here.
  assert.deepEqual(previewOf({ text: '', direction: 'in' }), { text: NO_TEXT, empty: true, mine: false });
  assert.deepEqual(previewOf({ text: '   ', direction: 'in' }), { text: NO_TEXT, empty: true, mine: false });
  assert.equal(previewOf(undefined).text, NO_TEXT);
  assert.equal(NO_TEXT, 'No text');
});

test('our own last word in a conversation is marked as ours', () => {
  assert.deepEqual(previewOf({ text: 'On the way', direction: 'out' }), { text: 'On the way', empty: false, mine: true });
});

test('Drivers keeps drivers AND contractors; Customers keeps unnamed numbers; Team is in neither', () => {
  assert.deepEqual(LIST_FILTERS.map((f) => f.key), ['all', 'unread', 'drivers', 'customers']);
  assert.equal(inFilter(T({ group: 'driver' }), 'drivers'), true);
  assert.equal(inFilter(T({ group: 'contractor' }), 'drivers'), true);
  assert.equal(inFilter(T({ group: 'customer' }), 'drivers'), false);
  assert.equal(inFilter(T({ group: null }), 'customers'), true);
  assert.equal(inFilter(T({ group: 'team' }), 'customers'), false);
  assert.equal(inFilter(T({ group: 'team' }), 'drivers'), false);
  assert.equal(inFilter(T({ group: 'team' }), 'all'), true);
});

test('the conversation being read stays under "Unread" after opening it marks it read', () => {
  const threads = [T({ phone: '1', unread: true }), T({ phone: '2', unread: false }), T({ phone: '3', unread: false })];
  assert.deepEqual(filterThreads(threads, { filter: 'unread' }).map((t) => t.phone), ['1']);
  assert.deepEqual(filterThreads(threads, { filter: 'unread', activePhone: '2' }).map((t) => t.phone), ['1', '2']);
});

test('search matches a name, the digits of a number however it is typed, or the words of the last text', () => {
  const threads = [
    T({ phone: '6785317090', name: null, last: { text: 'Thanks', direction: 'in' } }),
    T({ phone: '7707586206', name: 'Kobe Boakye', group: 'contractor', last: { text: 'He delivered 3 pallets.', direction: 'in' } }),
  ];
  assert.deepEqual(filterThreads(threads, { query: 'kobe' }).map((t) => t.phone), ['7707586206']);
  assert.deepEqual(filterThreads(threads, { query: '(678) 531' }).map((t) => t.phone), ['6785317090']);
  assert.deepEqual(filterThreads(threads, { query: 'pallets' }).map((t) => t.phone), ['7707586206']);
  assert.deepEqual(filterThreads(threads, { query: 'pallets', filter: 'customers' }), []);
});

test('a thread breaks into day dividers and five-minute runs, one stamp per run', () => {
  const m = (min, direction, extra = {}) => ({ at: new Date(2026, 8, 30, 9, min).toISOString(), direction, text: 'x', ...extra });
  const msgs = [
    { at: new Date(2026, 8, 29, 17, 0).toISOString(), direction: 'in', text: 'y' },
    m(0, 'in'), m(2, 'in'), m(20, 'in'), m(21, 'out'), m(22, 'out'),
  ];
  const L = threadLayout(msgs);
  assert.deepEqual(L.map((x) => x.newDay), [true, true, false, false, false, false]);
  assert.deepEqual(L.map((x) => x.runStart), [true, true, false, true, true, false]);
  assert.deepEqual(L.map((x) => x.runEnd), [true, false, true, true, false, true]);
});

test('two texts that failed back to back each get their own Retry', () => {
  const at = (min) => new Date(2026, 8, 30, 9, min).toISOString();
  const msgs = [
    { at: at(0), direction: 'out', text: 'a' },
    { at: at(1), direction: 'out', text: 'b', status: 'failed' },
    { at: at(1), direction: 'out', text: 'c', status: 'failed' },
  ];
  assert.deepEqual(threadLayout(msgs).map((x) => x.runEnd), [true, true, true]);
});

test('a sent text says "Sent" and never "Delivered" — nothing here sees the handset', () => {
  assert.deepEqual(outboundState({ direction: 'out' }), { label: 'Sent', failed: false });
  assert.deepEqual(outboundState({ direction: 'out', status: 'sent' }), { label: 'Sent', failed: false });
  assert.deepEqual(outboundState({ direction: 'out', status: 'sending' }), { label: 'Sending…', failed: false });
  assert.deepEqual(outboundState({ direction: 'out', status: 'failed', error: 'daily cap reached' }),
    { label: 'Not delivered', failed: true, reason: 'daily cap reached' });
  assert.equal(outboundState({ direction: 'in' }), null);
});

test('day dividers read Today, Yesterday, a weekday, then a date', () => {
  assert.equal(dayLabel(new Date(2026, 8, 30, 8).toISOString(), NOW), 'Today');
  assert.equal(dayLabel(new Date(2026, 8, 29, 8).toISOString(), NOW), 'Yesterday');
  assert.equal(dayLabel(new Date(2026, 8, 27, 8).toISOString(), NOW), 'Sunday');
  assert.equal(dayLabel(new Date(2026, 8, 12, 8).toISOString(), NOW), 'Sat, Sep 12');
});
