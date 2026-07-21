// test/manifest-upload.test.mjs
//
// Unit tests for the chunked manifest-PDF upload (manifest-upload.mts +
// manifest-ocr-background.mts chunk contract). The chunk path exists because Netlify
// background functions cap the request body ~256 KB — a high-resolution fax scan
// (5 pages, 3.9 MB) must ride to the reader through Firestore parts instead.
// Run with: npm test.

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateChunkReq } from '../netlify/functions/manifest-upload.mts';
import { pdfChunkDocPath, jobDocPath, isValidJobId, MAX_PDF_CHUNKS, MAX_CHUNK_B64_CHARS } from '../netlify/functions/manifest-ocr-background.mts';

const JOB = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const ok = (over = {}) => ({ jobId: JOB, seq: 0, total: 3, data: 'JVBERiAxLjQ=', ...over });

test('validateChunkReq: a well-formed part passes', () => {
  assert.equal(validateChunkReq(ok()), null);
  assert.equal(validateChunkReq(ok({ seq: 2, total: 3 })), null);   // last part
  assert.equal(validateChunkReq(ok({ total: MAX_PDF_CHUNKS, seq: MAX_PDF_CHUNKS - 1 })), null);
});

test('validateChunkReq: rejects bad job ids', () => {
  assert.match(validateChunkReq(ok({ jobId: 'short' })) || '', /jobId/);
  assert.match(validateChunkReq(ok({ jobId: 'HAS UPPER SPACES!' })) || '', /jobId/);
  assert.match(validateChunkReq({}) || '', /jobId|body/);
  assert.match(validateChunkReq(null) || '', /body/);
});

test('validateChunkReq: rejects out-of-range seq/total', () => {
  assert.match(validateChunkReq(ok({ seq: 3, total: 3 })) || '', /seq/);        // seq == total
  assert.match(validateChunkReq(ok({ seq: -1 })) || '', /seq/);
  assert.match(validateChunkReq(ok({ seq: 0.5 })) || '', /seq/);
  assert.match(validateChunkReq(ok({ total: 0 })) || '', /total/);
  assert.match(validateChunkReq(ok({ total: MAX_PDF_CHUNKS + 1, seq: 0 })) || '', /total/);
});

test('validateChunkReq: rejects missing/oversized/non-base64 data', () => {
  assert.match(validateChunkReq(ok({ data: '' })) || '', /data/);
  assert.match(validateChunkReq(ok({ data: 42 })) || '', /data/);
  assert.match(validateChunkReq(ok({ data: 'x'.repeat(MAX_CHUNK_B64_CHARS + 1) })) || '', /large/);
  assert.match(validateChunkReq(ok({ data: 'not base64 !!' })) || '', /base64/);
  // exactly at the cap is fine
  assert.equal(validateChunkReq(ok({ data: 'A'.repeat(MAX_CHUNK_B64_CHARS) })), null);
});

test('chunk contract: doc paths are distinct per part and never collide with the job doc', () => {
  assert.equal(pdfChunkDocPath(JOB, 0), `nuvizz_ops/manifest_pdf__${JOB}__0`);
  assert.notEqual(pdfChunkDocPath(JOB, 0), pdfChunkDocPath(JOB, 1));
  assert.notEqual(pdfChunkDocPath(JOB, 0), jobDocPath(JOB));
});

test('chunk contract: caps allow a multi-MB fax scan (the 3.9 MB / 5-page manifest fits)', () => {
  // 3.9 MB PDF → ~5.3M base64 chars → 8 parts of 700k. Must be far inside the caps.
  const partsNeeded = Math.ceil(5_300_000 / 700_000);
  assert.ok(partsNeeded <= MAX_PDF_CHUNKS, `needs ${partsNeeded} parts, cap is ${MAX_PDF_CHUNKS}`);
  assert.ok(700_000 <= MAX_CHUNK_B64_CHARS);
  assert.ok(isValidJobId(JOB));
});
