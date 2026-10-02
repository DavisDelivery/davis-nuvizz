// src/lib/messages-view.js
//
// The Messages panel's display rules, kept out of the component so they can be tested: what a
// conversation row's time reads, what its preview says, which conversations a filter keeps,
// where a thread breaks into days and runs, and what a sent bubble may claim about itself.
//
// Nothing here fetches, writes or sends. The panel (components/MessagesPanel.jsx) owns that.

// The filter row over the conversation list. A dispatcher on a bad day triages by who is
// texting: a driver's "I'm at the dock and they're closed" is a different job from a
// customer's "please leave it by the garage door". Contractors drive, so they sit with Drivers.
// A number nobody has named is filed as a customer — the same default resolveContact uses.
export const LIST_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'drivers', label: 'Drivers' },
  { key: 'customers', label: 'Customers' },
];

const DRIVER_GROUPS = new Set(['driver', 'contractor']);

export function inFilter(thread, filter) {
  if (!thread) return false;
  if (filter === 'unread') return !!thread.unread;
  if (filter === 'drivers') return DRIVER_GROUPS.has(thread.group);
  if (filter === 'customers') return (thread.group || 'customer') === 'customer';
  return true;
}

// The conversation you are reading stays in the list whatever the filter says. Opening an
// unread thread under "Unread" reads it — and a row that vanished from under the cursor the
// moment it was clicked would leave the dispatcher looking at a reply with no row beside it.
export function filterThreads(threads, { filter = 'all', query = '', activePhone = null } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const qd = q.replace(/\D/g, '');
  return (threads || []).filter((t) => {
    if (!(inFilter(t, filter) || (activePhone && t.phone === activePhone))) return false;
    if (!q) return true;
    return (t.name || '').toLowerCase().includes(q)
      || (qd && String(t.phone || '').includes(qd))
      || (t.last?.text || '').toLowerCase().includes(q);
  });
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const dayBefore = (d) => { const x = new Date(d); x.setDate(x.getDate() - 1); return x; };
const clock = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

// The time on a conversation row. Inside the hour it is how long ago ("12m"), because that is
// the question a fresh text asks: is somebody waiting on me? Past that, today reads as a clock
// time — "Thank you, I will be here tomorrow" is only useful if you know WHEN it was said, and
// "5h" makes the dispatcher do arithmetic. Then Yesterday, a weekday, a date.
export function listTime(iso, now = new Date()) {
  if (!iso) return '';
  const d = new Date(iso);
  const ms = now.getTime() - d.getTime();
  if (!Number.isFinite(ms)) return '';
  if (ms < 60 * 1000) return 'Now';
  if (ms < 60 * 60 * 1000) return `${Math.floor(ms / 60000)}m`;
  if (sameDay(d, now)) return clock(d);
  if (sameDay(d, dayBefore(now))) return 'Yesterday';
  if (ms < 6 * 86400 * 1000) return d.toLocaleDateString('en-US', { weekday: 'short' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' });
}

// The full stamp, for a row's hover title.
export function fullTime(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// The divider between days inside a thread.
export function dayLabel(iso, now = new Date()) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  if (sameDay(d, now)) return 'Today';
  if (sameDay(d, dayBefore(now))) return 'Yesterday';
  if (now.getTime() - d.getTime() < 6 * 86400 * 1000) return d.toLocaleDateString('en-US', { weekday: 'long' });
  return d.toLocaleDateString('en-US', d.getFullYear() === now.getFullYear()
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

export function clockTime(iso) {
  const d = new Date(iso);
  return !iso || Number.isNaN(d.getTime()) ? '' : clock(d);
}

// A message with no words. The inbound webhook stores `text: ''` when the vendor sent none and
// does not keep its mediaItems, so the app cannot say what such a message carried — a photo is
// the likely case and is NOT a thing this screen knows. It says what it does know: no text.
export const NO_TEXT = 'No text';

export function previewOf(last) {
  if (!last) return { text: NO_TEXT, empty: true, mine: false };
  const text = String(last.text || '').trim();
  return { text: text || NO_TEXT, empty: !text, mine: last.direction === 'out' };
}

// Where a thread breaks. A day divider when the calendar day changes; a "run" is consecutive
// messages the same way within five minutes, drawn as one block with the time (and, for a text
// we sent, its state) under its last bubble — not a stamp on every line.
// A text that failed to send is always a run of its own: its Retry sits under it, and a failure
// folded into the middle of a run would have no button at all.
const RUN_GAP_MS = 5 * 60 * 1000;
const at = (m) => new Date(m?.at || 0).getTime();
const joins = (a, b) => !!a && !!b && a.direction === b.direction && a.status !== 'failed' && b.status !== 'failed'
  && sameDay(new Date(at(a)), new Date(at(b))) && at(b) - at(a) <= RUN_GAP_MS;

export function threadLayout(msgs) {
  const list = msgs || [];
  return list.map((m, i) => {
    const prev = list[i - 1];
    const next = list[i + 1];
    const newDay = !prev || !sameDay(new Date(at(prev)), new Date(at(m)));
    return { m, newDay, runStart: !joins(prev, m), runEnd: !joins(m, next) };
  });
}

// What a text we sent may say about itself. A message in the stream was recorded by send-sms
// only AFTER SimpleTexting accepted it, so "Sent" is true. "Delivered" would be a claim about
// the recipient's handset that nothing in this app observes, so it is never said.
export function outboundState(m) {
  if (!m || m.direction !== 'out') return null;
  if (m.status === 'sending') return { label: 'Sending…', failed: false };
  if (m.status === 'failed') return { label: 'Not delivered', failed: true, reason: m.error || '' };
  return { label: 'Sent', failed: false };
}
