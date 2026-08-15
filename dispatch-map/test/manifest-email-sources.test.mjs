// test/manifest-email-sources.test.mjs — the report can land in EITHER mailbox.
//
// The single-mailbox behaviour is pinned in manifest-email-ingest.test.mjs (which
// still drives the ingest through the Resend entry point, unchanged). This file
// covers what the second mailbox introduced: Gmail flowing end-to-end, the two
// inboxes staying independent when one is broken, and markers that cannot collide
// across mailboxes. Fake MailSources — no network, no Firestore, no PDFs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ingestManifestEmails, markerDoc, markerDocFor, LATEST_DOC, MAX_EMAILS_PER_RUN,
} from '../netlify/functions/lib/manifest-email-ingest.mts';

const GOOD_DIFF = {
  ok: true,
  checkedAgainst: [{ date: '2026-08-13', stops: 865 }],
  manifest: { orders: 2, verified: true },
  onBoard: 1, boardOnly: 864, duplicatePros: [],
  suspects: [{ pro: '007162319', name: 'ANDURIL INDUSTRIES ATL 01' }],
};

/** A mailbox whose messages carry their own bytes. `fail` makes list() throw. */
function fakeSource(name, msgs = [], { fail = null, bytes = {} } = {}) {
  const downloads = [];
  return {
    src: {
      name,
      async list() { if (fail) throw new Error(fail); return msgs; },
      async download(msg, att) { downloads.push(`${msg.id}/${att.id}`); return Buffer.from(bytes[att.id] ?? 'REPORT'); },
    },
    downloads,
  };
}

const pdfMsg = (id, attId = `a-${id}`) => ({
  id, from: 'freight@uline.com', subject: 'Uline Freight Report',
  attachments: [{ id: attId, filename: 'freight.pdf', contentType: 'application/pdf' }],
});

function deps(sources, { diffs = { REPORT: GOOD_DIFF }, store = new Map() } = {}) {
  return {
    store,
    deps: {
      sources,
      fetchImpl: async () => { throw new Error('no source should touch fetch in this test'); },
      getDoc: async (p) => store.get(p) ?? null,
      setDoc: async (p, d) => { store.set(p, d); return true; },
      runDiff: async (buf) => diffs[buf.toString()] ?? { ok: false, notManifest: true },
      now: () => '2026-08-15T02:00:00.000Z',
    },
  };
}

test('a report arriving in Gmail is checked and stored exactly like one from Resend', async () => {
  const { src } = fakeSource('gmail', [pdfMsg('g1')]);
  const { deps: d, store } = deps([src]);
  const out = await ingestManifestEmails(d);

  assert.equal(out.processed, 1);
  const latest = store.get(LATEST_DOC);
  assert.ok(latest, 'latest doc written');
  assert.equal(latest.source, 'email', 'the flag switches on source — must stay "email" for both mailboxes');
  assert.equal(latest.mailbox, 'gmail', 'but the diagnostics line can tell them apart');
  assert.equal(latest.suspectsTotal, 1);
  assert.equal(latest.fileName, 'freight.pdf');
});

test('markers are namespaced per mailbox, so the same message id in both is not a collision', async () => {
  assert.equal(markerDocFor('resend', 'x1'), markerDoc('x1'), 'resend keeps its original path — no backlog re-processing on deploy');
  assert.notEqual(markerDocFor('gmail', 'x1'), markerDocFor('resend', 'x1'));

  // Both mailboxes hand us a message called "x1". Both must be processed.
  const a = fakeSource('resend', [pdfMsg('x1', 'a-r')]);
  const b = fakeSource('gmail', [pdfMsg('x1', 'a-g')]);
  const { deps: d, store } = deps([a.src, b.src]);
  const out = await ingestManifestEmails(d);

  assert.equal(out.processed, 2, 'the second mailbox is not mistaken for the first');
  assert.equal(store.get(markerDocFor('resend', 'x1'))?.outcome, 'checked');
  assert.equal(store.get(markerDocFor('gmail', 'x1'))?.outcome, 'checked');
});

test('a broken mailbox never stops the other one from being read', async () => {
  const dead = fakeSource('resend', [], { fail: 'resend list 401' });
  const live = fakeSource('gmail', [pdfMsg('g1')]);
  const { deps: d, store } = deps([dead.src, live.src]);
  const out = await ingestManifestEmails(d);

  assert.equal(out.ok, true, 'one mailbox down is not a failed cycle');
  assert.equal(out.processed, 1);
  assert.match(out.error, /resend: resend list 401/, 'the break is still reported, not swallowed');
  assert.ok(store.get(LATEST_DOC), 'the working mailbox still stored its check');
});

test('every mailbox failing is a failed cycle', async () => {
  const a = fakeSource('resend', [], { fail: 'resend list 500' });
  const b = fakeSource('gmail', [], { fail: 'gmail auth failed: invalid_grant' });
  const { deps: d } = deps([a.src, b.src]);
  const out = await ingestManifestEmails(d);

  assert.equal(out.ok, false);
  assert.match(out.error, /gmail auth failed: invalid_grant/);
});

test('an already-marked Gmail message is skipped without downloading its attachment', async () => {
  const { src, downloads } = fakeSource('gmail', [pdfMsg('g1')]);
  const { deps: d, store } = deps([src]);
  store.set(markerDocFor('gmail', 'g1'), { outcome: 'checked' });
  const out = await ingestManifestEmails(d);

  assert.equal(out.processed, 0);
  assert.deepEqual(downloads, [], 'no bytes fetched for a message already handled');
  assert.ok(!store.get(LATEST_DOC), 'latest untouched');
});

test('the per-cycle cap is PER MAILBOX, so a noisy inbox cannot starve the one with the report', async () => {
  const noisy = fakeSource('resend', ['n1', 'n2', 'n3', 'n4', 'n5'].map((id) => pdfMsg(id)));
  const quiet = fakeSource('gmail', [pdfMsg('g1')]);
  const { deps: d, store } = deps([noisy.src, quiet.src]);
  const out = await ingestManifestEmails(d);

  assert.equal(out.processed, MAX_EMAILS_PER_RUN + 1, 'the noisy inbox is capped; the quiet one is still read');
  assert.equal(store.get(markerDocFor('gmail', 'g1'))?.outcome, 'checked');
  assert.equal(out.sources.find((s) => s.name === 'resend').processed, MAX_EMAILS_PER_RUN);
});

test('a transient Gmail failure leaves the message unmarked so the next cycle retries', async () => {
  const { src } = fakeSource('gmail', [pdfMsg('g1')]);
  const { deps: d, store } = deps([src], { diffs: { REPORT: { ok: false, error: 'no board rows cached for those dates' } } });
  const out = await ingestManifestEmails(d);

  assert.ok(!store.get(markerDocFor('gmail', 'g1')), 'no marker — retry next cycle');
  assert.equal(out.outcomes[0].outcome, 'retry');
  assert.equal(out.outcomes[0].source, 'gmail');
});

test('an empty attachment retries rather than being mistaken for a non-manifest PDF', async () => {
  const src = {
    name: 'gmail',
    async list() { return [pdfMsg('g1')]; },
    async download() { return null; },
  };
  const { deps: d, store } = deps([src]);
  const out = await ingestManifestEmails(d);

  assert.ok(!store.get(markerDocFor('gmail', 'g1')), 'unmarked');
  assert.equal(out.outcomes[0].reason, 'empty attachment');
});

test('no mailbox configured at all is a quiet no-op', async () => {
  const { deps: d } = deps([]);
  const out = await ingestManifestEmails(d);
  assert.equal(out.ok, true);
  assert.equal(out.skipped, 'no mail sources configured');
});
