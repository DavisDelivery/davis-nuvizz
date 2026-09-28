// test/tv-live-map-retick.test.mjs
//
// THE WALL'S "LIVE MAP" TICKED ON, OFF, THEN ON AGAIN CAME UP BLANK, SILENTLY (audit 2026-09-27,
// app-A1-6).
//
// On the wall display the live map's <div ref={mapDiv}> exists only while "Live map (sharper
// labels)" is ticked. Unticking unmounts it; re-ticking mounts a fresh div. But the map-init
// effect only re-ran on [google, mapIdKey(...)] — and on the wall none of those move (the
// loader hands back the same `google`, and the wall never uses a mapId). So no map was ever
// built on the new div: an empty slate pane until somebody reloaded the page. The blank-map
// warning did not fire either, because tvMapDrew was still true from the first live session.
//
// What happens now: the init effect also re-runs when the wall switches between picture and
// live map, so a re-ticked live map gets a new Google map on its new div; and leaving the live
// map forgets that it drew, so the blank-map warning is armed again for the next session.
//
// MapScreen is a 3,000-line component, so these read App.jsx (the repo's pattern for
// component-level wiring that cannot be extracted).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const mapScreen = APP.slice(APP.indexOf('const tvStatic = tvMode && TV_STATIC_MAP && !tvLiveMap;'));

test('re-ticking the wall\'s live map builds a new Google map on the new map pane', () => {
  const init = mapScreen.indexOf('mapRef.current = new google.maps.Map(mapDiv.current, {');
  assert.ok(init > 0, 'MapScreen map-init not found');
  const depsLine = mapScreen.slice(init, mapScreen.indexOf('\n', mapScreen.indexOf('}, [google, mapIdKey(mapIdForView', init)));
  assert.match(depsLine, /\}, \[google, mapIdKey\(mapIdForView, mapFilters\.hideLabels\), tvStatic\]\);/,
    'the map-init effect must re-run when the wall flips between picture and live map');
});

test('leaving the wall\'s live map re-arms the blank-map warning for the next time it is ticked', () => {
  assert.match(mapScreen, /useEffect\(\(\) => \{ if \(tvStatic\) setTvMapDrew\(false\); \}, \[tvStatic\]\);/,
    'tvMapDrew must reset when the live map is left, or a second session that draws nothing says nothing');
});
