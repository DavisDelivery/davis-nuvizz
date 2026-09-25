// test/claude-shadow-store-retry.test.mjs — A THROTTLED SHADOW WRITE IS RETRIED, NOT FATAL.
//
// 2026-09-25 15:26 UTC a paid backtest round finished and the write recording it came back 429
// ("This database has exceeded their maximum request_rate/bandwidth/document_rate for writes,
// please retry with exponential backoff"); the job died with $1.52 spent. The gateway now does what
// Firestore asked. These run the REAL store.mts → firestore.mts path against the in-memory fake,
// with the fake answering 429 first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { shadowPatch, shadowSet, ShadowPathError } from '../netlify/functions/lib/claude-shadow/store.mts';

function throttleFirst(n, status = 429) {
  const inner = globalThis.fetch;
  let left = n, seen = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    const method = String(init.method || 'GET').toUpperCase();
    if (url.includes('firestore.googleapis.com') && method === 'PATCH') {
      seen++;
      if (left-- > 0) return new Response(JSON.stringify({ error: { code: status, message: 'This database has exceeded their maximum request_rate/bandwidth/document_rate for writes, please retry with exponential backoff.' } }), { status });
    }
    return inner(input, init);
  };
  return { patches: () => seen, restore: () => { globalThis.fetch = inner; } };
}

test('a write Firestore throttles once (429) is retried and lands', async () => {
  const fake = installFirestoreFake({}, () => { throw new Error('no vendor call expected'); });
  const t = throttleFirst(1);
  try {
    assert.equal(await shadowPatch('claude_shadow_jobs/bt__x', { rounds: 2 }), true);
    assert.equal(t.patches(), 2, 'one refused, one accepted');
    assert.deepEqual(fake.store.get('claude_shadow_jobs/bt__x'), { rounds: 2 });
  } finally { t.restore(); fake.restore(); }
});

test('a request that is wrong (400) is NOT retried — it is not the network’s fault', async () => {
  const fake = installFirestoreFake({}, () => { throw new Error('no vendor call expected'); });
  const t = throttleFirst(5, 400);
  try {
    await assert.rejects(() => shadowSet('claude_shadow_jobs/bt__y', { a: 1 }), /failed: 400/);
    assert.equal(t.patches(), 1);
  } finally { t.restore(); fake.restore(); }
});

test('a path outside claude_shadow_* is refused before any request, retry or not', async () => {
  const fake = installFirestoreFake({}, () => { throw new Error('no vendor call expected'); });
  const t = throttleFirst(5);
  try {
    await assert.rejects(() => shadowPatch('att_plan/davis__2026-09-23', { a: 1 }), ShadowPathError);
    assert.equal(t.patches(), 0);
  } finally { t.restore(); fake.restore(); }
});
