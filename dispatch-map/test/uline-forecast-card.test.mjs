// test/uline-forecast-card.test.mjs
//
// THE CARD EXISTS ON BOTH VIEWS, READS EVERY LIST DEFENSIVELY, AND PUTS TONIGHT WHERE A PHONE CAN REACH IT.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const SCREEN = (() => { const i = APP.indexOf('function ManifestCheckScreen('); return APP.slice(i, APP.indexOf('\nfunction ', i + 10)); })();
const CARD = APP.slice(APP.indexOf('const arr = (x) =>'), APP.indexOf('function ManifestCheckScreen('));

test('the card is mounted on the Manifest check screen, between the verdict and the archive', () => {
  assert.match(SCREEN, /<UlineForecastCard forecast=\{forecast\} isMobile=\{isMobile\} \/>\s*\n\s*<ManifestHistoryCard \/>/);
  assert.match(SCREEN, /const forecast = useUlineForecast\(60\)/);
});

test('TWO VIEWS: a phone component and a desktop component, chosen by the same breakpoint the rest of the app uses', () => {
  assert.match(CARD, /isMobile \? <ForecastPhone data=\{data\} reload=\{reload\} \/> : <ForecastDesktop data=\{data\} reload=\{reload\} \/>/);
  assert.match(SCREEN, /const isMobile = useViewportWidth\(\) < MOBILE_BREAKPOINT/);
  assert.match(CARD, /^function ForecastPhone\(/m);
  assert.match(CARD, /^function ForecastDesktop\(/m);
});

test('ON THE PHONE tonight\'s line sits under the Gmail card, ABOVE the check result — the result list can be 500 cards long', () => {
  const gmailAt = SCREEN.indexOf('<GmailCard onStoredRun={adoptRun} />');
  const stripAt = SCREEN.indexOf('{isMobile && <ForecastTonightStrip data={forecast.data} />}');
  const resultAt = SCREEN.indexOf('{result && (');
  assert.ok(gmailAt > 0 && stripAt > gmailAt && resultAt > stripAt, 'Gmail card → tonight strip → result');
  // And the desktop keeps it inside the card, once.
  assert.match(CARD, /<ForecastTonightStrip data=\{data\} compact \/>/);
});

test('EVERY LIST IS READ DEFENSIVELY — the layout guard\'s generic stub and a fresh deploy both look like nothing', () => {
  assert.match(CARD, /const arr = \(x\) => \(Array\.isArray\(x\) \? x : \[\]\)/);
  for (const k of ['outlook', 'scored', 'unscored', 'changes', 'pattern', 'holes', 'versions', 'disagreements']) {
    assert.match(CARD, new RegExp(`arr\\(data\\?\\.${k}\\)`), `${k} is read through arr()`);
  }
  assert.match(CARD, /No forecast on file yet — the reader runs hourly/);
  // No raw .map on a response field without the guard.
  const raw = CARD.match(/data\?\.[a-zA-Z]+\.map\(/g) || [];
  assert.deepEqual(raw, [], `raw maps on the response: ${raw.join(', ')}`);
});

test('the phone view is one flow column with thumb-sized taps and no chart, version picker or backfill controls', () => {
  const phone = CARD.slice(CARD.indexOf('function ForecastPhone('), CARD.indexOf('function ForecastDesktop('));
  assert.ok(!/absolute|fixed/.test(phone), 'nothing pinned');
  assert.ok(!/Backfill|Dry run/.test(phone), 'backfill and dry run are desktop only');
  assert.match(phone, /<ForecastRunButton onDone=\{\(\) => reload\?\.\(\)\} \/>/, 'one button: read the mailbox now');
  assert.match(phone, /Plan = Uline’s number until 4 nights per weekday are scored/);
  const buttons = (CARD.match(/minHeight: 44/g) || []).length;
  assert.ok(buttons >= 4, `tap targets are 44px (${buttons})`);
});

test('a POST that fails says so on the screen — never a spinner that resolves to silence', () => {
  assert.match(CARD, /setLine\(r\.ok === false \? `✗ \$\{r\.error \|\| 'failed'\}`/);
  assert.match(CARD, /HTTP \$\{r\.status\} — the function did not answer with JSON/, 'an HTML 502 is named, not parsed as JSON');
  assert.match(CARD, /r\.status === 401 \|\| r\.status === 403/, 'a sign-in refusal is shown as such');
});

test('the desktop backfill button appears only after a preview has been shown this session', () => {
  const desk = CARD.slice(CARD.indexOf('function ForecastDesktop('), CARD.indexOf('function UlineForecastCard('));
  assert.match(desk, /\{previewed && <ForecastRunButton label="Run one backfill batch" body=\{\{ action: 'backfill', confirm: true \}\}/);
  assert.match(desk, /label="Backfill preview" body=\{\{ action: 'backfill', dry: true \}\} onDone=\{\(r\) => \{ if \(r\?\.ok !== false\) setPreviewed\(true\); \}\}/);
});

test('the layout guard measures a POPULATED card, not the empty state', () => {
  const guard = readFileSync(new URL('../scripts/verify-mobile-layout.mjs', import.meta.url), 'utf8');
  const at = guard.indexOf("if (u.includes('uline-forecast'))");
  const generic = guard.indexOf("return R({ ok: true, stops: [], entries: [], items: [], count: 0 });");
  assert.ok(at > 0 && at < generic, 'the stub sits before the generic fallback');
  assert.match(guard.slice(at, generic), /status: 'closed'/, 'with a closed day');
  assert.match(guard.slice(at, generic), /verdict: 'heavy'/, 'and a heavy night');
});

test('no anchor in the card opens our own endpoint in a new tab (the dead-end rule); the xlsx link is a same-window download', () => {
  const anchors = CARD.match(/<a\s[^>]*?>/gs) || [];
  for (const a of anchors) assert.ok(!/target=["']_blank["']/.test(a), a);
  assert.match(CARD, /href=\{`\/\.netlify\/functions\/uline-forecast\?version=\$\{encodeURIComponent\(v\.versionId\)\}&xlsx=1`\} download/);
});

test('THE STRIP DOES NOT GO STALE: re-read when a manifest run lands, when the tab comes back, every 5 minutes while visible — and it says how old it is', () => {
  const hook = CARD.slice(CARD.indexOf('function useUlineForecast('), CARD.indexOf('function describeForecastResult('));
  assert.match(hook, /window\.addEventListener\('dd-manifest-check-updated', load\)/);
  assert.match(hook, /document\.addEventListener\('visibilitychange', onVisible\)/);
  assert.match(hook, /setInterval\(\(\) => \{ if \(document\.visibilityState === 'visible'\) load\(\); \}, FORECAST_REFRESH_MS\)/);
  assert.match(hook, /removeEventListener\('dd-manifest-check-updated', load\)/);
  assert.match(hook, /clearInterval\(timer\)/);
  assert.match(CARD, /const FORECAST_REFRESH_MS = 5 \* 60 \* 1000/);
  assert.match(hook, /fetchedAt: Date\.now\(\)/);
  const strip = CARD.slice(CARD.indexOf('function ForecastTonightStrip('), CARD.indexOf('function ForecastOutlookRow('));
  assert.match(strip, /as of \{asOf\}/);
  // The phone strip lives ABOVE the results, once — not again inside the card.
  const phone = CARD.slice(CARD.indexOf('function ForecastPhone('), CARD.indexOf('function ForecastDesktop('));
  assert.ok(!/<ForecastTonightStrip/.test(phone), 'no second copy on the phone');
});

test('a run or backfill result says what it did — the preview is the gate before a real write, so "✓ ok" is not an answer', () => {
  assert.match(CARD, /setLine\(r\.ok === false \? `✗ \$\{r\.error \|\| 'failed'\}` : `✓ \$\{describeForecastResult\(r\)\}`\)/);
  const src = CARD.slice(CARD.indexOf('function describeForecastResult('), CARD.indexOf('const fmtClock'));
  const describe = new Function(`${src}; return describeForecastResult;`)();   // plain JS, no React in it
  assert.equal(describe({ ok: true, dry: true, window: { start: '2022-06-01', end: '2022-09-01' }, listed: 3, held: null, run: { summary: '3 new forecasts filed', wouldWrite: [1, 2, 3, 4, 5, 6] } }), '2022-06-01 → 2022-09-01 · 3 listed · 3 new forecasts filed · would write 6');
  assert.equal(describe({ ok: true, window: { start: '2022-06-01', end: '2022-09-01' }, listed: 0, held: 'window 2022-06-01–2022-09-01 listed nothing — held for one more look', run: { summary: 'no matching email' } }), '2022-06-01 → 2022-09-01 · 0 listed · no matching email · window 2022-06-01–2022-09-01 listed nothing — held for one more look');
  assert.equal(describe({ ok: true, summary: '1 new forecast filed', listed: 4 }), '1 new forecast filed');
  assert.equal(describe({ ok: true, dry: true, summary: 'nothing new (3 already judged)', wouldWrite: [] }), 'nothing new (3 already judged) · would write 0');
  assert.equal(describe({ ok: true, done: true }), 'done');
  assert.equal(describe({ ok: true }), 'ok');
  assert.equal(describe(null), 'ok');
});

test('a failed read is the error line and nothing else; the note prints once, as the empty state; the file\'s warnings and the no-delivery days are on the Job panel', () => {
  assert.match(CARD, /\{data && data\.ok !== false \? \(isMobile \? <ForecastPhone/);
  const status = CARD.slice(CARD.indexOf('function ForecastStatusLines('), CARD.indexOf('function ForecastRunButton('));
  assert.ok(!/data\??\.note/.test(status), 'the note is not repeated in the status lines');
  assert.match(status, /read with \$\{warns\.length\} warning/);
  assert.match(status, /no deliveries: /);
  assert.match(status, /\$\{h\.dow\} \$\{mdOf\(h\.date\)\}/, 'holes print 8/27, not 08/27, like every other date on the card');
});

test('the nights lists skip the filler — before-archive and pre-forecast days are counted, not listed; the phone tiles say they open', () => {
  assert.match(CARD, /const FILLER_NIGHTS = new Set\(\['before_archive', 'uncovered'\]\)/);
  const phone = CARD.slice(CARD.indexOf('function ForecastPhone('), CARD.indexOf('function ForecastDesktop('));
  assert.match(phone, /const nights = nightsToList\(data\)\.slice\(0, 14\)/);
  assert.match(phone, /by weekday ▾/);
  const desk = CARD.slice(CARD.indexOf('function ForecastDesktop('), CARD.indexOf('function UlineForecastCard('));
  assert.match(desk, /const nights = nightsToList\(data\)/);
  assert.match(desk, /not listed — before the archive began/);
  assert.match(desk, /Nights · \{scored\.length\} scored/);
  assert.match(CARD, /'last 90 days' : 'last 30 days'/, 'the tile names a window, not a count of nights');
});
