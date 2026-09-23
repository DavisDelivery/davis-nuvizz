// shiplify-import-background.mts — TURN A RECEIVED SHIPLIFY FILE INTO LOCATIONS, AND PROVE IT.
//
//   POST { batch_id }             process the batch the browser just finished sending
//   POST { batch_id, dry: true }  the same reads and derivation, WRITES NOTHING but log.dry_run
//
// Netlify answers 202 the moment this lands and discards whatever we return, so the outcome
// lives on the import log (shiplify_imports/{batch_id}), which the import screen polls through
// GET shiplify-import?batch_id=X. Every path ends there at 'complete', 'mismatch' or 'failed'.
// What it does, step by step, is lib/shiplify-store.mts#processImport.
//
// ZERO NuVizz calls. Firestore only.
//
// GATED AT dispatcher, WITH THE OBSERVABLE REFUSAL (lib/background-gate.mts). Mirrors
// routing-build-background: a dispatcher tool whose client polls a document this job ends, so a
// refusal is written onto that document instead of vanishing behind the 202. Dispatcher is the
// role the upload half (shiplify-import POST, mirroring manifest-upload) already requires: the
// person who can send the file is the person who can process it. INERT until
// AUTH_REQUIRED=true — with login off a token-less caller is the legacy principal and runs.

import { isFirestoreEnabled, getDocMasked, incrementDocFields } from './lib/firestore.mts';
import { requireUserForBackground } from './lib/background-gate.mts';
import { clientIp, throttled, readJsonBody } from './lib/require-user.mts';
import { isBatchId, logPath, processImport } from './lib/shiplify-store.mts';

/**
 * Land a refusal on the import log the screen is polling — but ONLY on a log that exists and
 * is waiting for this job ('receiving'). Never a create (the batch id is caller-chosen, so a
 * create here would be a document factory for anonymous POSTs), and never over a finished
 * import's verdict (an anonymous POST must not be able to turn a 'complete' import 'failed').
 * incrementDocFields carries currentDocument.exists:true, so "only if it exists" is enforced by
 * Firestore, not by the read above it.
 *
 * A refused DRY run lands where dry runs report (log.dry_run) and never touches the status: a
 * dry run is not a run, so refusing one must not fail the upload it was looking at.
 */
async function recordRefusal(req: Request, batchId: string, dry: boolean, refusal: { reason: string; message: string; at: string }): Promise<void> {
  if (throttled(`shiplify-refusal:${clientIp(req)}`, 5, 60_000)) return;
  const log = await getDocMasked(logPath(batchId), ['status']).catch(() => null);
  if (!log) return;
  if (dry) {
    await incrementDocFields(logPath(batchId), {}, {
      dry_run: { at: refusal.at, ok: false, error: refusal.message, refused: { reason: refusal.reason, at: refusal.at } },
    });
    return;
  }
  if (log.status !== 'receiving') return;
  await incrementDocFields(logPath(batchId), {}, {
    status: 'failed', error: refusal.message, failed_at: refusal.at, refused: { reason: refusal.reason, at: refusal.at },
  });
}

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const J = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers });
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers });
  if (req.method !== 'POST') return J({ ok: false, error: 'POST only' }, 405);
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const batchId = String(parsed.body?.batch_id || '');
  if (!isBatchId(batchId)) return J({ ok: false, error: 'batch_id must look like shp_ followed by 16 hex digits' }, 400);
  const dry = parsed.body?.dry === true;

  // After the id is validated (a refusal never writes to a malformed path), before any read of
  // the batch (a refused caller never pays for the raw layer).
  const gate = await requireUserForBackground(req, 'shiplify-import-background', {
    role: 'dispatcher',
    record: (refusal) => recordRefusal(req, batchId, dry, refusal),
  });
  if (!gate.ok) return gate.response;

  const out = await processImport(batchId, { dry });
  console.log(`[shiplify-import-background] ${batchId}${dry ? ' (dry run)' : ''}: ${out.status} ${JSON.stringify(out.body).slice(0, 400)}`);
  return J(out.body, out.status);
};
