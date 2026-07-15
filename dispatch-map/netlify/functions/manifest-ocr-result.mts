// manifest-ocr-result.mts
//
// Poll endpoint for manifest-ocr-background: GET ?job=<jobId> returns the job doc's
// current state. 'pending' covers both "job doc not written yet" (the 202 raced the
// first poll) and status 'reading'. On 'done'/'error' the doc is deleted best-effort —
// the payload is handed to the client exactly once and the docs never accumulate.
// Zero NuVizz, zero AI — one Firestore read (+ delete).

import { isFirestoreEnabled, getDoc, deleteDoc } from './lib/firestore.mts';
import { jobDocPath, isValidJobId } from './manifest-ocr-background.mts';

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const J = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers });

  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);
  const jobId = String(new URL(req.url).searchParams.get('job') || '').toLowerCase();
  if (!isValidJobId(jobId)) return J({ ok: false, error: 'bad job id' }, 400);

  const doc: any = await getDoc(jobDocPath(jobId)).catch(() => null);
  if (!doc || doc.status === 'reading') return J({ ok: true, status: 'pending' });
  if (doc.status === 'done' || doc.status === 'error') {
    deleteDoc(jobDocPath(jobId)).catch(() => { /* best-effort cleanup */ });
    return doc.status === 'done'
      ? J({ ok: true, status: 'done', manifest: doc.manifest || null, rows: doc.rows || [], warnings: doc.warnings || [] })
      : J({ ok: true, status: 'error', error: doc.error || 'manifest read failed' });
  }
  return J({ ok: true, status: 'pending' });
};
