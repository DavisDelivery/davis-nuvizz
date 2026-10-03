// print-layout.mts — READ OR CHANGE WHICH LAYOUT THE DRIVER MANIFEST AND DELIVERY TICKET PRINT IN.
//
// Chad, 2026-10-03, approving the redesigned manifest: "i want to move to production but i want
// a way to roll back to old one if needed in diagnostics screen somewhere i want to be able to
// pick which version i'm running."
//
// The two layouts, and why the choice is one document for every device rather than a setting in
// each browser: src/lib/print-layout.js. This is only the switch behind Diagnostics → Manifest layout.
//
//   GET                              → { ok, layout, stored, persistent, set_at, set_by }   (viewer)
//   POST { layout: 'new'|'classic' } → the same body, READ BACK after the write            (admin)
//
// `layout` is what prints: 'new' unless the document says 'classic' (or 'old'). `stored` is the
// document's own value, as it is, so a hand-edited typo shows on the screen instead of hiding
// behind the default it falls back to.
//
// NEVER REPORT AN INTENT AS AN OUTCOME. The POST answers with a fresh read of the document, not
// with what it was asked to write; if the two disagree it says so and answers 500. A failed read
// is an error too — never a quiet "new" — so a device that cannot tell keeps the last answer it
// had rather than taking a guess for one.
//
// THE WRITE IS FIELD-MASKED (updateDocFields): it names its three fields and replaces nothing else.
//
// ZERO NuVizz calls. Both gates are inert until AUTH_REQUIRED=true on the site, like every gate here.
import { requireUser, readJsonBody } from './lib/require-user.mts';
import { isFirestoreEnabled, getDoc, updateDocFields } from './lib/firestore.mts';
import { DEFAULT_PRINT_LAYOUT, isPrintLayout, normalizePrintLayout } from '../../src/lib/print-layout.js';

export const PRINT_LAYOUT_PATH = 'nuvizz_ops/print_layout';

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const J = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

/** The document as the screen needs it. `stored` is kept as found — only a string is passed on. */
function answerFrom(doc: Record<string, any> | null) {
  const stored = typeof doc?.layout === 'string' ? doc.layout : null;
  return {
    ok: true,
    layout: normalizePrintLayout(stored),
    stored,
    persistent: true,
    set_at: typeof doc?.set_at === 'string' ? doc.set_at : null,
    set_by: typeof doc?.set_by === 'string' ? doc.set_by : null,
  };
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'GET' && req.method !== 'POST') return J({ ok: false, error: 'GET or POST only' }, 405);

  const gate = await requireUser(req, { role: req.method === 'POST' ? 'admin' : 'viewer' });
  if (!gate.ok) return gate.response;

  // No Firestore (a preview build without FIREBASE_SA): there is nowhere to keep a choice, so the
  // default prints and the screen is told the choice cannot be stored here.
  if (!isFirestoreEnabled()) {
    const body = {
      ok: true, layout: DEFAULT_PRINT_LAYOUT, stored: null, persistent: false, set_at: null, set_by: null,
      note: 'This site has no database, so the choice cannot be stored here. It prints the new layout.',
    };
    if (req.method === 'GET') return J(body);
    return J({ ...body, ok: false, error: 'Firestore is not configured on this site — the layout cannot be changed here.' }, 409);
  }

  try {
    if (req.method === 'GET') return J(answerFrom(await getDoc(PRINT_LAYOUT_PATH)));

    const parsed = await readJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const want = parsed.body?.layout;
    if (!isPrintLayout(want)) return J({ ok: false, error: 'send { "layout": "new" } or { "layout": "classic" }' }, 400);

    const setAt = new Date().toISOString();
    const setBy = gate.user.legacy ? null : (gate.user.displayName || gate.user.username || null);
    await updateDocFields(PRINT_LAYOUT_PATH, { layout: want, set_at: setAt, set_by: setBy });

    const back = answerFrom(await getDoc(PRINT_LAYOUT_PATH));
    if (back.stored !== want) {
      return J({ ...back, ok: false, error: `wrote layout=${want} but reading it back says ${back.stored ?? 'nothing'}` }, 500);
    }
    console.log(`[print-layout] layout=${back.layout} set by ${setBy ?? '(no login)'} at ${setAt}`);
    return J(back);
  } catch (e: any) {
    return J({ ok: false, error: e?.message || 'failed' }, 500);
  }
};
