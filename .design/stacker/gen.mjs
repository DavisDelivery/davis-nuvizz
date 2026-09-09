import fs from 'fs';
import { H, H_WHITE, YELLOW, INK, wrap, stopCard, rows } from './build.mjs';

/* ══ 1 · MAIN — the mark ══ */
fs.writeFileSync('Main.dc.html', wrap(`
<div class="pad">
  <div class="kicker">Hydraulic stacker · item flag</div>
  <h1>Bright yellow, dark H.</h1>
  <p class="note" style="margin-top:14px;font-size:15px;color:#44403c">Shown on the row when the item text contains <b style="color:#1c1917">“hydraulic stacker”</b>. Nothing derived, no thresholds — the text is the trigger.</p>

  <div class="card" style="margin:26px 0 20px">
    <h3>At the sizes it will actually be used</h3>
    <div style="display:flex;align-items:flex-end;gap:30px;flex-wrap:wrap;margin-top:14px">
      ${[64, 28, 22, 16, 14, 13].map((s) => `<div><div style="display:flex;align-items:flex-end;height:66px">${H(s)}</div><div class="sz">${s}px</div></div>`).join('')}
      <div style="width:1px;height:56px;background:#e7e5e4"></div>
      <div style="max-width:30ch"><div class="note"><b style="color:#1c1917">13px is the item row.</b> A letterform is the one thing that holds at that size — a drawn machine turns to mush.</div></div>
    </div>
  </div>

  <div style="display:grid;grid-template-columns:1.15fr 1fr;gap:20px">
    <div class="card">
      <h3>The spec</h3>
      <table style="width:100%;font-size:12.5px;border-collapse:collapse">
        <tr><td style="padding:5px 0;color:#78716c;width:42%">fill</td><td><span style="display:inline-block;width:11px;height:11px;border-radius:3px;background:${YELLOW};vertical-align:-1px;margin-right:6px"></span><span class="mono" style="font-size:12px">${YELLOW}</span></td></tr>
        <tr><td style="padding:5px 0;color:#78716c">letter</td><td><span style="display:inline-block;width:11px;height:11px;border-radius:3px;background:${INK};vertical-align:-1px;margin-right:6px"></span><span class="mono" style="font-size:12px">${INK}</span></td></tr>
        <tr><td style="padding:5px 0;color:#78716c">ring</td><td class="mono" style="font-size:12px">#ffffff, 1.5</td></tr>
        <tr><td style="padding:5px 0;color:#78716c">geometry</td><td class="mono" style="font-size:12px">r=7 disc, 14×14 box</td></tr>
        <tr><td style="padding:5px 0;color:#78716c">tooltip / a11y</td><td class="mono" style="font-size:12px">“Hydraulic stacker”</td></tr>
      </table>
      <p class="note" style="margin-top:10px">Same disc construction every other badge on the board uses, so it sits in the set rather than beside it.</p>
    </div>
    <div class="card">
      <h3>Why the H is dark, not white</h3>
      <div style="display:flex;align-items:center;gap:20px;margin:12px 0 10px">
        <div style="text-align:center">${H_WHITE(13)}<div class="sz">white</div></div>
        <div style="text-align:center">${H_WHITE(28)}<div class="sz">white</div></div>
        <div style="width:1px;height:34px;background:#e7e5e4"></div>
        <div style="text-align:center">${H(13)}<div class="sz">dark</div></div>
        <div style="text-align:center">${H(28)}<div class="sz">dark</div></div>
      </div>
      <p class="note">Every existing badge uses a white glyph, but they all sit on dark fills. On bright yellow white washes out. Your app already knows this — <span class="mono">readableTextColor()</span> returns <span class="mono">#1f2937</span> for anything this light, so dark <i>is</i> the house rule here.</p>
    </div>
  </div>
</div>`));

/* ══ 2 · MOBILE ══ */
fs.writeFileSync('Phone.dc.html', wrap(`
<div class="pad">
  <div class="kicker">Mobile · the stop sheet</div>
  <h2>On the phone</h2>
  <p class="note" style="margin-bottom:20px">The real card at 390px and at 360px — the two widths CI checks. Row text is 13px; the mark rides at the end of the product name.</p>
  <div style="display:flex;gap:30px;align-items:flex-start;flex-wrap:wrap">
    <div><div class="sz" style="text-align:left;margin-bottom:7px">390px phone · 358px rows</div>${stopCard(358)}</div>
    <div><div class="sz" style="text-align:left;margin-bottom:7px">360px phone · 328px rows — the narrowest in the fleet</div>${stopCard(328)}</div>
    <div style="max-width:290px">
      <div class="card"><h3>It sits inside the name</h3><p class="note">Placed after the product text, so it inherits the row's own wrapping. The stacker name is short enough that it never pushes to a second line at either width.</p></div>
      <div class="card" style="margin-top:14px"><h3>One mark, one row</h3><p class="note">Only the matching line wears it. The other six read exactly as they do today — so the yellow is the only thing that has changed on the card, and it points at one row.</p></div>
    </div>
  </div>
</div>`));

/* ══ 3 · DESKTOP ══ */
fs.writeFileSync('Desktop.dc.html', wrap(`
<div class="pad">
  <div class="kicker">Desktop · the right sidebar</div>
  <h2>On the desktop board</h2>
  <p class="note" style="margin-bottom:20px">The sidebar is <span class="mono">w-[380px]</span>, which leaves 347px of row after its border and padding — between the two phone widths, so the same treatment covers all three.</p>
  <div style="display:flex;gap:30px;align-items:flex-start;flex-wrap:wrap">
    <div><div class="sz" style="text-align:left;margin-bottom:7px">347px rows</div>${stopCard(347)}</div>
    <div style="max-width:420px">
      <div class="card"><h3>Expanded vs collapsed</h3><p class="note">The Items list starts collapsed on every card, so the mark is visible once you open the list — which is the moment you are reading the freight anyway.</p><div style="margin-top:12px;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;background:#fff;font-family:system-ui">
        <div class="cap">Items (7)</div><div class="sum">4 pallets · 4 pieces · 1765 Lbs</div>
        <div style="font-size:11px;color:#94a3b8;margin-top:4px">▾ collapsed — nothing shown</div>
      </div></div>
      <div class="card" style="margin-top:14px"><h3>Next to the amber badge</h3>
        <div style="display:flex;align-items:center;gap:16px;margin:10px 0">
          <div style="text-align:center"><svg width="22" height="22" viewBox="0 0 14 14"><circle cx="7" cy="7" r="7" fill="#f59e0b" stroke="white" stroke-width="1.5"/><rect x="1.4" y="4.6" width="7" height="5.4" rx="0.5" fill="white"/><path d="M8.4 6.2h2.5l2 2v1.8H8.4z" fill="white"/><circle cx="4" cy="10.2" r="1.1" fill="#f59e0b"/><circle cx="9.7" cy="10.2" r="1.1" fill="#f59e0b"/><line x1="2.5" y1="2.5" x2="11.5" y2="11.5" stroke="white" stroke-width="2" stroke-linecap="round"/></svg><div class="sz">uline amber</div></div>
          <div style="text-align:center">${H(22)}<div class="sz">yellow H</div></div>
        </div>
        <p class="note">You said the amber straight-truck badge is rarely used, so this is noted and not a concern. They read apart anyway — the dark letter is the separator.</p></div>
    </div>
  </div>
</div>`));

fs.writeFileSync('canvas.json', JSON.stringify({
  artboards: [
    { file: 'Main.dc.html',    title: '1 · The mark',  x: 0,    y: 0,   w: 1040, h: 680 },
    { file: 'Phone.dc.html',   title: '2 · Mobile',    x: 0,    y: 780, w: 1420, h: 1030 },
    { file: 'Desktop.dc.html', title: '3 · Desktop',   x: 1540, y: 780, w: 1000, h: 1030 },
  ],
  annotations: [
    { id: 'decided', x: 1140, y: 0, w: 420,
      text: 'Decided: bright yellow #facc15 with a dark H, shown when the item text contains "hydraulic stacker".\n\nNothing derived, no thresholds, no changes to the ticket or the map.' },
  ],
  launch: { view: 'canvas' },
}, null, 2));
console.log('3 boards + canvas.json');
