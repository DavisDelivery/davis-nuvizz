import fs from 'fs';
import { MARK, CHEV, wrap, ITEMS, row } from './build.mjs';
const list = (mark) => ITEMS.map((r) => row(r, mark && r[0] === 'HYDRAULIC STACKER')).join('');

// Measured by laying each row out in a content box of exactly N px and counting line
// boxes. Numbers below are that measurement, not arithmetic on the class names.
const TABLE = `
<table class="tbl">
  <thead><tr><th>content width</th><th>where it comes from</th><th>“HYDRAULIC STACKER” + chip</th><th>longest name + chip</th></tr></thead>
  <tbody>
    <tr><td><b>328px</b></td><td>360px phone − <span class="mono">px-4</span></td><td class="ok">1 line</td><td class="wrap">2 lines — wraps</td></tr>
    <tr><td><b>347px</b></td><td><span class="mono">w-[380px]</span> − <span class="mono">border-l</span> − <span class="mono">px-4</span></td><td class="ok">1 line</td><td class="ok">1 line</td></tr>
    <tr><td><b>358px</b></td><td>390px phone − <span class="mono">px-4</span></td><td class="ok">1 line</td><td class="ok">1 line</td></tr>
  </tbody>
</table>`;

const CORRECTION = `
<div class="card" style="background:#fffbeb;border-color:#fde68a">
  <h3 style="color:#92400e">Correction to my first pass</h3>
  <p class="note">I first reported that the chip “wraps at every real width, desktop included”. <b style="color:#1c1917">That was wrong.</b> The mocks I measured it in applied padding inside a box already set to the content width, so every row rendered 32px narrower than labelled. Re-measured at the true widths, the chip fits everywhere except the longest product name at 328px.</p>
  <p class="note" style="margin-top:9px">It changes the argument: the chip placement is <i>viable</i>. The reason to prefer the line below is no longer “the other one breaks”.</p>
</div>`;

/* ══════════════ 3 · PHONE ══════════════ */
fs.writeFileSync('Phone.dc.html', wrap(`
<div class="pad">
  <div class="kicker">Mobile · the stop sheet</div>
  <h2>The narrowest real case is a 360px phone — 328px of row</h2>
  <p class="note" style="margin-bottom:18px">The mobile sheet is <span class="mono">absolute inset-0</span>, so the row width is the viewport less the card's <span class="mono">px-4</span>. 360px is the width CI already tests.</p>
  ${TABLE}
  <div class="rule"></div>

  <div style="display:flex;gap:26px;align-items:flex-start;flex-wrap:wrap">
    <div style="width:328px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:9px"><span class="tag chk">chip after the name</span></div>
      <div class="app"><div class="bar">328px rows</div><div class="rows" style="width:328px">
        <div class="li"><div class="lr"><span class="nm">HYDRAULIC STACKER<span class="chip">HEAVY</span></span><span class="qt">1 UNT · 1259 Lbs</span></div><div class="sku">190235-07 , SEQ# 3</div></div>
        <div class="li"><div class="lr"><span class="nm">PALLET STRETCH WRAP 15PCF<span class="chip">HEAVY</span></span><span class="qt">1 CTN · 31 Lbs</span></div><div class="sku">156830-08 , SEQ# 6</div></div>
      </div></div>
      <p class="note" style="margin-top:9px">The stacker fits. The second row is the stop's <b style="color:#1c1917">longest name</b>, shown to stress the layout — under the ≥500&nbsp;lb/piece rule a 31&nbsp;lb carton would never carry this chip, so the wrap is a stress result, not a real screen.</p>
    </div>
    <div style="width:328px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:9px"><span class="tag yes">recommended</span><span class="note" style="font-size:11.5px">its own line</span></div>
      <div class="app"><div class="bar">328px rows</div><div class="rows" style="width:328px">${list(true)}</div></div>
      <p class="note" style="margin-top:9px">Immune to long names, and it carries <b style="color:#1c1917">the number and the reason</b> rather than one word. The number is the message — a chip reading HEAVY says less than the row's own “1259 Lbs” already does.</p>
    </div>
    <div style="width:330px">${CORRECTION}</div>
  </div>
</div>`));

/* ══════════════ 4 · DESKTOP ══════════════ */
fs.writeFileSync('Desktop.dc.html', wrap(`
<div class="pad">
  <div class="kicker">Desktop · the right sidebar</div>
  <h2>Desktop sits between the two phones</h2>
  <p class="note" style="margin-bottom:20px"><span class="mono">w-[380px]</span> with <span class="mono">border-l</span> and <span class="mono">px-4</span> leaves <b>347px</b> — narrower than a 390px phone's 358px, wider than a 360px phone's 328px. So the phone is still the constraint, and the same treatment clears all three.</p>
  <div style="display:flex;gap:26px;align-items:flex-start;flex-wrap:wrap">
    <div style="width:347px">
      <div class="app"><div class="bar" style="display:flex;justify-content:space-between"><span>PRO 007173855</span><span>MANDI · stop 7</span></div>
      <div style="padding:10px 0;width:347px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding-bottom:6px;border-bottom:1px solid #f1f5f9">
          <span><span class="cap">Items (7)</span><span class="sum" style="display:block">4 pallets · 4 pieces · 1765 Lbs</span></span>${CHEV}
        </div>
        <div style="padding-top:7px">${list(true)}</div>
      </div></div>
    </div>
    <div style="max-width:420px">
      <div class="card"><h3>What the dispatcher does with it</h3><p class="note">Picks a truck that can get 1,259&nbsp;lb off — a dock-height trailer, or a gate rated for it — and tells the loader to put it last on. Both happen before the truck leaves, which is why the mark has to be visible <b style="color:#1c1917">without expanding the list</b>.</p></div>
      <div class="card" style="margin-top:16px"><h3>Honest limit — it does not pick the truck</h3><p class="note">I checked rather than assumed: with no site restrictions, <span class="mono">truckCanCarry</span> returns ok for both the 26ft box and the 53ft trailer, and 1,259&nbsp;lb is 12.6% of the box's 10,000&nbsp;lb rating. The solver gates on skids and total weight only — nothing per-line.</p><p class="note" style="margin-top:9px">So this informs a <b style="color:#1c1917">person's</b> choice; it does not change the router's. Truck selection is already owned by the site-level icons, and the two cards above are not in conflict — one is the dispatcher, the other is the solver.</p></div>
    </div>
  </div>
</div>`));
console.log('Phone + Desktop');
