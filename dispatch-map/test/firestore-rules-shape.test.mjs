// test/firestore-rules-shape.test.mjs — THE RULES FILE, PINNED.
//
// firestore.rules is the browser's only door into Firestore, and it is the one
// file in this repo whose failure mode is SILENCE. Seven of the browser's ten
// read paths swallow permission-denied (App.jsx:1934, 1953, 7994, 14519, 14553,
// 22357, 22485) and both pin-override writes do the same (App.jsx:10754/10769
// and their desktop twins 18885/18900) — so a rule that denies something the app
// needs does not raise an error, it renders a board that looks right and is
// missing every receiving hour. Nothing else would catch that until a truck
// pulled up to a closed dock.
//
// Nothing in this repo deploys firestore.rules (firebase-tools is not a
// dependency; no workflow mentions Firebase), so there is no emulator here and
// these are TEXT assertions on the file. That is the honest scope: they pin the
// SHAPE of the ruleset — who is denied outright, who is granted what, and that
// every call site the browser actually makes has a rule behind it. Whether
// Firestore agrees with our reading of the syntax is what the uat-mirror
// rehearsal is for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.AUTH_SESSION_SECRET ||= 'test-session-secret-that-is-long-enough-32';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const RULES_PATH = join(REPO, 'firestore.rules');
const SRC = join(HERE, '..', 'src');

const RULES_TEXT = readFileSync(RULES_PATH, 'utf8');
const RULES_LINES = RULES_TEXT.split('\n');

const BEGIN = '===== CUTOVER BLOCK BEGIN =====';
const END = '===== CUTOVER BLOCK END =====';

// The cutover block ships COMMENTED (see firestore.rules' header). Extraction
// strips one leading `//` per line so these assertions read the same ruleset
// before and after the cutover — the markers are the anchor either way, which is
// why the file tells whoever performs the cutover to leave them in place.
function cutoverRuleset() {
  const b = RULES_LINES.findIndex((l) => l.includes(BEGIN));
  const e = RULES_LINES.findIndex((l) => l.includes(END));
  assert.ok(b >= 0, `firestore.rules has lost its "${BEGIN}" marker — this test finds the ruleset by it`);
  assert.ok(e > b, `firestore.rules has lost its "${END}" marker, or it precedes BEGIN`);
  return RULES_LINES.slice(b + 1, e)
    .map((l) => l.replace(/^(\s*)\/\/ ?/, '$1'))
    .join('\n');
}

const CUTOVER = cutoverRuleset();

// Only the lines that are rules, so prose describing a collection can never be
// mistaken for a grant on it.
const CUTOVER_CODE = CUTOVER.split('\n')
  .filter((l) => /^\s*(function\s|match\s+\/|allow\s|\})/.test(l))
  .join('\n');

/** The `match /<coll>/{…} { … }` body for one collection, single-line or braced. */
function grantsFor(coll) {
  const oneLine = new RegExp(`^\\s*match\\s+/${coll}/\\{[^}]*\\}\\s*\\{([^\\n]*)\\}\\s*$`, 'm');
  const single = CUTOVER_CODE.match(oneLine);
  if (single) return single[1];
  const braced = new RegExp(`^\\s*match\\s+/${coll}/\\{[^}]*\\}\\s*\\{\\s*$([\\s\\S]*?)^\\s*\\}\\s*$`, 'm');
  const multi = CUTOVER_CODE.match(braced);
  return multi ? multi[1] : null;
}

/** Every `allow a, b: if COND;` in a block, as {ops:[…], cond}. */
function allowsIn(body) {
  return [...body.matchAll(/allow\s+([a-z,\s]+?)\s*:\s*if\s+([^;]+);/g)].map((m) => ({
    ops: m[1].split(',').map((s) => s.trim()).filter(Boolean),
    cond: m[2].trim(),
  }));
}

const WRITE_OPS = ['write', 'create', 'update', 'delete'];
function grantedOps(coll, kind) {
  const body = grantsFor(coll);
  if (body == null) return null;
  const want = kind === 'read' ? ['read', 'get', 'list', 'write'] : WRITE_OPS;
  return allowsIn(body)
    .filter((a) => a.cond !== 'false' && a.ops.some((o) => want.includes(o)))
    .flatMap((a) => a.ops);
}

// ── what the browser ACTUALLY does, read off the source ──────────────────────
// Derived, never hardcoded: a new setDoc added to a component next month lands in
// this set automatically and fails the test if no rule was written for it. That
// is the failure this file exists to prevent — the call site and the rule
// drifting apart with nothing on screen to say so.
function srcFiles(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return srcFiles(p);
    return /\.(js|jsx)$/.test(n) ? [p] : [];
  });
}

const SRC_TEXT = srcFiles(SRC).map((p) => readFileSync(p, 'utf8')).join('\n');

/** `doc(db, PRESENCE_COLL, …)` → resolve the constant to its string literal. */
function resolveColl(tok) {
  if (/^['"]/.test(tok)) return tok.slice(1, -1);
  const m = SRC_TEXT.match(new RegExp(`\\b(?:const|let|var)\\s+${tok}\\s*=\\s*['"]([^'"]+)['"]`));
  return m ? m[1] : null;
}

function collectionsFor(callRe) {
  const out = new Set();
  for (const m of SRC_TEXT.matchAll(callRe)) {
    const c = resolveColl(m[m.length - 1]);
    if (c) out.add(c);
  }
  return out;
}

const ARG = `(['"][^'"]+['"]|[A-Za-z_$][\\w$]*)`;
const BROWSER_WRITES = collectionsFor(
  new RegExp(`\\b(?:setDoc|updateDoc|deleteDoc)\\(\\s*doc\\(\\s*db\\s*,\\s*${ARG}`, 'g'),
);
for (const c of collectionsFor(new RegExp(`\\baddDoc\\(\\s*collection\\(\\s*db\\s*,\\s*${ARG}`, 'g'))) {
  BROWSER_WRITES.add(c);
}
const BROWSER_READS = new Set([
  ...collectionsFor(new RegExp(`\\b(?:getDoc|onSnapshot)\\(\\s*doc\\(\\s*db\\s*,\\s*${ARG}`, 'g')),
  ...collectionsFor(new RegExp(`\\b(?:getDocs|onSnapshot|query)\\(\\s*collection\\(\\s*db\\s*,\\s*${ARG}`, 'g')),
]);

const SERVER_ONLY = [
  'driver_auth',
  'app_users',
  'nuvizz_load_scans',
  'loadscan_worklog',
  'loadscan_assignments',
  'load_scan_unmatched_aliases',
];

// ── the guard that keeps a real cutover from happening by accident ───────────

test('a stranger with the public web config cannot write driver_auth/9999 {role:"dispatcher"} — the six server-only collections are denied outright', () => {
  for (const coll of SERVER_ONLY) {
    const body = grantsFor(coll);
    assert.ok(body != null, `${coll} has no match block in the cutover ruleset`);
    for (const a of allowsIn(body)) {
      assert.equal(a.cond, 'false', `${coll} grants "${a.ops.join(',')}" to ${a.cond} — it is reached ONLY by the service account, and the browser has zero references to it`);
    }
    assert.ok(/allow\s+read\s*,\s*write\s*:\s*if\s+false/.test(body), `${coll} must deny read AND write`);
  }
});

test('the browser cannot force a ~3,000-call NuVizz scan or flip the customer mailer: nuvizz_ops is read-only', () => {
  const body = grantsFor('nuvizz_ops');
  assert.ok(body != null, 'nuvizz_ops has no match block — it would fall to the catch-all deny and blank the manifest-check banner');
  assert.deepEqual(grantedOps('nuvizz_ops', 'write'), [], 'nuvizz_ops grants a write. The browser performs ZERO writes to it (its only call site is the onSnapshot at App.jsx:22479); a grant here is the bypass around nuvizz-scan-config\'s admin gate');
  assert.ok(grantedOps('nuvizz_ops', 'read').length > 0, 'nuvizz_ops must still be readable — App.jsx:22479 subscribes to manifest_check_latest');
});

test('every collection the browser writes has a write grant — a missing one is a pin drag that never saves and says nothing', () => {
  assert.ok(BROWSER_WRITES.size >= 6, `only found ${BROWSER_WRITES.size} browser write targets; the scanner has stopped seeing the call sites`);
  for (const coll of BROWSER_WRITES) {
    const ops = grantedOps(coll, 'write');
    assert.ok(ops && ops.length > 0, `the browser writes ${coll} (grep dispatch-map/src) but the cutover ruleset grants it no write — setDoc would be denied, and App.jsx:10754/10769/18885/18900 console.error and clear the form exactly as they do on success`);
  }
});

test('every collection the browser reads has a read grant — a missing one is a blank board at 6am with no error', () => {
  assert.ok(BROWSER_READS.size >= 10, `only found ${BROWSER_READS.size} browser read targets; the scanner has stopped seeing the call sites`);
  for (const coll of BROWSER_READS) {
    const ops = grantedOps(coll, 'read');
    assert.ok(ops && ops.length > 0, `the browser reads ${coll} but the cutover ruleset grants it no read — seven of these ten paths swallow permission-denied, so it goes missing silently`);
  }
});

test('deleting a customer note is denied: a note deleted is receiving hours reverting to "none known" with no trace', () => {
  for (const coll of ['customer_notes', 'routing_jobs', 'truck_profiles']) {
    const body = grantsFor(coll);
    const del = allowsIn(body).filter((a) => a.ops.includes('delete') || a.ops.includes('write'));
    assert.ok(del.length > 0 && del.every((a) => a.cond === 'false'), `${coll} allows delete; the browser has no deleteDoc for it`);
  }
  // The ones that DO delete keep the grant — denying it leaves a row on screen
  // and a dispatcher pressing the button again.
  for (const coll of ['routing_routes', 'bottom_panel_profiles', 'dispatch_presence']) {
    const ops = grantedOps(coll, 'write') || [];
    assert.ok(ops.includes('delete'), `${coll} needs delete — the browser calls deleteDoc on it`);
  }
});

test('a viewer with the board open still shows in the presence chip, and the 25s heartbeat is not denied into silence', () => {
  const body = grantsFor('dispatch_presence');
  const writes = allowsIn(body).filter((a) => a.ops.some((o) => WRITE_OPS.includes(o)));
  assert.ok(writes.length > 0 && writes.every((a) => /signedIn\(\)/.test(a.cond)), 'dispatch_presence writes must be granted to any signed-in user: publish() fires unconditionally on mount and every PRESENCE_HEARTBEAT_MS (25s) and swallows its own failure (App.jsx:22315), so a denial is invisible forever');
});

test('a collection nobody named is closed, not open — the catch-all denies', () => {
  assert.match(CUTOVER_CODE, /match\s+\/\{document=\*\*\}\s*\{\s*allow read,\s*write:\s*if false;\s*\}/, 'the cutover ruleset has no default-deny catch-all');
});

// ── the two vocabularies that must not drift ─────────────────────────────────

test('the roles in firestore.rules are exactly auth-core.mts\'s Role union — a fourth role added on one side only is a red build, not a discovery made at a dock', async () => {
  const { ROLES } = await import('../netlify/functions/lib/auth-core.mts');
  const helpers = CUTOVER_CODE.split('\n').filter((l) => /^\s*function\s+(isStaff|canRead)\s*\(/.test(l)).join('\n');
  assert.ok(helpers.includes('isStaff') && helpers.includes('canRead'), 'isStaff()/canRead() are gone from the cutover ruleset');
  const inRules = new Set([...helpers.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  assert.deepEqual([...inRules].sort(), [...ROLES].sort(), `firestore.rules spells the roles ${JSON.stringify([...inRules].sort())} but auth-core.mts:35 says ${JSON.stringify([...ROLES].sort())}. A role the rules do not know reads NOTHING, and seven of the browser's ten read paths swallow that — a blank board with no error.`);
});

test('a "viewer" can read the board: canRead() is wider than isStaff(), because the first draft locked viewers out of everything silently', () => {
  const canRead = CUTOVER_CODE.match(/function\s+canRead\s*\(\)[^\n]*/)[0];
  const isStaff = CUTOVER_CODE.match(/function\s+isStaff\s*\(\)[^\n]*/)[0];
  assert.match(canRead, /'viewer'/, 'canRead() must include viewer');
  assert.doesNotMatch(isStaff, /'viewer'/, 'isStaff() must NOT include viewer — a viewer is read-only by definition (auth-core.mts:33)');
  for (const coll of ['customer_notes', 'routing_routes', 'sms_messages', 'nuvizz_ops']) {
    assert.match(grantsFor(coll), /allow read:\s*if canRead\(\)/, `${coll} reads must be canRead(), not isStaff() — otherwise a viewer gets a blank board with no error`);
  }
});

// ── the interlock ────────────────────────────────────────────────────────────

test('THE CUTOVER IS INERT: uncommenting it before the browser signs in blanks the whole board at 6am and reports nothing', () => {
  // DELETE THIS TEST ON CUTOVER DAY — deliberately, in the same commit that
  // performs the cutover, having read the four preconditions in firestore.rules.
  // It exists so that day cannot arrive by accident: src/lib/firebase.js calls
  // getFirestore(app) with no credential and src/lib/auth.js only imports
  // firebase/auth when VITE_AUTH_ENABLED is on, so every request today has
  // request.auth == null and the cutover ruleset would deny all of them.
  const b = RULES_LINES.findIndex((l) => l.includes(BEGIN));
  const e = RULES_LINES.findIndex((l) => l.includes(END));
  const live = RULES_LINES.slice(b + 1, e).filter((l) => l.trim() && !l.trim().startsWith('//'));
  assert.deepEqual(live, [], `the cutover block has been uncommented (${live.length} live lines). If that is deliberate, delete THIS test in the same commit and say in the PR that every account exists, has signed in once, and that it was rehearsed on uat-mirror first.`);
  assert.match(RULES_TEXT, /match \/\{document=\*\*\} \{\s*\n\s*allow read, write: if !serverOnlyCollection\(document\);/, 'the LIVE open block is gone while the cutover block is still commented — that leaves the file with no active ruleset for the browser at all');
});

test('firestore.rules still says, in the file, that nothing here deploys it and that rules are per-database', () => {
  assert.match(RULES_TEXT, /NOTHING IN THIS REPO DEPLOYS THIS FILE/);
  assert.match(RULES_TEXT, /firebase deploy --only firestore:rules/);
  assert.match(RULES_TEXT, /PER-DATABASE/);
  assert.match(RULES_TEXT, /uat-mirror is a separate database with its own rules/);
});
