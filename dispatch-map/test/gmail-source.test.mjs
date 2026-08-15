// test/gmail-source.test.mjs — reading the nightly freight report out of Gmail.
//
// Chad: "write google mail into the app so we can parse for these manifests and
// look for any missing orders every night." These tests run the REAL adapter
// against a scripted Gmail API — no network, no credentials, no PDFs. The parts
// worth pinning are the ones that fail SILENTLY in production: a nested MIME tree
// whose attachment a one-level read would miss, base64url bytes that decode to a
// broken PDF, and an empty inbox that Gmail reports by OMITTING the key.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gmailConfigFromEnv, gmailSource, getAccessToken, collectAttachments, decodeBase64Url,
  DEFAULT_GMAIL_QUERY,
} from '../netlify/functions/lib/gmail-source.mts';

const CFG = { clientId: 'cid', clientSecret: 'secret', refreshToken: 'rtok', user: 'me', query: 'q', maxResults: 20 };

// A scripted Gmail: messages by id, attachment bytes by attachment id.
function gmailWorld({ messages = {}, listIds = null, attachments = {}, failToken = null, failGet = new Set() } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      if (failToken) return { ok: false, status: 400, json: async () => ({ error: failToken }) };
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3599 }), _body: opts?.body };
    }
    if (failGet.has(u)) return { ok: false, status: 500, json: async () => ({}) };
    const list = u.match(/\/users\/[^/]+\/messages\?/);
    if (list) {
      const ids = listIds ?? Object.keys(messages);
      // Gmail OMITS `messages` entirely when nothing matches — not an empty array.
      return { ok: true, status: 200, json: async () => (ids.length ? { messages: ids.map((id) => ({ id })) } : { resultSizeEstimate: 0 }) };
    }
    const att = u.match(/\/messages\/([^/]+)\/attachments\/([^/?]+)$/);
    if (att) {
      const data = attachments[decodeURIComponent(att[2])];
      if (data === undefined) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data, size: data.length }) };
    }
    const get = u.match(/\/messages\/([^/?]+)\?/);
    if (get) {
      const msg = messages[decodeURIComponent(get[1])];
      if (!msg) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => msg };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

const message = (id, { from = 'freight@uline.com', subject = 'Uline Freight Report', payload } = {}) => ({
  id,
  payload: payload ?? {
    headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }],
    parts: [{ filename: 'freight.pdf', mimeType: 'application/pdf', body: { attachmentId: `att-${id}` } }],
  },
});

test('config is absent until all three credentials are set — an unconfigured deploy is a no-op, not an error', () => {
  assert.equal(gmailConfigFromEnv({}), null);
  assert.equal(gmailConfigFromEnv({ GMAIL_CLIENT_ID: 'a', GMAIL_CLIENT_SECRET: 'b' }), null);
  const cfg = gmailConfigFromEnv({ GMAIL_CLIENT_ID: 'a', GMAIL_CLIENT_SECRET: 'b', GMAIL_REFRESH_TOKEN: 'c' });
  assert.equal(cfg.user, 'me');
  assert.equal(cfg.query, DEFAULT_GMAIL_QUERY);
  assert.equal(cfg.maxResults, 20);
});

test('the default query prefilters but never filters by sender or subject (self-validating match)', () => {
  assert.match(DEFAULT_GMAIL_QUERY, /has:attachment/);
  assert.doesNotMatch(DEFAULT_GMAIL_QUERY, /from:|subject:/);
});

test('a revoked refresh token reports invalid_grant, not a bare 400', async () => {
  const { fetchImpl } = gmailWorld({ failToken: 'invalid_grant' });
  await assert.rejects(() => getAccessToken(CFG, fetchImpl), /gmail auth failed: invalid_grant/);
});

test('the access token is exchanged once and reused for every call in the cycle', async () => {
  const { fetchImpl, calls } = gmailWorld({
    messages: { m1: message('m1'), m2: message('m2') },
    attachments: { 'att-m1': 'AAAA', 'att-m2': 'AAAA' },
  });
  const src = gmailSource(CFG, fetchImpl);
  await src.list();
  const tokenCalls = calls.filter((u) => u.startsWith('https://oauth2.googleapis.com/token'));
  assert.equal(tokenCalls.length, 1, 'one token exchange for the whole cycle');
});

test('an empty inbox is an empty list — Gmail omits the messages key rather than sending []', async () => {
  const { fetchImpl } = gmailWorld({ messages: {}, listIds: [] });
  const msgs = await gmailSource(CFG, fetchImpl).list();
  assert.deepEqual(msgs, []);
});

test('From and Subject are read off the headers regardless of header case', async () => {
  const { fetchImpl } = gmailWorld({
    messages: {
      m1: {
        id: 'm1',
        payload: {
          headers: [{ name: 'from', value: 'freight@uline.com' }, { name: 'SUBJECT', value: 'Nightly report' }],
          parts: [{ filename: 'f.pdf', mimeType: 'application/pdf', body: { attachmentId: 'att-m1' } }],
        },
      },
    },
  });
  const [msg] = await gmailSource(CFG, fetchImpl).list();
  assert.equal(msg.from, 'freight@uline.com');
  assert.equal(msg.subject, 'Nightly report');
});

test('a PDF nested three levels deep is still found — the silent-miss this recursion exists to prevent', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { size: 10 } }] },
      {
        mimeType: 'multipart/related',
        parts: [{ mimeType: 'multipart/mixed', parts: [
          { filename: 'freight.pdf', mimeType: 'application/pdf', body: { attachmentId: 'deep' } },
        ] }],
      },
    ],
  };
  const atts = collectAttachments(payload);
  assert.equal(atts.length, 1);
  assert.equal(atts[0].id, 'deep');
  assert.equal(atts[0].filename, 'freight.pdf');
});

test('inline parts without a filename, and filenames without an attachmentId, are not attachments', () => {
  const atts = collectAttachments({
    parts: [
      { filename: '', mimeType: 'image/png', body: { attachmentId: 'inline-logo' } },
      { filename: 'ghost.pdf', mimeType: 'application/pdf', body: { size: 0 } },
      { filename: 'real.pdf', mimeType: 'application/pdf', body: { attachmentId: 'real' } },
    ],
  });
  assert.deepEqual(atts.map((a) => a.id), ['real']);
});

test('base64url bytes decode to the original PDF bytes (- and _ are not valid base64)', () => {
  const original = Buffer.from([0xfb, 0xff, 0xfe, 0x00, 0x25, 0x50, 0x44, 0x46]);
  const b64url = original.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  assert.ok(/[-_]/.test(b64url), 'fixture actually exercises the URL alphabet');
  assert.deepEqual(decodeBase64Url(b64url), original);
});

test('download returns the decoded attachment bytes', async () => {
  const pdf = Buffer.from('%PDF-1.4 freight');
  const { fetchImpl } = gmailWorld({
    messages: { m1: message('m1') },
    attachments: { 'att-m1': pdf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_') },
  });
  const src = gmailSource(CFG, fetchImpl);
  const [msg] = await src.list();
  const buf = await src.download(msg, msg.attachments[0]);
  assert.equal(buf.toString(), '%PDF-1.4 freight');
});

test('an attachment with no data returns null rather than an empty-but-valid buffer', async () => {
  const { fetchImpl } = gmailWorld({ messages: { m1: message('m1') }, attachments: { 'att-m1': '' } });
  const src = gmailSource(CFG, fetchImpl);
  const [msg] = await src.list();
  assert.equal(await src.download(msg, msg.attachments[0]), null);
});

test('one unreadable message does not blind the cycle to the rest of the inbox', async () => {
  const bad = new Set(['https://gmail.googleapis.com/gmail/v1/users/me/messages/m1?format=full']);
  const { fetchImpl } = gmailWorld({ messages: { m1: message('m1'), m2: message('m2') }, failGet: bad });
  const msgs = await gmailSource(CFG, fetchImpl).list();
  assert.deepEqual(msgs.map((m) => m.id), ['m2'], 'the readable message still comes through');
});

test('a failed list throws so the ingest can report it as a per-source error', async () => {
  const bad = new Set(['https://gmail.googleapis.com/gmail/v1/users/me/messages?q=q&maxResults=20']);
  const { fetchImpl } = gmailWorld({ messages: { m1: message('m1') }, failGet: bad });
  await assert.rejects(() => gmailSource(CFG, fetchImpl).list(), /gmail .* 500/);
});
