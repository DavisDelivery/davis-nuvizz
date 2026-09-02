// test/firestore-rules-shape.test.mjs — THE RULES FILE, PINNED.
//
// firestore.rules is the browser's only door into Firestore, and it is the one
// file in this repo where a wrong answer costs a morning rather than a stack
// trace. A rule that denies something the app needs does not stop the board: the
// map still renders, the pins still paint, and every receiving hour is quietly
// missing. Since v0.84 a denial at least SAYS so — src/lib/permission-denied.js
// classifies the error and PermissionBanner puts a red bar above both headers —
// but the board still comes up around the hole, so "no errors in the console" has
// never been the test and still is not.
//
// Nothing in this repo deploys firestore.rules (firebase-tools is not a
// dependency; no workflow mentions Firebase), so there is no emulator here and
// these are TEXT assertions on the file. That is the honest scope: they pin the
// SHAPE of the ruleset — who is denied outright, who is granted what, that every
// call site the browser actually makes has a rule behind it, and that the CUTOVER
// RUNBOOK in the file's own comments is still true. Whether Firestore agrees with
// our reading of the syntax is what the uat-mirror rehearsal is for.
//
// THE RUNBOOK IS PART OF THE ARTEFACT. The cutover is the most dangerous deploy in
// this change set and this file's header is the only instruction sheet for it. A
// precondition that names the wrong environment variable is not a documentation
// nit — it is the defect, because the person following it will believe they are
// ready when they are not. Several assertions below exist for exactly that.
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

// One path segment of a match: a wildcard (`{doc}`, `{doc=**}`) OR a literal
// document id. The literal form is not decoration — `nuvizz_ops` is granted ONE
// DOCUMENT, because that is all the browser reads and the rest of the collection
// is manifest OCR rows, raw PDFs and a live OAuth nonce.
const SEG = '(?:\\{[^}]*\\}|[A-Za-z0-9_]+)';

/** The `match /<coll>/<seg> { … }` body for one collection, single-line or braced. */
function grantsFor(coll) {
  const oneLine = new RegExp(`^\\s*match\\s+/${coll}/${SEG}\\s*\\{([^\\n]*)\\}\\s*$`, 'm');
  const single = CUTOVER_CODE.match(oneLine);
  if (single) return single[1];
  const braced = new RegExp(`^\\s*match\\s+/${coll}/${SEG}\\s*\\{\\s*$([\\s\\S]*?)^\\s*\\}\\s*$`, 'm');
  const multi = CUTOVER_CODE.match(braced);
  return multi ? multi[1] : null;
}

/** Every path segment the ruleset matches under one collection, in file order. */
function matchPathsFor(coll) {
  const re = new RegExp(`^\\s*match\\s+/${coll}/(${SEG})`, 'gm');
  return [...CUTOVER_CODE.matchAll(re)].map((m) => m[1]);
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

/** The LIVE block's exclusion list, read out of serverOnlyCollection()'s body. */
function liveServerOnlyList() {
  const m = RULES_TEXT.match(/function\s+serverOnlyCollection\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(m, 'serverOnlyCollection() is gone from firestore.rules — the LIVE block no longer excludes anything, so driver_auth and nuvizz_secrets are world-writable again');
  return [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
}

// ── what the browser ACTUALLY does, read off the source ──────────────────────
// Derived, never hardcoded: a new setDoc added to a component next month lands in
// this set automatically and fails the test if no rule was written for it. That
// is the failure this file exists to prevent — the call site and the rule
// drifting apart with nothing on screen to say so.
//
// .ts AND .tsx ARE SCANNED, not just .js/.jsx. src/lib/customer-notes-writer.ts is
// a TypeScript file that writes customer_notes, and while this scanner only read
// .js/.jsx that write was covered by luck — customer_notes happened to have a
// grant for other reasons. The next .ts write target would not be so lucky, and
// the whole point of deriving the set is that luck is not part of it.
function srcFiles(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return srcFiles(p);
    return /\.(js|jsx|ts|tsx)$/.test(n) ? [p] : [];
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
// A batched write is still a write. customer-notes-writer.ts merges the scanner's
// findings with `batch.set(doc(db, 'customer_notes', …))`, which matches none of the
// patterns above — so without this line the collection whose loss means "every
// customer silently has no receiving hours" was invisible to this scanner.
for (const c of collectionsFor(
  new RegExp(`\\b(?:batch|b)\\.(?:set|update|delete)\\(\\s*doc\\(\\s*db\\s*,\\s*${ARG}`, 'g'),
)) {
  BROWSER_WRITES.add(c);
}
for (const c of collectionsFor(new RegExp(`\\baddDoc\\(\\s*collection\\(\\s*db\\s*,\\s*${ARG}`, 'g'))) {
  BROWSER_WRITES.add(c);
}
const BROWSER_READS = new Set([
  ...collectionsFor(new RegExp(`\\b(?:getDoc|onSnapshot)\\(\\s*doc\\(\\s*db\\s*,\\s*${ARG}`, 'g')),
  ...collectionsFor(new RegExp(`\\b(?:getDocs|onSnapshot|query)\\(\\s*collection\\(\\s*db\\s*,\\s*${ARG}`, 'g')),
]);

/** The nuvizz_ops DOCUMENTS the browser actually names, e.g. 'manifest_check_latest'. */
const BROWSER_NUVIZZ_OPS_DOCS = [...new Set(
  [...SRC_TEXT.matchAll(/\bdoc\(\s*db\s*,\s*['"]nuvizz_ops['"]\s*,\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
)];

const SERVER_ONLY = [
  'driver_auth',
  'app_users',
  'nuvizz_secrets',
  'nuvizz_load_scans',
  'loadscan_worklog',
  'loadscan_assignments',
  'load_scan_unmatched_aliases',
];

// ── the LIVE block: the only part of this file that protects anything today ──

test('THE LIVE BLOCK closes nuvizz_secrets — the sealed Gmail refresh token is the overnight manifest ingest\'s only credential, and deleting it stops the check finding anything', () => {
  const live = liveServerOnlyList();
  assert.ok(
    live.includes('nuvizz_secrets'),
    'nuvizz_secrets is not in serverOnlyCollection(), so the LIVE block leaves it world read AND WRITE. The blob is AES-256-GCM sealed so READING it is worth little; DELETING or overwriting it kills the Gmail grant behind lib/mail-sources.mts, and the overnight Uline manifest ingest is the only thing that says an order on the manifest never reached NuVizz. It does not fail loudly — the check just stops finding things, which reads exactly like a clean week.',
  );
  assert.deepEqual(
    [...live].sort(),
    [...SERVER_ONLY].sort(),
    'the LIVE block\'s serverOnlyCollection() and the cutover block\'s deny list have drifted. One of them is now lying about which collections the browser may never touch.',
  );
});

test('nothing in dispatch-map/src has a call site for a server-only collection — the claim in the file is enforced, not asserted', () => {
  for (const coll of SERVER_ONLY) {
    assert.ok(!BROWSER_READS.has(coll), `${coll} is denied to the browser but dispatch-map/src reads it — that deny is a board going dark, not a hole being closed`);
    assert.ok(!BROWSER_WRITES.has(coll), `${coll} is denied to the browser but dispatch-map/src writes it`);
  }
});

// ── the guard that keeps a real cutover from happening by accident ───────────

test('a stranger with the public web config cannot write driver_auth/9999 {role:"dispatcher"} — the seven server-only collections are denied outright', () => {
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
  assert.deepEqual(grantedOps('nuvizz_ops', 'write'), [], 'nuvizz_ops grants a write. The browser performs ZERO writes to it (its only call site is an onSnapshot on manifest_check_latest); a grant here is the bypass around nuvizz-scan-config\'s admin gate');
  assert.ok(grantedOps('nuvizz_ops', 'read').length > 0, 'nuvizz_ops must still be readable — the browser subscribes to manifest_check_latest');
});

test('nuvizz_ops is granted ONE DOCUMENT, not the whole collection: manifest_ocr__* is every name, address and PRO off a manifest, manifest_pdf__* is the raw PDF, gmail_oauth_state is a live nonce', () => {
  assert.ok(
    BROWSER_NUVIZZ_OPS_DOCS.length > 0,
    'the scanner no longer sees any nuvizz_ops document in dispatch-map/src — either the call site moved or the pattern broke; either way this test is no longer checking anything',
  );
  const paths = matchPathsFor('nuvizz_ops');
  assert.ok(paths.length > 0, 'nuvizz_ops has no match block at all');
  for (const p of paths) {
    assert.doesNotMatch(
      p,
      /^\{/,
      `nuvizz_ops is matched with the wildcard ${p}, which grants the WHOLE collection for one document's sake. That collection also holds manifest_ocr__<jobId> (customer names, addresses and PRO numbers off every manifest), manifest_pdf__<jobId>__<seq> (the raw base64 PDF), gmail_oauth_state (a live OAuth state nonce), scan_config and circuit. The block's own rule is that an operation with no call site gets \`if false\`, not isStaff().`,
    );
  }
  assert.deepEqual(
    [...paths].sort(),
    [...BROWSER_NUVIZZ_OPS_DOCS].sort(),
    `the nuvizz_ops documents granted in firestore.rules are not the ones dispatch-map/src reads. Granted: ${JSON.stringify(paths)}. Read by the browser: ${JSON.stringify(BROWSER_NUVIZZ_OPS_DOCS)}. A document granted with no call site is a door opened just in case; one read with no grant is the manifest-check banner going blank behind a red bar.`,
  );
});

test('every collection the browser writes has a write grant — a missing one is a pin drag that never saves', () => {
  assert.ok(BROWSER_WRITES.size >= 6, `only found ${BROWSER_WRITES.size} browser write targets; the scanner has stopped seeing the call sites`);
  for (const coll of BROWSER_WRITES) {
    const ops = grantedOps(coll, 'write');
    assert.ok(ops && ops.length > 0, `the browser writes ${coll} (grep dispatch-map/src, .ts and .tsx included) but the cutover ruleset grants it no write — the setDoc would be denied and the pin-override handlers clear the form exactly as they do on success`);
  }
});

test('the .ts scanner gap is closed: customer-notes-writer.ts\'s batched merge is seen as a customer_notes write', () => {
  // It used to be covered by luck — the file was not scanned at all, and
  // `batch.set(doc(db, …))` matched none of the write patterns, so the collection
  // whose absence means "every customer silently has no receiving hours" was
  // invisible here and happened to have a grant for other reasons.
  assert.ok(
    BROWSER_WRITES.has('customer_notes'),
    'customer_notes is not in the derived write set — src/lib/customer-notes-writer.ts writes it with batch.set(doc(db, "customer_notes", …)), so either the .ts scan or the batch pattern has regressed',
  );
});

test('every collection the browser reads has a read grant — a missing one is a board rendering around a hole', () => {
  assert.ok(BROWSER_READS.size >= 10, `only found ${BROWSER_READS.size} browser read targets; the scanner has stopped seeing the call sites`);
  for (const coll of BROWSER_READS) {
    const ops = grantedOps(coll, 'read');
    assert.ok(ops && ops.length > 0, `the browser reads ${coll} but the cutover ruleset grants it no read — the board still renders, with a red permission bar and that data missing`);
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

test('a viewer with the board open still shows in the presence chip, and the 25s heartbeat is not denied into a permanent red bar', () => {
  const body = grantsFor('dispatch_presence');
  const writes = allowsIn(body).filter((a) => a.ops.some((o) => WRITE_OPS.includes(o)));
  assert.ok(writes.length > 0 && writes.every((a) => /signedIn\(\)/.test(a.cond)), 'dispatch_presence writes must be granted to any signed-in user: publish() fires unconditionally on mount and every PRESENCE_HEARTBEAT_MS (25s), so a denial is a bar that can never be cleared');
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
  assert.deepEqual([...inRules].sort(), [...ROLES].sort(), `firestore.rules spells the roles ${JSON.stringify([...inRules].sort())} but auth-core.mts:35 says ${JSON.stringify([...ROLES].sort())}. A role the rules do not know reads NOTHING.`);
});

test('a "viewer" can read the board: canRead() is wider than isStaff(), because the first draft locked viewers out of everything silently', () => {
  const canRead = CUTOVER_CODE.match(/function\s+canRead\s*\(\)[^\n]*/)[0];
  const isStaff = CUTOVER_CODE.match(/function\s+isStaff\s*\(\)[^\n]*/)[0];
  assert.match(canRead, /'viewer'/, 'canRead() must include viewer');
  assert.doesNotMatch(isStaff, /'viewer'/, 'isStaff() must NOT include viewer — a viewer is read-only by definition (auth-core.mts:33)');
  for (const coll of ['customer_notes', 'routing_routes', 'sms_messages', 'nuvizz_ops']) {
    assert.match(grantsFor(coll), /allow read:\s*if canRead\(\)/, `${coll} reads must be canRead(), not isStaff() — otherwise a viewer gets a board with that data missing and no reason to be shown one`);
  }
});

// ── the runbook itself ───────────────────────────────────────────────────────

test('THE CUTOVER CHECKLIST NAMES VITE_LOGIN_ENABLED: with that flag unset the browser never signs in to Firebase at all, and deploying the cutover is a total blackout', () => {
  assert.match(
    CUTOVER,
    /VITE_LOGIN_ENABLED/,
    'the cutover preconditions do not mention VITE_LOGIN_ENABLED. That is the flag serverLoginEnabled() reads (src/lib/auth-client.js) and therefore the flag that gates the entire Firebase leg — redeemFirebaseSession() → auth-firebase-token → signInWithCustomToken. With it unset there is no login, nothing puts a request.auth in front of these rules, and this ruleset denies every read and every write for every user on a 700-stop morning.',
  );
  assert.ok(
    /VITE_AUTH_ENABLED[\s\S]{0,300}retired/i.test(CUTOVER) || /retired[\s\S]{0,300}VITE_AUTH_ENABLED/i.test(CUTOVER),
    'the checklist names VITE_AUTH_ENABLED without saying it is RETIRED. It is the old Firebase-login flag (src/lib/auth.js); a runbook that presents it as the gate sends whoever follows it to set the wrong variable and conclude they are ready.',
  );
  const numbered = [...CUTOVER.matchAll(/^\s*(\d+)\.\s/gm)].map((m) => Number(m[1]));
  assert.deepEqual(numbered, [1, 2, 3, 4, 5], `the precondition list reads ${JSON.stringify(numbered)}; it must be the five numbered items the header promises, in order`);
  assert.match(CUTOVER, /ALL FIVE/, 'the checklist preamble must agree with the number of preconditions it lists');
  assert.match(RULES_TEXT, /satisfy the five preconditions/, 'the file header still promises a different number of preconditions than the block lists');
});

test('the file does not still claim request.auth is always null — the browser redeems a Firebase custom token now', () => {
  assert.match(
    RULES_TEXT,
    /signInWithCustomToken/,
    'firestore.rules no longer explains how request.auth gets populated. src/lib/auth-client.js redeems the session for a Firebase CUSTOM token (auth-firebase-token.mts) and calls signInWithCustomToken; that call is the only reason a cutover is possible, and a runbook that says every request arrives unauthenticated is describing the app as it was before v0.84.',
  );
  assert.doesNotMatch(
    RULES_TEXT,
    /never imports firebase\/auth, and the sign-in screen that does exist is inert behind VITE_AUTH_ENABLED/,
    'the pre-v0.84 sentence is back: the sign-in screen is gated by VITE_LOGIN_ENABLED, and src/lib/auth-client.js does import firebase/auth (dynamically) to call signInWithCustomToken',
  );
});

test('the file does not still claim src/lib/auth-gate.js maps a viewer to "driver" — that was fixed in this change set', async () => {
  const { ROLES: CLIENT_ROLES, DEFAULT_ROLE } = await import('../src/lib/auth-gate.js');
  assert.ok(
    !CLIENT_ROLES.includes('driver') && DEFAULT_ROLE === 'viewer',
    'src/lib/auth-gate.js has gone back to the load-scan vocabulary; precondition 4 in firestore.rules is written on the assumption it has not',
  );
  assert.doesNotMatch(
    RULES_TEXT,
    /today it maps it to 'driver'/,
    "firestore.rules still says auth-gate.js maps a viewer to 'driver' in the present tense. It does not: ROLES is ['viewer','dispatcher','admin'] with DEFAULT_ROLE 'viewer' (pinned by test/auth-gate.test.mjs). A precondition that is already satisfied but reads as outstanding is a cutover that gets postponed for no reason — or a checklist that stops being read.",
  );
});

// ── the interlock ────────────────────────────────────────────────────────────

test('THE CUTOVER IS INERT: uncommenting it before the browser signs in denies every read and every write for everybody', () => {
  // DELETE THIS TEST ON CUTOVER DAY — deliberately, in the same commit that
  // performs the cutover, having read the five preconditions in firestore.rules.
  // It exists so that day cannot arrive by accident: the Firebase sign-in leg is
  // behind VITE_LOGIN_ENABLED (src/lib/auth-client.js), that flag is not set on
  // production, so nothing calls signInWithCustomToken and every request today
  // still has request.auth == null.
  const b = RULES_LINES.findIndex((l) => l.includes(BEGIN));
  const e = RULES_LINES.findIndex((l) => l.includes(END));
  const live = RULES_LINES.slice(b + 1, e).filter((l) => l.trim() && !l.trim().startsWith('//'));
  assert.deepEqual(live, [], `the cutover block has been uncommented (${live.length} live lines). If that is deliberate, delete THIS test in the same commit and say in the PR that VITE_LOGIN_ENABLED is live on the site, that every account exists and has signed in once, and that it was rehearsed on uat-mirror first.`);
  assert.match(RULES_TEXT, /match \/\{document=\*\*\} \{\s*\n\s*allow read, write: if !serverOnlyCollection\(document\);/, 'the LIVE open block is gone while the cutover block is still commented — that leaves the file with no active ruleset for the browser at all');
});

test('firestore.rules still says, in the file, that nothing here deploys it and that rules are per-database', () => {
  assert.match(RULES_TEXT, /NOTHING IN THIS REPO DEPLOYS THIS FILE/);
  assert.match(RULES_TEXT, /firebase deploy --only firestore:rules/);
  assert.match(RULES_TEXT, /PER-DATABASE/);
  assert.match(RULES_TEXT, /uat-mirror is a separate database with its own rules/);
});
