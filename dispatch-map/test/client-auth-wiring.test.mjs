// test/client-auth-wiring.test.mjs — THE WIRING, PINNED AT THE SOURCE.
//
// These are source-level tests on purpose. The things they pin are not decisions inside a
// function, they are decisions about WHERE code is — and every one of them is the kind a
// later refactor undoes by accident, silently, in a way no unit test would notice:
//
//  · a new screen added with a raw fetch(), which 401s the morning AUTH_REQUIRED is set;
//  · the Drivers panel converted "for consistency", which ships a dispatch-map session
//    token to a second origin and breaks driver administration;
//  · one of the ten swallowing Firestore handlers reverted to `() => {}`, which brings back
//    the board that looks normal at 6am and is missing every receiving hour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(js|jsx|ts|tsx)$/.test(name) ? [p] : [];
  });
}
const FILES = walk(SRC).map((p) => ({ rel: path.relative(SRC, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') }));
const byName = (rel) => FILES.find((f) => f.rel === rel)?.text ?? assert.fail(`missing ${rel}`);
const APP = byName('App.jsx');

// The only files allowed to call fetch() at a function URL directly, and why.
const RAW_FETCH_ALLOWED = {
  'lib/api.js': 'it IS apiFetch',
  'lib/auth-client.js': 'auth-login / auth-change-password answer 401 for a WRONG PASSWORD, not a dead session — routing them through apiFetch would sign a dispatcher out for a typo',
  'components/DriversPanel.jsx': 'loadscan-admin carries a LOAD-SCAN token and forwards the header to another origin',
};

test('EVERY CALL TO OUR OWN FUNCTIONS GOES THROUGH apiFetch', () => {
  // One place a token gets onto a request, or seventy chances to forget one — and a
  // forgotten one does not fail loudly, it 401s on one screen on one morning.
  const raw = /(?<![A-Za-z0-9_$.])fetch\(/g;
  const offenders = [];
  for (const { rel, text } of FILES) {
    if (RAW_FETCH_ALLOWED[rel]) continue;
    for (const m of text.matchAll(raw)) {
      const arg = text.slice(m.index + m[0].length, m.index + m[0].length + 80);
      if (/\/\.netlify\/functions\/|['"`]\/api\//.test(arg)) {
        offenders.push(`${rel}: fetch(${arg.split('\n')[0].slice(0, 60)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `these must use apiFetch:\n${offenders.join('\n')}`);
});

test('THE DRIVERS PANEL KEEPS ITS OWN TOKEN AND NEVER GETS OURS', () => {
  // DriversPanel signs in against LOAD-SCAN and sends THAT dispatcher token; loadscan-admin
  // forwards the Authorization header untouched to another site. Attaching a dispatch-map
  // session there would break the panel AND hand a second origin a credential it must not
  // hold. Two independent guards: the call site, and the exclusion list in api.js.
  const drivers = byName('components/DriversPanel.jsx');
  assert.match(drivers, /const res = await fetch\(`\$\{PROXY\}\?\$\{qs\}`/, 'callProxy still uses plain fetch');
  assert.match(drivers, /Authorization: `Bearer \$\{token\}`/, 'and still sends the LOAD-SCAN token');
  assert.ok(!/apiFetch/.test(drivers), 'nothing in this file may reach for apiFetch');
  const api = byName('lib/api.js');
  assert.match(api, /AUTH_HEADER_EXCLUDED = \[[^\]]*'loadscan-admin'/, 'and api.js excludes it by URL as well');
});

test('the endpoints named in the security review are all on apiFetch', () => {
  // A spot-check of the specific call sites the review located, so a partial revert is
  // caught by name rather than only by the structural sweep above.
  const wanted = [
    'nuvizz-write', 'send-sms', 'customer-comms-config', 'customer-comms-test',
    'nuvizz-scan-config', 'nuvizz-manual-scan', 'nuvizz-board-sync', 'history-tombstone',
    'gmail-auth', 'nuvizz-driver-roster', 'routing-draft', 'routing-cleanup', 'uline-forecast',
    'ai-search', 'messaging-roster',
  ];
  for (const name of wanted) {
    const url = `/.netlify/functions/${name}`;
    const lines = FILES.flatMap(({ rel, text }) => text.split('\n')
      .map((line, n) => ({ rel, n: n + 1, line }))
      .filter(({ line }) => line.includes(url)));
    assert.ok(lines.length, `${name} is referenced by the client somewhere`);
    for (const { rel, n, line } of lines) {
      if (!/(?<![A-Za-z0-9_$.])fetch\(/.test(line) && !/apiFetch\(/.test(line)) continue;   // a bare constant or a comment
      assert.ok(/apiFetch\(/.test(line), `${rel}:${n} must call ${name} through apiFetch — ${line.trim().slice(0, 80)}`);
    }
  }
  // Endpoints reached through a named constant carry no literal URL on the fetch line, so
  // they are pinned by the constant instead. Same failure either way: one raw fetch left
  // behind is one endpoint that 401s the morning AUTH_REQUIRED is set.
  for (const c of ['SCAN_CONFIG_URL', 'SCAN_NOW_URL', 'CAPTURE_HEALTH_URL', 'CAPTURE_TOMBSTONE_URL', 'WRITE_FN', 'ENDPOINT']) {
    const bad = new RegExp(`(?<![A-Za-z0-9_$.])fetch\\(\\s*\\\`?\\$?\\{?${c}\\b`);
    for (const { rel, text } of FILES) {
      if (RAW_FETCH_ALLOWED[rel]) continue;
      assert.ok(!bad.test(text), `${rel}: ${c} call site is still on raw fetch`);
    }
  }
  assert.match(byName('lib/nuvizzWrite.js'), /res = await apiFetch\(WRITE_FN/, 'every live NuVizz write goes through one apiFetch door');
  assert.match(byName('lib/ai-search.js'), /resp = await apiFetch\(ENDPOINT/);
});

// ── FAIL LOUD: the ten paths that used to swallow ────────────────────────────

test('EVERY SWALLOWED FIRESTORE PATH NOW REPORTS A DENIAL', () => {
  // The failure: the board looks completely normal at 6am and is quietly missing every
  // receiving hour, closed day, equipment restriction and SMS thread, because a rule
  // refused the read and the handler returned an empty Map. Found when a truck arrives at
  // a dock that shut at 2pm. Each surface is listed by the collection whose absence causes
  // a specific, nameable operational failure.
  const surfaces = [
    'customer_notes',                    // receiving hours, closed days, restrictions
    'sms_messages',                      // the customer's "we're closed today" text
    'routing_customer_drivers',          // the usual-driver line on a stop card
    'bottom_panel_profiles',             // shared grid layouts
    'truck_profiles',                    // equipment
    'dispatch_presence',                 // who else is on the board
    'nuvizz_ops/manifest_check_latest',  // the overnight "this order never reached NuVizz"
    'customer_notes:location_override',  // the moved pin — "a truck sent to the wrong door"
  ];
  for (const s of surfaces) {
    assert.ok(APP.includes(`reportDenied('${s}'`), `App.jsx must report a denied ${s}`);
  }
  // The batched auto-scanner reports from inside the writer, because that is where the
  // error object lives; its caller in App.jsx only ever console.error'd it.
  const writer = byName('lib/customer-notes-writer.ts');
  assert.match(writer, /reportDenied\('customer_notes:auto_scan'/, 'the auto-scanner batch reports a refusal');
  assert.match(writer, /isPermissionDenied\(e\)/, 'and only a REFUSAL, not any failed write');
});

test('the two location-override writes BOTH report — there are two copies of that code', () => {
  // The save/reset pair is duplicated across two components (the map screen and the routing
  // screen). Fixing one and not the other leaves half the app silently losing pin
  // corrections, which is exactly how this class of bug survives a review.
  const saves = APP.split("reportDenied('customer_notes:location_override'").length - 1;
  assert.equal(saves, 4, 'two components × (save + reset) = four reporting sites');
  assert.ok(!/catch \(e\) \{ console\.error\('(save|reset) location override'/.test(APP),
    'no silent copy left behind');
});

test('a denial is reported as a WRITE where a dispatcher believed something saved', () => {
  // "The board is missing X" and "the pin you just dragged did NOT save" are different
  // sentences and the second one goes first. That ordering only works if the write sites
  // actually say 'write'.
  assert.match(APP, /reportDenied\('customer_notes:location_override', e, 'write'\)/);
  assert.match(byName('lib/customer-notes-writer.ts'), /reportDenied\('customer_notes:auto_scan', e, 'write'\)/);
});

// ── THE BARS ─────────────────────────────────────────────────────────────────

test('THE PERMISSION BAR CANNOT BE SCROLLED PAST OR LOST BY CHANGING SCREENS', () => {
  // Same reasoning as UpdateBanner, which already sits there: a board that is not showing
  // you everything is a whole-app condition, not a per-tab one. Inside the tab switch it
  // would vanish the moment somebody opened Routing.
  const shell = APP.slice(APP.indexOf('function Shell()'));
  const banner = shell.indexOf('<PermissionBanner');
  const role = shell.indexOf('<RoleRefusalBar');
  const tabs = shell.indexOf("tab === 'map' ?");
  const header = shell.indexOf('<MobileAppBar');
  assert.ok(banner > 0 && role > 0 && tabs > 0 && header > 0, 'found all four');
  assert.ok(banner < header && role < header, 'both bars render ABOVE both headers');
  assert.ok(banner < tabs && role < tabs, 'and outside the tab switch');
});

test('both bars have their own mobile and desktop view', () => {
  // Chad: "mobile and desktop should be treated as 2 different views." A bar is furniture at
  // the top of a 390px screen — the place a shared layout does the most damage.
  for (const name of ['function PermissionBanner', 'function RoleRefusalBar']) {
    const body = APP.slice(APP.indexOf(name), APP.indexOf(name) + 4000);
    assert.match(body, /if \(isMobile\)/, `${name}: a distinct phone branch`);
    assert.ok(body.includes('── PHONE') && body.includes('── DESKTOP'), `${name}: both views marked out`);
  }
});

test('ONLY THE TOP BAR CARRIES THE NOTCH INSET', () => {
  // Three stacked bars each adding env(safe-area-inset-top) is three notches of dead space
  // above a board that is already telling a dispatcher something is wrong — and it is the
  // exact "pin furniture at a guessed offset" mistake the Map was collision-patched for four
  // times. Shell knows the order and says so; the bars never guess.
  const shell = APP.slice(APP.indexOf('function Shell()'));
  assert.match(shell, /<PermissionBanner[^>]*atTop=\{!updateAvailable\}/s);
  assert.match(shell, /<RoleRefusalBar[^>]*atTop=\{!updateAvailable && !denials\.length\}/s);
  for (const name of ['function PermissionBanner', 'function RoleRefusalBar']) {
    const body = APP.slice(APP.indexOf(name), APP.indexOf(name) + 4000);
    assert.match(body, /style=\{atTop \? \{ paddingTop: 'calc\(0\.5rem \+ env\(safe-area-inset-top\)\)' \} : undefined\}/,
      `${name}: the inset is conditional`);
  }
});

test('A 403 DOES NOT OFFER "sign in again" — THAT IS A LOGIN LOOP', () => {
  // 403 means the ROLE is too low. Signing out and back in changes nothing; telling a
  // viewer to try again teaches them nothing each time round. The role bar says who can
  // actually fix it instead.
  const body = APP.slice(APP.indexOf('function RoleRefusalBar'), APP.indexOf('function UpdateBanner'));
  assert.ok(!/sign in again/i.test(body), 'the role bar must not send anyone back to the login');
  assert.match(body, /not allowed/i);
  assert.match(body, /raise your role|ask Chad/i, 'it names the person who can fix it');
});

// ── THE GATE ─────────────────────────────────────────────────────────────────

test('the login gate is decided before Shell mounts, and knows about all four screens', () => {
  // Shell opens Firestore subscriptions on mount (customer_notes, sms_messages, a presence
  // WRITE), so a gate inside it leaks every one of them before anyone signs in. Pinned in
  // auth-gate.test.mjs too; repeated here because the four new screens all hang off it.
  const app = APP.slice(APP.indexOf('export default function App()'));
  const shell = app.indexOf('<Shell />');
  for (const marker of ["state === 'login'", "state === 'must-change'", "state === 'reset'", "state === 'loading'"]) {
    const at = app.indexOf(marker);
    assert.ok(at > 0, `App() handles ${marker}`);
    assert.ok(at < shell, `${marker} is decided BEFORE Shell mounts`);
  }
});

test('A FIRESTORE HICCUP ON BOOT MUST NOT LOCK A DISPATCHER OUT', () => {
  // auth-me answers 503 when the user store is unreachable, and 0/5xx when the platform is
  // having a morning. Clearing the session on any of those would put a dispatcher on a login
  // screen at 6am for a reason that has nothing to do with them — while the server re-verifies
  // the token on EVERY call anyway, so keeping it costs nothing. Only a 401 (this token is
  // dead) signs anyone out. The two mistakes are not symmetrical and the threshold sits here.
  const app = APP.slice(APP.indexOf('export default function App()'));
  const boot = app.slice(app.indexOf('const me = await fetchMe()'), app.indexOf('setSessionReady(true);', app.indexOf('const me = await fetchMe()')));
  assert.match(boot, /me\.status === 401[\s\S]*?clearSession\(\)/, 'a 401 clears the session');
  const clears = boot.split('clearSession()').length - 1;
  assert.equal(clears, 1, 'and NOTHING else on this path does');
  assert.match(boot, /keeping it/i, 'a non-401 failure keeps the session and says so');
});

test('THE SERVER’S COPY OF THE ROLE WINS OVER THE BROWSER’S', () => {
  // A demotion that happened while this tab was closed would otherwise keep showing controls
  // that can only ever answer 403 — and "the button did nothing" is the complaint this whole
  // stream exists to end.
  const app = APP.slice(APP.indexOf('export default function App()'));
  assert.match(app, /setSession\(\{ \.\.\.held, user: \{ \.\.\.held\.user, \.\.\.me\.user/,
    'the fresh server user is merged over the cached one');
  assert.match(app, /mustChangePassword: held\.user\.mustChangePassword/,
    'and the one field the Principal does not carry is preserved, not dropped to false');
});

test('THE RETIRED FIREBASE LOGIN IS NOT WIRED TO ANY SCREEN', () => {
  // Signing in through Firebase gives you an ID token that requireUser() rejects — a screen
  // that says you are in and a board that behaves as if you are not. Worse, in the shape
  // this replaced, the login screen signed into the SERVER while the gate waited on a
  // FIREBASE user, so a correct password left you on the login screen forever.
  assert.ok(!/observeAuth/.test(APP), 'App no longer subscribes to Firebase auth state');
  assert.ok(!/signInWithPassword|signInWithGoogle/.test(APP));
  const login = byName('components/LoginScreen.jsx');
  assert.ok(!/lib\/auth\.js/.test(login), 'and the login screen does not reach for the retired module');
  assert.match(login, /from '\.\.\/lib\/auth-client\.js'/, 'it signs in against app_users');
});

test('the app says which flag turned the login on', () => {
  // A switch whose position cannot be read is not a switch — and "I set VITE_AUTH_ENABLED
  // and got a different login than I expected" must be answerable from the console.
  assert.match(APP, /resolveGateMode\(\{ serverLogin: serverLoginEnabled\(\), firebaseLogin: authEnabled\(\) \}\)/);
  assert.match(APP, /GATE\.bothFlags/);
  assert.match(APP, /GATE\.legacyFlagOnly/);
  assert.match(APP, /console\.warn\('\[auth\][^']*BOTH set/);
  assert.match(APP, /console\.warn\('\[auth\][^']*RETIRED/);
});

test('A DEACTIVATED DISPATCHER LOSES THE DATABASE, NOT JUST THE SCREEN', () => {
  // THE TWO DOORS REVOKE AT DIFFERENT SPEEDS AND ONLY ONE OF THEM WAS WIRED.
  // require-user.mts re-reads app_users behind a 30s cache, so deactivating someone kills
  // their FUNCTION calls almost at once. Firestore has no such check: signInWithCustomToken
  // hands the browser a Firebase session that refreshes itself from Firebase's OWN storage
  // for as long as the tab lives, and clearSession() cannot touch it. So the account
  // Chad turned off at 09:00 got the login screen immediately and kept full read/write on
  // customer_notes and sms_messages from a console tab until they closed the browser.
  //
  // lib/auth-firebase.mts documents this as "(1) IMPLEMENTED". It was implemented as an
  // exported helper with no caller — an intent reported as an outcome. These two call sites
  // are the outcome; deleting either one restores the hole silently, which is why this is
  // pinned at the source rather than left to a unit test of a function nobody invokes.
  const app = APP.slice(APP.indexOf('export default function App()'));

  // Path 1 — a 401 from ANY gated function, mid-morning, via apiFetch → onAuthEvent.
  const onExpired = app.slice(app.indexOf('onAuthEvent((e) => {'));
  assert.match(onExpired.slice(0, 900), /e\.kind !== 'expired'[\s\S]*?dropFirebaseSession\(\)/,
    "the 'expired' handler drops the Firebase session");

  // Path 2 — the same account opening the board cold the next morning. This one does NOT
  // go through emitAuthEvent (it calls clearSession directly), so it needs its own wire.
  const boot = app.slice(app.indexOf('const me = await fetchMe()'), app.indexOf('setSessionReady(true);', app.indexOf('const me = await fetchMe()')));
  assert.match(boot, /me\.status === 401[\s\S]*?dropFirebaseSession\(\)/,
    'the boot 401 drops it too — clearSession() alone leaves Firestore open');

  // And it must be the real thing, not a local no-op that looks like one.
  assert.match(APP, /import \{[^}]*dropFirebaseSession[^}]*\} from '\.\/lib\/auth-client\.js'/);
  const client = byName('lib/auth-client.js');
  assert.match(client, /export async function dropFirebaseSession\(\)[\s\S]{0,240}?signOut\(fb\.auth\)/,
    'dropFirebaseSession actually calls Firebase signOut');
});

test('A 403 DOES NOT DROP THE FIREBASE SESSION EITHER', () => {
  // The mirror of the login-loop rule above, one layer down. A viewer who presses a
  // dispatcher's button gets 403 'requires dispatcher' — their session is perfectly valid.
  // Dropping Firestore access there would blank the board (seven of the ten read paths
  // swallow permission-denied) for someone who did nothing but click the wrong thing.
  const app = APP.slice(APP.indexOf('export default function App()'));
  const forbidden = app.slice(app.indexOf("if (e.kind === 'forbidden')"), app.indexOf("if (e.kind === 'forbidden')") + 200);
  assert.ok(!/dropFirebaseSession/.test(forbidden), 'the forbidden handler leaves Firebase alone');
});
