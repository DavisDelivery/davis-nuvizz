// lib/claude-shadow/egress.mts — THE RUNTIME NET UNDER THE STATIC GUARD.
//
// scripts/check-shadow-isolation.mjs reads the shadow planner's code and refuses anything that
// could reach NuVizz or write outside claude_shadow_*. Two adversarial reviews showed what reading
// code cannot promise: `global['fe' + 'tch']`, an indirect eval, a Function constructor or a
// helper that appends to a checked path all spell the same request in a way no pattern sees. So
// every shadow function also runs with this lock installed, and the lock judges the REQUEST, not
// the spelling — whatever reached fetch, this is what it reached.
//
//   hosts      only api.anthropic.com, firestore.googleapis.com and oauth2.googleapis.com. A
//              NuVizz host, the site's own functions (a same-origin call to nuvizz-manual-scan
//              is ~3,000 vendor calls) and every other host are refused before a byte leaves.
//   Firestore  reads pass. Every WRITE — PATCH, DELETE, a create, documents:commit and
//              :batchWrite — must name a document under claude_shadow_*, read off the URL AFTER
//              the URL parser has normalised it (a TAB between two dots is gone by then, which
//              is exactly the '..' the store's own check refuses) and off every write in a
//              commit body. Anything the lock cannot read as a read or a shadow write is refused.
//
// Installed at the top of every claude-shadow* handler invocation, and pinned by hash in the
// guard: this file changes only with a person re-reading it.
export const EGRESS_HOSTS = ['api.anthropic.com', 'firestore.googleapis.com', 'oauth2.googleapis.com'];
export const SHADOW_DOC_PREFIX = 'claude_shadow_';

export class EgressRefused extends Error {
  constructor(message: string) { super(message); this.name = 'EgressRefused'; }
}

const READ_VERBS = [':runQuery', ':runAggregationQuery', ':batchGet', ':listCollectionIds', ':listDocuments', ':beginTransaction', ':rollback'];
const WRITE_VERBS = [':commit', ':batchWrite'];
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** The document path after `/documents/`, or null when the URL does not name one. */
function docPathOf(pathname: string): string | null {
  const i = pathname.indexOf('/documents/');
  if (i < 0) return null;
  return pathname.slice(i + '/documents/'.length);
}

function isShadowDoc(path: string): boolean {
  let p = path;
  try { p = decodeURIComponent(path); } catch { return false; }
  if (CONTROL_RE.test(p)) return false;
  const segs = p.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return false;
  return segs[0].startsWith(SHADOW_DOC_PREFIX) && segs[0].length > SHADOW_DOC_PREFIX.length;
}

/** Throws EgressRefused unless this request is one the shadow planner may make. Pure: no I/O. */
export function judgeRequest(url: string, method: string, body: unknown): void {
  let u: URL;
  try { u = new URL(url); } catch { throw new EgressRefused(`refused: unreadable URL ${JSON.stringify(String(url).slice(0, 120))}`); }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || !EGRESS_HOSTS.includes(host)) throw new EgressRefused(`refused: ${u.protocol}//${host} is not a host the shadow planner may reach`);
  if (host !== 'firestore.googleapis.com') return;

  const m = String(method || 'GET').toUpperCase();
  const pathname = u.pathname;
  if (m === 'GET') return;
  if (m === 'POST' && READ_VERBS.some((v) => pathname.endsWith(v))) return;
  if (m === 'POST' && WRITE_VERBS.some((v) => pathname.endsWith(v))) {
    let parsed: any;
    try { parsed = typeof body === 'string' ? JSON.parse(body) : null; } catch { parsed = null; }
    const writes = Array.isArray(parsed?.writes) ? parsed.writes : null;
    if (!writes) throw new EgressRefused('refused: a Firestore commit the lock cannot read');
    for (const w of writes) {
      // EVERY name a write carries is judged, not the first one found: a write naming a shadow
      // document in one field and another document in a second is refused, whatever Firestore
      // would have made of it.
      const names = [w?.update?.name, w?.delete, w?.transform?.document].filter((n) => n !== undefined);
      if (!names.length) throw new EgressRefused('refused: a Firestore write the lock cannot read');
      for (const name of names) {
        const path = typeof name === 'string' ? docPathOf('/' + name.replace(/^\/+/, '')) : null;
        if (!path || !isShadowDoc(path)) throw new EgressRefused(`refused: a Firestore write outside ${SHADOW_DOC_PREFIX}* (${String(name).slice(0, 120)})`);
      }
    }
    return;
  }
  if (m === 'PATCH' || m === 'DELETE' || m === 'POST') {
    const path = docPathOf(pathname);
    if (path && isShadowDoc(path)) return;
    throw new EgressRefused(`refused: Firestore ${m} outside ${SHADOW_DOC_PREFIX}* (${pathname.slice(0, 160)})`);
  }
  throw new EgressRefused(`refused: Firestore ${m} is not a read or a shadow write`);
}

const LOCK_MARK = '__claudeShadowEgressLock';

/**
 * Wrap the global fetch so every request is judged first. Call it at the top of every handler
 * invocation: it is a no-op when the current fetch is already the lock, and it re-wraps when
 * anything has replaced fetch since — so the lock cannot quietly fall off between invocations.
 */
export function lockEgress(): void {
  const g: any = globalThis;
  const inner = g.fetch;
  if (typeof inner !== 'function' || inner[LOCK_MARK] === true) return;
  const locked = async function shadowFetch(input: any, init?: any) {
    // WHAT IS JUDGED IS WHAT IS SENT. A URL string (or URL) only — a Request object or a look-alike
    // carries its own method and body the lock would have to trust. The options are read ONCE into
    // a plain copy: an options object whose `method` getter answers GET to the judge and PATCH to
    // the network would otherwise walk straight through.
    if (typeof input !== 'string' && !(input instanceof URL)) throw new EgressRefused('refused: the shadow planner fetches by URL string only');
    const url = String(input);
    const opts: any = init ? { ...init } : {};
    judgeRequest(url, opts.method ?? 'GET', opts.body);
    return inner(url, opts);
  };
  Object.defineProperty(locked, LOCK_MARK, { value: true });
  g.fetch = locked;
}

// LOCKED AT IMPORT, not only when a handler runs. Every claude-shadow* function imports this
// module FIRST (the guard checks the order), and ES modules evaluate in import order, so the lock
// is in place before any other module's top-level code — a top-level await in a shadow library
// included — can reach fetch. The handler calls lockEgress() again in case anything replaced
// fetch since.
lockEgress();

/** Whether the fetch this instance would use right now is the lock. */
export function egressLocked(): boolean {
  const f: any = (globalThis as any).fetch;
  return typeof f === 'function' && f[LOCK_MARK] === true;
}
