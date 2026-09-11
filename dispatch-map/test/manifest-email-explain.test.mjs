// THE DRY RUN — explainManifestEmails.
//
// Chad, on the Manifest history showing "1 report" for a night Uline had sent five times:
// "why is it only showing 1 report it should have parsed my email 3 times already."
//
// Four different causes fitted that symptom — the per-run cap, the PDF parse, the board diff,
// and the schedule — and from outside the job they are ONE blank screen: nothing written and
// nothing shown. CLAUDE.md's rule after the roster went four rounds undiagnosed is to build
// the free diagnostic before guessing, so this is the walk the real cycle makes, reported
// instead of executed.
//
// THE TEST THAT MATTERS MOST IS "it writes nothing" — a diagnostic with a side effect is a
// second bug wearing the first one's name, and this one runs against the live mailbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import { explainManifestEmails, MAX_EMAILS_PER_RUN, markerDocFor } from '../netlify/functions/lib/manifest-email-ingest.mts';

const pdf = (name = 'report.pdf') => ({ id: `a-${name}`, filename: name, contentType: 'application/pdf' });
const msg = (id, receivedAt, atts = [pdf()]) => ({
  id, receivedAt, from: 'outbound.logistics@uline.com',
  subject: 'G Uline Freight Report for DAVIS DELIVERY 09/10/26', attachments: atts,
});

/** A mailbox whose messages arrive NEWEST FIRST, exactly as Gmail's list does. */
const source = (messages, overrides = {}) => ({
  name: 'gmail',
  list: async () => [...messages].reverse(),
  download: async () => Buffer.from('%PDF-1.4 pretend'),
  ...overrides,
});

const deps = (over = {}) => ({
  fetchImpl: async () => { throw new Error('no network in this test'); },
  getDoc: async () => null,
  setDoc: async () => { throw new Error('explain must never write'); },
  runDiff: async () => ({ ok: true, manifest: { orders: 691 } }),
  ...over,
});

// ── the promise the whole thing rests on ─────────────────────────────────────

test('it WRITES NOTHING — not a marker, not a run doc, not an archive', async () => {
  // setDoc throws if touched, so any write at all fails this rather than being noticed later
  // by somebody wondering why a dry run marked their mail as handled.
  const writes = [];
  const out = await explainManifestEmails(deps({
    sources: [source([msg('a', 1), msg('b', 2), msg('c', 3)])],
    setDoc: async (path) => { writes.push(path); return true; },
    deep: true,
  }));
  assert.deepEqual(writes, []);
  assert.equal(out.wrote, 'nothing');
  assert.equal(out.nuvizzCalls, 0);
});

test('an archive callback is never even offered to it', async () => {
  let archived = 0;
  await explainManifestEmails(deps({
    sources: [source([msg('a', 1)])],
    archive: async () => { archived += 1; return {}; },
    deep: true,
  }));
  assert.equal(archived, 0, 'the dry run must not file paper');
});

// ── the question it exists to answer ─────────────────────────────────────────

test('it names the emails a pass CANNOT reach, and why', async () => {
  // The 2026-09-10 shape: last night's leftovers sort oldest and eat the cap, so tonight's
  // report is never opened. That is invisible from every other surface.
  const many = Array.from({ length: MAX_EMAILS_PER_RUN + 3 }, (_, i) => msg(`m${i}`, i + 1));
  const out = await explainManifestEmails(deps({ sources: [source(many)] }));
  const box = out.mailboxes[0];

  assert.equal(box.cap, MAX_EMAILS_PER_RUN);
  assert.equal(box.wouldProcess, MAX_EMAILS_PER_RUN);
  assert.equal(box.unmarked, many.length);

  // Oldest first, same order the real loop spends the cap in.
  assert.deepEqual(box.emails.map((e) => e.id), many.map((m) => m.id));
  const unreached = box.emails.filter((e) => /UNREAD THIS PASS/.test(e.verdict));
  assert.equal(unreached.length, 3);
  assert.deepEqual(unreached.map((e) => e.id),
    [0, 1, 2].map((i) => `m${MAX_EMAILS_PER_RUN + i}`), 'the three oldest beyond the cap');
  assert.match(unreached[0].verdict, /cap was already spent on older mail/);
});

test('an email already handled says so, and says what happened to it', async () => {
  const out = await explainManifestEmails(deps({
    sources: [source([msg('seen', 1), msg('fresh', 2)])],
    getDoc: async (path) => (path === markerDocFor('gmail', 'seen')
      ? { outcome: 'checked', at: '2026-09-11T01:10:21.309Z', suspects: 0 } : null),
  }));
  const [seen, fresh] = out.mailboxes[0].emails;
  assert.equal(seen.marked, true);
  assert.equal(seen.outcome, 'checked');
  assert.equal(seen.markedAt, '2026-09-11T01:10:21.309Z');
  assert.match(seen.verdict, /already checked — never read again/);
  assert.equal(fresh.marked, false);
  // A handled email costs no cap: it is skipped before the counter moves.
  assert.equal(out.mailboxes[0].wouldProcess, 1);
});

// ── deep: telling a parse failure from a board failure ───────────────────────

test('DEEP tells "the PDF is not the report" apart from "the board is not there yet"', async () => {
  // These two are the whole reason for deep mode. They look identical from outside the job —
  // nothing filed — and they need opposite fixes: one is a bad attachment to ignore forever,
  // the other is a retry that will succeed once a scan has run.
  const notReport = await explainManifestEmails(deps({
    sources: [source([msg('a', 1)])], deep: true,
    runDiff: async () => ({ ok: false, notManifest: true, error: 'no orders found — is this the Uline freight report?' }),
  }));
  assert.match(notReport.mailboxes[0].emails[0].verdict, /would be IGNORED — the PDF is not the freight report/);

  const noBoard = await explainManifestEmails(deps({
    sources: [source([msg('a', 1)])], deep: true,
    runDiff: async () => ({
      ok: false, base: '2026-09-11', dates: ['2026-09-11', '2026-09-12'],
      boardDays: [{ date: '2026-09-11', stops: 0 }],
      error: 'no board rows cached for those dates — a scan must run first, or pass ?date=',
    }),
  }));
  const row = noBoard.mailboxes[0].emails[0];
  assert.match(row.verdict, /would RETRY — no board rows cached/);
  // The dates and the board it looked at ride along, because "which board" is the next
  // question anybody asks and a verdict without it sends them back for another round.
  assert.deepEqual(row.tried[0].boardDays, [{ date: '2026-09-11', stops: 0 }]);
  assert.equal(row.tried[0].expectedDelivery, null, 'a diff that failed names no delivery day');
});

test('DEEP reports a healthy read with the order count that would have been filed', async () => {
  const out = await explainManifestEmails(deps({
    sources: [source([msg('a', 1)])], deep: true,
    runDiff: async () => ({ ok: true, manifest: { orders: 691 }, shipDate: '2026-09-10', expectedDelivery: '2026-09-11' }),
  }));
  const row = out.mailboxes[0].emails[0];
  assert.match(row.verdict, /would be CHECKED and filed \(691 orders\)/);
  assert.equal(row.tried[0].shipDate, '2026-09-10');
  assert.equal(row.tried[0].expectedDelivery, '2026-09-11');
});

test('shallow mode never downloads — it is one list call and the markers', async () => {
  let downloads = 0;
  await explainManifestEmails(deps({
    sources: [source([msg('a', 1)], { download: async () => { downloads += 1; return Buffer.from('%PDF'); } })],
  }));
  assert.equal(downloads, 0, 'the cheap mode must stay cheap');
});

// ── the ordinary failures it must survive ────────────────────────────────────

test('a mailbox that cannot be listed is reported, not thrown', async () => {
  const out = await explainManifestEmails(deps({
    sources: [
      { name: 'gmail', list: async () => { throw new Error('gmail auth failed: invalid_grant'); } },
      source([msg('a', 1)]),
    ],
  }));
  assert.match(out.mailboxes[0].error, /invalid_grant/);
  // …and the second mailbox is still read. One dead token must not blind the diagnostic.
  assert.equal(out.mailboxes[1].emails.length, 1);
});

test('an email with no PDF is named as such rather than silently dropped', async () => {
  const out = await explainManifestEmails(deps({
    sources: [source([msg('a', 1, [{ id: 'x', filename: 'note.txt', contentType: 'text/plain' }])])],
  }));
  assert.match(out.mailboxes[0].emails[0].verdict, /would be IGNORED — no PDF attachment/);
});

test('no mailbox configured is an answer, not an error', async () => {
  const out = await explainManifestEmails(deps({ sources: [] }));
  assert.equal(out.ok, true);
  assert.match(out.skipped, /no mail sources configured/);
});

test('every row carries the ET arrival time — the clock every question is asked in', async () => {
  // 2026-09-11T00:00:41Z is 8:00pm ET on the 10th. A UTC stamp here is one mental subtraction
  // away from "did the 8:10p pass see it?" being answered wrongly.
  const out = await explainManifestEmails(deps({ sources: [source([msg('a', 1789084841000)])] }));
  const row = out.mailboxes[0].emails[0];
  assert.match(row.receivedAtEt, /9\/10\/26/);
  assert.match(row.receivedAtEt, /8:00 PM|8:00 PM/);
});
