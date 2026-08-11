// test/manifest-email-ingest.test.mjs — the automatic manifest check.
//
// Chad: "This should happen automatically from email parse." The orchestration is
// dependency-injected, so these tests run the REAL ingest logic against a scripted
// Resend inbox and an in-memory Firestore — no network, no PDFs, no NuVizz.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ingestManifestEmails, toStoredEmailRun, markerDoc, LATEST_DOC, MAX_EMAILS_PER_RUN,
} from '../netlify/functions/lib/manifest-email-ingest.mts';

// A scripted world: emails in the inbox, bytes behind download URLs, and a diff
// verdict per byte-string. Firestore is a Map.
function world({ emails = [], files = {}, diffs = {} } = {}) {
  const store = new Map();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/emails/receiving?')) {
      return { ok: true, json: async () => ({ data: emails }) };
    }
    const m = String(url).match(/\/emails\/receiving\/([^/]+)\/attachments$/);
    if (m) {
      const em = emails.find((e) => e.id === decodeURIComponent(m[1]));
      return { ok: true, json: async () => ({ data: em?.attachments || [] }) };
    }
    if (files[url] !== undefined) {
      return { ok: true, arrayBuffer: async () => Buffer.from(files[url]) };
    }
    return { ok: false, status: 404 };
  };
  const deps = {
    apiKey: 'k',
    fetchImpl,
    getDoc: async (p) => store.get(p) ?? null,
    setDoc: async (p, d) => { store.set(p, d); return true; },
    runDiff: async (buf) => diffs[buf.toString()] ?? { ok: false, notManifest: true },
    now: () => '2026-08-11T02:00:00.000Z',
  };
  return { deps, store, calls };
}

const GOOD_DIFF = {
  ok: true,
  checkedAgainst: [{ date: '2026-08-11', stops: 700 }],
  manifest: { orders: 3, verified: true },
  onBoard: 2, boardOnly: 698, duplicatePros: [],
  suspects: [{ pro: '7152411' }],
};

const reportEmail = (id, att = {}) => ({
  id, from: 'freight@uline.com', subject: 'Uline Freight Report',
  attachments: [{ id: 'a1', filename: 'freight.pdf', content_type: 'application/pdf', download_url: `https://dl/${id}`, ...att }],
});

test('the freight report is found, checked, and stored where every browser reads it', async () => {
  const { deps, store } = world({
    emails: [reportEmail('e1')],
    files: { 'https://dl/e1': 'REPORT' },
    diffs: { REPORT: GOOD_DIFF },
  });
  const out = await ingestManifestEmails(deps);
  assert.equal(out.processed, 1);
  const latest = store.get(LATEST_DOC);
  assert.ok(latest, 'latest doc written');
  assert.equal(latest.source, 'email');
  assert.equal(latest.suspectsTotal, 1);
  assert.equal(latest.fileName, 'freight.pdf');
  assert.equal(store.get(markerDoc('e1'))?.outcome, 'checked');
});

test('an already-processed email is skipped without touching its attachments', async () => {
  const { deps, store, calls } = world({
    emails: [reportEmail('e1')],
    files: { 'https://dl/e1': 'REPORT' },
    diffs: { REPORT: GOOD_DIFF },
  });
  store.set(markerDoc('e1'), { outcome: 'checked' });
  const out = await ingestManifestEmails(deps);
  assert.equal(out.processed, 0);
  assert.ok(!calls.some((u) => u.startsWith('https://dl/')), 'no attachment download for a marked email');
  assert.ok(!store.get(LATEST_DOC), 'latest untouched');
});

test('a PDF that is not the freight report is marked ignored — never refetched, never stored', async () => {
  const { deps, store } = world({
    emails: [reportEmail('e2')],
    files: { 'https://dl/e2': 'INVOICE' },
    diffs: { INVOICE: { ok: false, notManifest: true } },
  });
  const out = await ingestManifestEmails(deps);
  assert.equal(store.get(markerDoc('e2'))?.outcome, 'ignored');
  assert.ok(!store.get(LATEST_DOC));
  assert.equal(out.outcomes[0].reason, 'pdf is not the freight report');
});

test('an email with no PDF at all is marked ignored', async () => {
  const { deps, store } = world({
    emails: [{ id: 'e3', from: 'x', subject: 'hi', attachments: [{ filename: 'pic.png', content_type: 'image/png' }] }],
  });
  await ingestManifestEmails(deps);
  assert.equal(store.get(markerDoc('e3'))?.outcome, 'ignored');
});

test('a transient failure leaves the email UNMARKED so the next cycle retries', async () => {
  // Board not scanned yet: diff fails but not with notManifest → retry, no marker.
  const { deps, store } = world({
    emails: [reportEmail('e4')],
    files: { 'https://dl/e4': 'REPORT' },
    diffs: { REPORT: { ok: false, error: 'no board rows cached for those dates' } },
  });
  const out = await ingestManifestEmails(deps);
  assert.ok(!store.get(markerDoc('e4')), 'no marker — retry next cycle');
  assert.equal(out.outcomes[0].outcome, 'retry');
  assert.ok(!store.get(LATEST_DOC));
});

test('a dead download_url also retries rather than marking', async () => {
  const { deps, store } = world({ emails: [reportEmail('e5')] }); // no file behind the URL → 404
  const out = await ingestManifestEmails(deps);
  assert.ok(!store.get(markerDoc('e5')));
  assert.equal(out.outcomes[0].outcome, 'retry');
});

test('no API key = quiet no-op (receiving not set up is not an error)', async () => {
  const { deps } = world();
  const out = await ingestManifestEmails({ ...deps, apiKey: null });
  assert.equal(out.ok, true);
  assert.equal(out.skipped, 'no RESEND_API_KEY');
});

test(`at most ${MAX_EMAILS_PER_RUN} new emails are processed per cycle`, async () => {
  const emails = ['e1', 'e2', 'e3', 'e4', 'e5'].map((id) => reportEmail(id));
  const files = Object.fromEntries(emails.map((e) => [`https://dl/${e.id}`, 'REPORT']));
  const { deps } = world({ emails, files, diffs: { REPORT: GOOD_DIFF } });
  const out = await ingestManifestEmails(deps);
  assert.equal(out.processed, MAX_EMAILS_PER_RUN);
});

test('the stored shape matches what the drop screen stores (flag-compatible)', () => {
  const run = toStoredEmailRun(GOOD_DIFF, { id: 'e', from: 'f', subject: 's' }, 'freight.pdf', '2026-08-11T02:00:00.000Z');
  for (const k of ['at', 'fileName', 'checkedAgainst', 'manifest', 'onBoard', 'boardOnly', 'duplicatePros', 'suspects', 'suspectsTotal']) {
    assert.ok(k in run, `stored run missing ${k}`);
  }
  assert.equal(run.source, 'email');
});
