// lib/secure-compare.mts
//
// One constant-time secret comparison for every shared-secret gate in this app (the
// SimpleTexting webhook token, the comms admin token, the debug-capture secret). `got ===
// want` on a secret short-circuits at the first differing byte, so a caller timing responses
// can recover the secret one byte at a time. Hashing both sides first makes the two buffers
// the same length (timingSafeEqual THROWS on a length mismatch, which would itself leak the
// secret's length), and the comparison is then a fixed-cost walk over 32 bytes.
//
// PURE — no env reads. Whether an UNSET secret opens or closes the gate is each caller's
// decision (and a deploy decision of Chad's); this only answers "is this the secret".
import crypto from 'node:crypto';

export function tokenMatches(got: unknown, want: unknown): boolean {
  const g = typeof got === 'string' ? got : '';
  const w = typeof want === 'string' ? want : '';
  if (!g || !w) return false;
  const gh = crypto.createHash('sha256').update(g).digest();
  const wh = crypto.createHash('sha256').update(w).digest();
  return crypto.timingSafeEqual(gh, wh);
}
