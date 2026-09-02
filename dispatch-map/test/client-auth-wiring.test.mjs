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

test('THE WRITE HALVES OF THOSE SURFACES REPORT TOO — the reads were only half the sweep', () => {
  // The first pass wired every swallowing READ and left four WRITES behind, each of which
  // fails in the more dangerous direction: the row is already in state, so a refusal looks
  // exactly like a success until somebody opens the app on another device.
  //   bottom_panel_profiles save   — a SHARED grid layout saved to nobody
  //   bottom_panel_profiles delete — a profile that comes back on the next reload
  //   truck_profiles seed          — see the test below, it was worse than silent
  //   dispatch_presence heartbeat  — this device invisible to the rest of the floor while
  //                                  the chip says the board is quiet
  const wanted = [
    "reportDenied('bottom_panel_profiles', e, 'write')",
    "reportDenied('truck_profiles', e, 'write')",
    "reportDenied('dispatch_presence:heartbeat', e, 'write')",
  ];
  for (const w of wanted) assert.ok(APP.includes(w), `App.jsx must report: ${w}`);
  // TWO profile writes, not one — save and delete are separate call sites and fixing one is
  // exactly how half of this class of bug survives a review (see the location-override pair).
  assert.equal(APP.split("reportDenied('bottom_panel_profiles', e, 'write')").length - 1, 2,
    'both the save AND the delete report');
  // And the comments that stood in for the reporting are gone, so a revert is visible.
  assert.ok(!/catch \{ \/\* optimistic row stands \*\/ \}/.test(APP), 'no silent profile save left');
  assert.ok(!/catch \{ \/\* optimistic removal stands \*\/ \}/.test(APP), 'no silent profile delete left');
  assert.ok(!/\}, \{ merge: true \}\)\.catch\(\(\) => \{ \/\* best-effort \*\/ \}\)/.test(APP), 'no silent presence beat left');
  // The heartbeat gets its OWN label: under the banner's write sentence ("not allowed to
  // edit …") the read label would come out as "not allowed to edit who else is working the
  // board", which is the wrong fact about the wrong device.
  assert.match(byName('lib/permission-denied.js'), /'dispatch_presence:heartbeat':/,
    'and the write half has words that are true when the banner says them');
});

test('A DENIED TRUCK SEED MUST NOT LEAVE THE PICKER LOADING FOREVER', () => {
  // TWO BUGS ON ONE LINE, and the second was the expensive one. The seed's catch swallowed a
  // refusal (bug 1) AND the branch returns without setReady(true) — correct when the seed
  // WORKED, because the snapshot re-fires and sets it, and a permanent "loading…" in the
  // Routing truck picker when it did not, because no re-fire is coming. A picker that never
  // finishes loading is indistinguishable from a slow one, so nobody reports it; they just
  // cannot pick a truck. setReady(true) is unconditional in the catch on purpose: an offline
  // seed leaves the collection empty too, and finishing empty beats hanging.
  const hook = APP.slice(APP.indexOf('function useTruckProfiles'), APP.indexOf('function useTruckProfiles') + 1800);
  assert.match(hook, /catch \(e\) \{ reportDenied\('truck_profiles', e, 'write'\); setReady\(true\); \}/,
    'the seed reports the refusal AND finishes loading');
  assert.ok(!/catch \{ \/\* ignore \*\/ \}/.test(hook), 'the swallowing catch is gone');
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
  assert.match(shell, /<LegacyLoginFlagBar[^>]*atTop=\{!updateAvailable && !denials\.length && !roleRefusal\}/s);
  for (const name of ['function PermissionBanner', 'function RoleRefusalBar', 'function LegacyLoginFlagBar']) {
    const body = APP.slice(APP.indexOf(name), APP.indexOf(name) + 4000);
    assert.match(body, /style=\{atTop \? \{ paddingTop: 'calc\(0\.5rem \+ env\(safe-area-inset-top\)\)' \} : undefined\}/,
      `${name}: the inset is conditional`);
  }
});

test('AND THE APP BAR — the one this test is named after and never checked', () => {
  // THE BUG THIS TEST NAMED AND DID NOT CATCH. MobileAppBar applied the inset
  // UNCONDITIONALLY and took no atTop prop at all, while the two bars above it correctly
  // gated theirs and render ABOVE it. On a notched iPhone with a permission bar showing, the
  // inset was therefore applied TWICE — ~47px of dead space pushing the board down on the
  // exact morning something is already wrong. The test passed the whole time because it only
  // asserted the two NEW bars, which is how a guard ends up guarding nothing.
  const shell = APP.slice(APP.indexOf('function Shell()'));

  // Shell owns the order, so Shell computes "is anything above the header?" — once, and
  // spelled out, rather than each bar guessing where it sits.
  assert.match(shell, /const headerAtTop = !updateAvailable && !denials\.length && !roleRefusal && !LEGACY_FLAG_ONLY;/,
    'the header is last in the stack and says so');
  assert.match(shell, /<MobileAppBar[\s\S]{0,400}?atTop=\{headerAtTop\}/, 'the PHONE header is handed it');
  assert.match(shell, /<header className="shrink-0 relative z-30[^>]*style=\{headerAtTop \? \{ paddingTop: 'env\(safe-area-inset-top\)' \} : undefined\}/,
    'and so is the DESKTOP one — an iPad in standalone mode has a top inset too');

  // Both halves must be conditional together. Keeping the minHeight but dropping the padding
  // would leave the row 47px taller than it needs to be and look like nothing was fixed.
  const bar = APP.slice(APP.indexOf('function MobileAppBar'), APP.indexOf('function MobileAppBar') + 3000);
  assert.match(bar, /function MobileAppBar\(\{[^}]*atTop = true/, 'it takes the prop, defaulting to today’s behaviour');
  assert.match(bar, /\.\.\.\(atTop\s*\?\s*\{ minHeight: 'calc\(48px \+ env\(safe-area-inset-top\)\)', paddingTop: 'env\(safe-area-inset-top\)' \}\s*:\s*\{ minHeight: '48px' \}\)/,
    'the inset comes out of BOTH the padding and the minHeight, or the row keeps space it no longer needs');
  assert.ok(!/^\s*paddingTop: 'env\(safe-area-inset-top\)',$/m.test(bar),
    'and no unconditional copy is left behind');
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

// ── THE FLAGS: WHAT EACH ONE ACTUALLY DOES ───────────────────────────────────

test('THE RETIRED FLAG RENDERS THE BOARD AND A WARNING, NEVER A LOGIN NOBODY CAN PASS', () => {
  // THE LOCKOUT. VITE_AUTH_ENABLED was written for a FIREBASE account list; the app_users
  // accounts are a different set, created one at a time by auth-bootstrap → auth-admin.
  // Honouring the old flag on a site where they do not exist yet puts a password box in front
  // of the whole dispatch floor at 6am that nobody on earth has a password for — and it is a
  // BUILD-time flag, so the only cure is a redeploy. firestore.rules settles this class of
  // call in Chad's own words: "being open one day longer costs an exposure that has already
  // existed for months; being closed one hour early costs a refused delivery nobody can
  // explain." The gate is reserved for VITE_LOGIN_ENABLED, whose accounts exist.
  //
  // BUT SILENCE WOULD BE ITS OWN LIE — a security control somebody believes they switched on
  // and did not is worse than one they know is off. So: the app, plus a bar that says it.
  assert.match(APP, /const LEGACY_FLAG_ONLY = GATE\.legacyFlagOnly;/,
    'the app holds the fact so a screen can show it');
  const bar = APP.slice(APP.indexOf('function LegacyLoginFlagBar'), APP.indexOf('function LegacyLoginFlagBar') + 4000);
  assert.match(bar, /if \(!LEGACY_FLAG_ONLY\) return null;/, 'and shows nothing in every other configuration');
  assert.match(bar, /VITE_LOGIN_ENABLED/, 'it names the flag to set instead');
  assert.match(bar, /NOT<\/span> switched on|NOT<\/b> switched on/, 'and says the login is NOT on');
  assert.match(bar, /if \(isMobile\)/, 'a distinct phone branch');
  assert.ok(bar.includes('── PHONE') && bar.includes('── DESKTOP'), 'both views marked out');
  // The bar is furniture at the top of the app, not a per-tab thing — same reasoning as the
  // other two, and it must not be reachable only from the Map.
  const shell = APP.slice(APP.indexOf('function Shell()'));
  assert.ok(shell.indexOf('<LegacyLoginFlagBar') > 0 && shell.indexOf('<LegacyLoginFlagBar') < shell.indexOf("tab === 'map' ?"),
    'rendered outside the tab switch');
});

test('AUTH_REQUIRED WITHOUT A LOGIN IN THIS BUILD IS SAID, NOT RENDERED AS A DEAD BOARD', () => {
  // THE TRAP THE OTHER HALF OF THIS FIX CLOSES. AUTH_REQUIRED is a RUNTIME switch on the
  // functions; VITE_LOGIN_ENABLED is BUILD-time, baked into this bundle. Flip the first
  // without the second and every gated function answers 401 while gateState() still returns
  // 'app': a board that renders fully, paints its pins and answers nothing, with no login
  // offered anywhere on it. The signal that catches it was already being fetched and thrown
  // away — auth-me returns authRequired, and puts it on its 401 body precisely so a client
  // with no session can read it.
  const app = APP.slice(APP.indexOf('export default function App()'));
  assert.match(app, /noteServerAuthFacts/, 'the two site-level facts are consumed, not discarded');
  assert.match(app, /facts\.authRequired === true && !serverMode\) setServerEnforcing\(true\)/,
    'enforcing + no login in this build is the condition');
  assert.match(app, /if \(serverEnforcing\) \{[\s\S]{0,200}?<SignInRequiredScreen/,
    'and it puts a sentence on screen instead of the board');

  // ORDER MATTERS: it must never take a screen away from somebody who has a way through —
  // an emailed reset link, or a login screen this build actually has.
  const enforcing = app.indexOf('if (serverEnforcing)');
  for (const earlier of ["if (state === 'reset')", "if (state === 'login')"]) {
    assert.ok(app.indexOf(earlier) > 0 && app.indexOf(earlier) < enforcing, `${earlier} is decided first`);
  }
  assert.ok(enforcing < app.indexOf('<Shell />'), 'and it is decided before the board mounts');

  // ONLY EVER SETS THE FLAG TRUE. A later 502 with no body must not quietly take the sentence
  // back off the screen — "absent" is not "the server stopped enforcing".
  assert.ok(!/setServerEnforcing\(false\)/.test(app), 'nothing clears it on a bodyless failure');

  // And the screen is two views, like every other screen in this app.
  const screen = APP.slice(APP.indexOf('function SignInRequiredScreen'), APP.indexOf('function SignInRequiredScreen') + 5000);
  assert.match(screen, /if \(isMobile\)/, 'a distinct phone branch');
  assert.ok(screen.includes('── PHONE') && screen.includes('── DESKTOP'), 'both views marked out');
  assert.match(screen, /VITE_LOGIN_ENABLED/, 'it names the flag to set');
  assert.match(screen, /AUTH_REQUIRED/, 'and the one to turn back off, which is the instant rollback');
});

test('A LOGIN SCREEN NOBODY CAN PASS SAYS SO BEFORE THE FOURTH ATTEMPT', () => {
  // AUTH_SESSION_SECRET is not set on the production site today. With the login flag on and
  // that secret missing, auth-login answers 401 'sign-in not configured' to every correct
  // password there is. Three people trying their password four times each and concluding they
  // are locked out is the failure; auth-me hands us `configured` for exactly this.
  const app = APP.slice(APP.indexOf('export default function App()'));
  assert.match(app, /facts\.configured === false && serverMode\) setSignInUnconfigured\(true\)/);
  assert.match(app, /signInUnconfigured[\s\S]{0,300}?AUTH_SESSION_SECRET/,
    'and the login screen says which switch is missing');
});

test('THE PREFLIGHT ASKS ON THE BOOTS THE SESSION CHECK SKIPS, AND NEVER BLOCKS THE BOARD', () => {
  // The existing boot check only runs with LOGIN_MODE 'server' AND a stored session — which
  // is neither of the two states this trap lives in (no login in this build at all; or a login
  // and nobody signed in). Nothing awaits the preflight, so a slow or dead auth-me costs the
  // boot nothing: the board renders first and the sentence arrives if it is warranted.
  const app = APP.slice(APP.indexOf('export default function App()'));
  const pre = app.slice(app.indexOf('if (serverMode && getSession()) return undefined;'));
  assert.ok(pre.length, 'the preflight skips the boots the session check already covers');
  assert.match(pre.slice(0, 500), /const facts = await fetchMe\(\);[\s\S]{0,120}?noteServerAuthFacts\(facts\)/);
  assert.ok(!/setSessionReady/.test(pre.slice(0, 500)), 'and it never holds the board back');
});

// ── SAYING NO BEFORE THE PRESS ───────────────────────────────────────────────

test('THE ROLE HELPERS ARE ACTUALLY CALLED — they were exported and never used', () => {
  // roleAtLeast / isStaff / roleOf shipped with the role system and NOTHING on any screen
  // called them. Walked as a viewer, every dispatcher action failed in one of three different
  // presentations (amber role bar / red permission banner / silence) with nothing said in
  // advance. This is the wire that ends that.
  assert.match(APP, /roleGateReason/, 'App reaches for the rule');
  assert.match(APP, /function useRoleGate\(need = 'dispatcher'\)/, 'through one hook, not scattered checks');
  // THE LOCKOUT GUARD, PINNED. With no login up the server hands every caller the legacy
  // admin principal, so the screen must never grey anything out — deleting this line would
  // disable the entire dispatch board on production, which has no accounts at all.
  assert.match(APP, /roleGateReason\(user, need, \{ gated: LOGIN_MODE === 'server' \}\)/,
    'and the gate is OPEN whenever no login is in charge');
});

test('THE HIGH-TRAFFIC DISPATCHER CONTROLS ARE DISABLED, NOT HIDDEN, WITH THE REASON ON THEM', () => {
  // THE LOGISTICS CALL, AND IT IS NOT SYMMETRICAL. Greying a button out costs a viewer one
  // hover and a sentence naming who can raise their role. Letting them press it costs a
  // person who BELIEVES a scan ran, a plan saved, a load dispatched or a customer got a text
  // — and who acts on that belief for the rest of the morning. Hidden is not the answer
  // either: a control that vanishes teaches nobody what the board can do, and reads as a bug.
  //
  // Each entry is a control whose endpoint requires dispatcher server-side.
  const controls = [
    // Scan now — three buttons, one rule, resolved inside useManualScan.
    ['scan (map, phone + desktop, and the Routing status card)', /disabled=\{scanning \|\| scanCooldown \|\| !!scanDenied\}/g, 3],
    ['scan (Diagnostics: the API-calls panel and the schedule panel)', /disabled=\{scanning \|\| !!scanDenied\} title=\{scanDenied \|\| undefined\}/g, 2],
    // The routing engine — a 12s solve that can only answer 403 is the worst one to walk into.
    ['engine draft', /disabled=\{draftBusy \|\| !draftNames\.trim\(\) \|\| !engineGate\.allowed\}/g, 1],
    ['engine cleanup', /disabled=\{cleanupBusy \|\| !planTargets\.length \|\| !engineGate\.allowed\}/g, 1],
    // The NuVizz writes.
    ['workbench Save (the whole board → NuVizz)', /disabled=\{busy \|\| !!saveGate\.reason\}/g, 1],
    ['assign driver + dispatch load', /!!writeDenied\}/g, 2],
    // customer_notes — the receiving hours the flag engine runs on. TWO save bars: the
    // desktop sidebar and the phone drawer are separate components, and gating one and not
    // the other is how half a fix ships.
    ['notes Save (desktop sidebar + phone drawer)', /disabled=\{saving \|\| !!saveDenied\}/g, 2],
  ];
  for (const [what, re, count] of controls) {
    assert.equal((APP.match(re) || []).length, count, `${what}: expected ${count} gated call site(s)`);
  }
  // The SMS composer lives in its own file and gets the reason as a prop, because the panel
  // floats over every screen and is a child of none of them.
  const msgs = byName('components/MessagesPanel.jsx');
  assert.match(msgs, /disabled=\{!draft\.trim\(\) \|\| sending \|\| !!sendDenied\}/, 'Send is disabled');
  assert.match(msgs, /You can read this thread but not reply/, 'and the thread stays readable');
  assert.match(APP, /<MessagesPanel[^>]*sendDenied=\{smsGate\.reason\}/, 'App supplies the reason');
});

test('AND THE HANDLERS REFUSE TOO — a disabled button is not a lock', () => {
  // Defence in depth, not decoration: a stale render, a keyboard activation, or a call site
  // added later must not fire a request whose only possible answer is a refusal. Every one of
  // these is also the place the sentence gets said if the press arrives some other way.
  assert.match(APP, /if \(!gate\.allowed\) \{ setScanErr\(gate\.reason\)/, 'manual scan');
  assert.match(APP, /if \(!scanGate\.allowed\) return;/, 'the Diagnostics scan');
  assert.match(APP, /if \(!engineGate\.allowed\) \{ setCleanupError\(engineGate\.reason\); return; \}/, 'engine cleanup');
  assert.match(APP, /if \(!engineGate\.allowed\) \{ setDraftError\(engineGate\.reason\); return; \}/, 'engine draft');
  assert.match(APP, /if \(saveGate\.reason\) \{ showToast\(saveGate\.reason\); return; \}/, 'the workbench Save');
  assert.match(APP, /if \(notesGate\.reason\) \{ setSaveError\(notesGate\.reason\); return; \}/, 'the notes Save');
  assert.equal((APP.match(/if \(!writeGate\.allowed\) \{ showMapToast\(writeGate\.reason\); return; \}/g) || []).length, 2,
    'assign AND dispatch');
  assert.match(byName('components/MessagesPanel.jsx'), /if \(!text \|\| !active \|\| sendDenied\) return;/, 'the SMS send');
});

test('BOTH COPIES OF THE NOTES SAVE ARE GATED — there are two, in two components', () => {
  // The Map screen and the Routing screen each carry their OWN customer_notes save
  // (handleSave / saveStopNote) feeding their own pair of panels. Gating one and not the
  // other leaves half the app quietly losing the receiving hours a customer just gave a
  // dispatcher on the phone — the same duplication that made the location-override pair its
  // own test above.
  assert.match(APP, /if \(notesGate\.reason\) \{ setSaveError\(notesGate\.reason\); return; \}/, 'the Map save');
  assert.match(APP, /if \(notesGate\.reason\) \{ setSaveNoteError\(notesGate\.reason\); return; \}/, 'the Routing save');
  assert.equal((APP.match(/const notesGate = useRoleGate\('dispatcher'\);/g) || []).length, 2,
    'one gate per component that owns a notes save');
  // Four panels reach those two saves: Map desktop sidebar, Map phone drawer, and the Routing
  // screen's own desktop and phone panels (which pass it through to the shared sidebar).
  assert.equal((APP.match(/saveDenied=\{notesGate\.reason\}/g) || []).length, 4,
    'every panel that can save is handed the reason');
  assert.match(APP, /function RoutingStopPanel\(\{[^}]*saveDenied = null/, 'and the Routing wrapper forwards it');
});

// ── THE SCAN BUTTON'S 202 ────────────────────────────────────────────────────

test('A REFUSED SCAN MUST NOT READ AS A RUNNING ONE', () => {
  // nuvizz-manual-scan-background is a *-background* function: Netlify answers 202 the instant
  // the request lands and DISCARDS the handler's 401, so resp.ok is true, both fallbacks are
  // skipped, the poll finds nothing changed — and the button said "Scan running — the board
  // will refresh automatically" while nothing ran and nothing ever would. That is the
  // reassurance version of a hardcoded success: a dispatcher who believes a scan is running
  // does not press it again and does not call anyone; they work a stale board until the dock
  // notices. The gate writes nuvizz_ops/scan_refusal and the read endpoint serves it back on
  // the poll the button is already making.
  const hook = APP.slice(APP.indexOf('function useManualScan'), APP.indexOf('function UnplannedScanCount'));
  assert.match(hook, /d\?\.lastScanRefusal/, 'the poll reads the refusal it is already being handed');
  assert.match(hook, /Scan did not run\./, 'and says it did not run rather than that it is running');
  assert.match(hook, /refusal\.message/,
    'quoting the server’s own sentence verbatim — refusalMessage already says what to do, and '
    + 're-wording it here would give one failure two vocabularies');
  assert.match(hook, /refusal\s*\?[\s\S]{0,200}?'Scan running — the board will refresh automatically'/s,
    'the reassurance survives ONLY as the no-refusal branch — a deploy whose read endpoint does not carry the field yet degrades to today’s behaviour');

  // SERVER-COMPUTED AGE, NOT A TIMESTAMP COMPARE. `at` is the server's clock and Date.now()
  // in the browser is not; a phone a few minutes out would either blame this press for an old
  // refusal or miss its own. ageMin is measured end to end on the server.
  assert.match(hook, /scanRefusalIsThisPress\(d\?\.lastScanRefusal\)/, 'freshness decided by one named rule');
  const fresh = APP.slice(APP.indexOf('function scanRefusalIsThisPress'), APP.indexOf('function scanRefusalIsThisPress') + 400);
  assert.match(fresh, /refusal\.ageMin == null\) return false/,
    'ABSENT IS NOT ZERO — Number(null) is 0 and 0 is finite, which is the trap that once shipped '
    + 'a midnight deadline for a stop with no deadline');
  assert.match(fresh, /Number\.isFinite\(age\) && age >= 0 && age <= SCAN_REFUSAL_FRESH_MIN/,
    'skew-proof (a server-computed age), and narrow enough not to inherit the last press’s refusal');
  assert.match(APP, /const SCAN_REFUSAL_FRESH_MIN = 2;/);

  // AND IT ONLY SPEAKS WHEN THE SCAN ALSO FAILED TO LAND. Two dispatchers share this board:
  // a viewer refused at 06:00:10 and a dispatcher pressing at 06:00:40 would otherwise have
  // the second person told their successful scan was refused.
  assert.match(hook, /if \(!updated\) \{[\s\S]{0,600}?setScanErr\(refusal/, 'reported only when nothing was scanned');
  assert.ok(!/if \(refusal\) break;/.test(hook), 'no early break — that is what would mis-blame the second press');
});
