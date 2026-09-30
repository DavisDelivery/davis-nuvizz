// test/performance-screen-wiring.test.mjs — More → Performance is WIRED: both navigations, the router,
// the lazy load, both views and every layout guard — and it reads nothing but its own two endpoints,
// neither of which reaches NuVizz.
//
// Chad, 2026-09-30: "I wanted to build a stock performance UI under the more tab in the dispatch map."
// A screen in one navigation and not the other does not exist on a phone (CLAUDE.md, "Two views,
// always"); it has shipped that way twice, which is why this is a test and not a paragraph.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { performanceAnswer, performanceToday } from '../scripts/lib/performance-fixture.mjs';
import { presetRange, previousRange, chooseBaseline, baselineBands, paceNow, weekdayOf } from '../src/lib/stop-pace.js';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const CODE = APP.slice(APP.indexOf('\n];\n', APP.indexOf('const VERSION_LOG = [')));
const DIR = new URL('../src/performance/', import.meta.url);
const FILES = Object.fromEntries(readdirSync(DIR).map((f) => [f, readFileSync(new URL(f, DIR), 'utf8')]));
const script = (f) => readFileSync(new URL(`../scripts/${f}`, import.meta.url), 'utf8');

test('BOTH navigations list it, the phone menu can reach it, and the router renders it — lazily', () => {
  assert.match(CODE, /\{ id: 'performance', label: 'Performance', hint: '[^']+', icon: <TrendingUp size=\{14\} \/> \}/, 'desktop More menu');
  assert.match(CODE, /onClick=\{\(\) => onSelectMenu\('performance'\)\}[\s\S]{0,80}<TrendingUp size=\{12\} \/> Performance/, 'phone menu');
  assert.match(CODE, /const KNOWN = \[[^\]]*'performance'[^\]]*\]/, 'a name the phone menu does not know lands on the Map');
  assert.match(CODE, /tab === 'performance' \? <React\.Suspense fallback=\{[^}]*\}><PerformanceScreen isMobile=\{isMobile\} canBuild=\{accountsOpen\} \/><\/React\.Suspense>/);
  assert.match(
    APP,
    /const PerformanceScreen = React\.lazy\(\(\) => import\('\.\/performance\/PerformanceScreen\.jsx'\)\.catch\(\(err\) => tabLoadFailed\('Performance', err\)\)\);/,
    'its own file, fetched on the tap — and a failed fetch is a line on the tab, never a white page',
  );
});

test('TWO VIEWS: the screen picks the phone or the desktop view, each its own file, each with the guards’ heading', () => {
  assert.match(FILES['PerformanceScreen.jsx'], /return isMobile \? <PerformancePhone vm=\{vm\} act=\{actions\} \/> : <PerformanceDesktop vm=\{vm\} act=\{actions\} \/>;/);
  for (const f of ['PerformancePhone.jsx', 'PerformanceDesktop.jsx']) {
    assert.match(FILES[f], /<h1 className="[^"]*">Stop performance<\/h1>/, `${f}: the heading every layout guard proves arrival by`);
  }
});

test('ZERO NuVizz: the screen reads its own two endpoints and imports nothing that could reach further', () => {
  const urls = new Set();
  for (const src of Object.values(FILES)) for (const m of src.matchAll(/\/\.netlify\/functions\/([a-z0-9-]+)/g)) urls.add(m[1]);
  assert.deepEqual([...urls].sort(), ['stop-pace-rebuild', 'stop-performance']);
  for (const [f, src] of Object.entries(FILES)) {
    assert.doesNotMatch(src, /from '[^']*(nuvizz|firebase|firestore)[^']*'/i, `${f} must not import a NuVizz or Firestore client`);
    assert.doesNotMatch(src, /\bfetch\(/, `${f} reads through apiFetch only`);
  }
});

test('every layout guard measures it, over the BUILT fixture, with the states that need a tap probed', () => {
  assert.match(readFileSync(new URL('../scripts/lib/performance-fixture.mjs', import.meta.url), 'utf8'), /buildPaceDigest\(/, 'built by the real digest, not typed');
  const want = {
    'verify-mobile-layout.mjs': "{ key: 'performance', label: 'Performance', nav: /^\\s*performance\\s*$/i, inMore: true, arrive: 'Stop performance' }",
    'verify-tablet-layout.mjs': "{ key: 'performance', label: 'Performance', nav: /^performance/i, inMore: true, arrive: 'Stop performance' }",
    'verify-desktop-layout.mjs': "{ key: 'performance', label: 'Stop performance', nav: /^performance/i, inMore: true, lazy: true }",
  };
  for (const [f, entry] of Object.entries(want)) {
    const src = script(f);
    assert.ok(src.includes(entry), `${f} must measure the screen`);
    assert.ok(src.includes("import { performanceAnswer } from './lib/performance-fixture.mjs';"), `${f} must stub it with the built fixture`);
  }
  for (const f of ['verify-mobile-layout.mjs', 'verify-tablet-layout.mjs']) {
    for (const probe of ['date range open', 'filters open', 'two days ticked (drawn over today, bulk actions)']) {
      assert.ok(script(f).includes(`name: '${probe}'`), `${f} must probe "${probe}"`);
    }
  }
});

test('the fixture puts every guard in front of a JUDGED day, days to build and a weekday never captured — whatever day CI runs', () => {
  const ET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  // A Wednesday afternoon, a Saturday, a Saturday night that is still Friday in Atlanta, and a
  // Monday in January — the guard's clock is whatever CI's is.
  for (const iso of ['2026-09-30T19:00:00Z', '2026-10-03T16:00:00Z', '2026-10-03T02:30:00Z', '2026-01-05T15:00:00Z']) {
    const now = new Date(iso);
    const clientToday = ET.format(now);                       // what the screen computes (etToday)
    const today = performanceToday(now);                      // what the fixture answers for
    assert.ok(weekdayOf(today) <= 5, `${iso}: the live day is a weekday`);
    const range = presetRange('30d', clientToday);
    const prev = previousRange(range.from, range.to);
    const a = performanceAnswer(`/.netlify/functions/stop-performance?from=${prev.from}&to=${range.to}&pool=40`, now);
    assert.equal(a.ok, true);
    assert.equal(a.nuvizzCalls, 0);
    const base = chooseBaseline(a.pool, { today: a.today, weekday: weekdayOf(a.today), mode: 'weekday' });
    const pace = paceNow(a.live, baselineBands(base.days), { asOfMinute: a.live.asOf.minute, nowMinute: a.now.minute });
    assert.ok(['ahead', 'on-pace', 'behind'].includes(pace.status), `${iso}: judged, not "${pace.status}"`);
    const inRange = (d) => d >= range.from && d <= range.to;
    assert.equal(a.coverage.missing.filter(inRange).length, 2, `${iso}: two days to build, in the range on screen`);
    assert.equal(a.coverage.uncaptured.filter(inRange).length, 1, `${iso}: one weekday never captured, in the range on screen`);
    assert.ok(a.days.some((d) => d.source === 'live' && inRange(d.date)), `${iso}: today is on the trend`);
    const detail = performanceAnswer(`/.netlify/functions/stop-performance?detailOnly=1&day=${a.today}`, now).detail;
    assert.ok(detail.routes.some((r) => r.route.length > 30) && detail.routes.some((r) => !r.driver), 'a route name that wraps and a load with no driver');
  }
});
