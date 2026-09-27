// THE MANIFEST DRY RUN SPENDS THE PER-RUN CAP THE WAY THE REAL PASS DOES.
//
// The real loop (ingestOneSource) counts an email against MAX_EMAILS_PER_RUN only when it
// MARKS it — checked, or ignored. An email it has to retry (the board for that delivery date
// is not scanned yet, or the attachments could not be listed) is left unmarked and uses no
// slot. explainManifestEmails counted every unmarked email it reached, before it knew the
// outcome — so with older reports waiting on a board, it told Chad tonight's report would go
// UNREAD while the real 9:10p pass read and filed it. That is the wrong answer to the exact
// question the diagnostic was built for.
//
// Both halves run here on the SAME mailbox: the dry run and the real pass, compared email by
// email. No network — the sources are in-memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  explainManifestEmails, ingestManifestEmails, MAX_EMAILS_PER_RUN,
} from '../netlify/functions/lib/manifest-email-ingest.mts';

const pdf = (name = 'report.pdf') => ({ id: `a-${name}`, filename: name, contentType: 'application/pdf' });
const msg = (id, receivedAt, atts = [pdf()]) => ({
  id, receivedAt, from: 'outbound.logistics@uline.com',
  subject: `G Uline Freight Report for DAVIS DELIVERY ${id}`, attachments: atts,
});
/** Newest first, the way a mailbox lists. The buffer carries the email id so the diff can tell them apart. */
const source = (messages, over = {}) => ({
  name: 'gmail',
  list: async () => [...messages].reverse(),
  download: async (email) => Buffer.from(`%PDF ${email.id}`),
  ...over,
});
const NO_BOARD = 'no board rows cached for those dates — a scan must run first, or pass ?date=';
const diffFor = (retryIds) => async (buf) => (retryIds.has(String(buf).slice(5))
  ? { ok: false, error: NO_BOARD }
  : { ok: true, manifest: { orders: 691, rows: [] }, shipDate: '2026-09-10', expectedDelivery: '2026-09-11', suspects: [] });

const store = () => {
  const m = new Map();
  return { m, getDoc: async (p) => m.get(p) ?? null, setDoc: async (p, d) => { m.set(p, d); return true; } };
};

// Every older report is waiting on a board that has not been scanned; tonight's is readable.
const older = Array.from({ length: MAX_EMAILS_PER_RUN }, (_, i) => msg(`old${i}`, i + 1));
const tonight = msg('tonight', 1000);
const retryIds = new Set(older.map((m) => m.id));

test("tonight's report is not called unread when every older report ahead of it is waiting on a board", async () => {
  const dry = await explainManifestEmails({
    sources: [source([...older, tonight])], deep: true,
    getDoc: async () => null, setDoc: async () => { throw new Error('explain must never write'); },
    runDiff: diffFor(retryIds),
  });
  const rows = dry.mailboxes[0].emails;
  for (const r of rows.slice(0, -1)) assert.match(r.verdict, /would RETRY — no board rows cached/, r.id);
  const t = rows.find((r) => r.id === 'tonight');
  assert.match(t.verdict, /would be CHECKED and filed/, t.verdict);
  assert.equal(dry.mailboxes[0].wouldProcess, 1, 'a retry uses no slot of the cap');

  // THE REAL PASS, same mailbox: it reads and files tonight's report.
  const s = store();
  const real = await ingestManifestEmails({ sources: [source([...older, tonight])], getDoc: s.getDoc, setDoc: s.setDoc, runDiff: diffFor(retryIds) });
  const outcome = Object.fromEntries(real.outcomes.map((o) => [o.id, o.outcome]));
  assert.equal(outcome.tonight, 'checked');
  for (const m of older) assert.equal(outcome[m.id], 'retry');
});

test('without deep, a report past the cap is labelled as depending on the older reads, not as certain', async () => {
  const dry = await explainManifestEmails({
    sources: [source([...older, tonight])],
    getDoc: async () => null, setDoc: async () => { throw new Error('explain must never write'); },
    runDiff: diffFor(retryIds),
  });
  const t = dry.mailboxes[0].emails.find((r) => r.id === 'tonight');
  assert.match(t.verdict, /UNREAD THIS PASS/);
  assert.match(t.verdict, /if all \d+ older/, 'shallow mode cannot see a retry, and says so');
  assert.match(t.verdict, /deep=1/);
});

test('older mail whose attachments cannot be listed uses no slot, in the dry run as in the real pass', async () => {
  const listFails = new Set(older.map((m) => m.id));
  const attachments = async (email) => {
    if (listFails.has(email.id)) throw new Error('attachments list failed: 503');
    return email.attachments;
  };
  const dry = await explainManifestEmails({
    sources: [source([...older, tonight], { attachments })],
    getDoc: async () => null, setDoc: async () => { throw new Error('explain must never write'); },
    runDiff: diffFor(new Set()),
  });
  const t = dry.mailboxes[0].emails.find((r) => r.id === 'tonight');
  assert.doesNotMatch(t.verdict, /UNREAD THIS PASS/, t.verdict);

  const s = store();
  const real = await ingestManifestEmails({ sources: [source([...older, tonight], { attachments })], getDoc: s.getDoc, setDoc: s.setDoc, runDiff: diffFor(new Set()) });
  assert.equal(real.outcomes.find((o) => o.id === 'tonight')?.outcome, 'checked');
});

test('an email with one unreadable PDF and one non-report PDF is a RETRY, as the real pass files it', async () => {
  const two = msg('mixed', 1, [pdf('cover.pdf'), pdf('report.pdf')]);
  const src = () => source([two], { download: async (email, att) => Buffer.from(`%PDF ${att.filename}`) });
  const runDiff = async (buf) => (String(buf).includes('cover')
    ? { ok: false, notManifest: true, error: 'no orders found' }
    : { ok: false, error: NO_BOARD });
  const dry = await explainManifestEmails({ sources: [src()], deep: true, getDoc: async () => null, setDoc: async () => { throw new Error('no'); }, runDiff });
  assert.match(dry.mailboxes[0].emails[0].verdict, /would RETRY/);
  assert.equal(dry.mailboxes[0].wouldProcess, 0);

  const s = store();
  const real = await ingestManifestEmails({ sources: [src()], getDoc: s.getDoc, setDoc: s.setDoc, runDiff });
  assert.equal(real.outcomes[0].outcome, 'retry');
});
