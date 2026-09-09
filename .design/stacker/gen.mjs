import fs from 'fs';
import { MARK, ALT, REAL, CHEV, wrap, ITEMS, row } from './build.mjs';
const list = (mark) => ITEMS.map((r) => row(r, mark && r[0] === 'HYDRAULIC STACKER')).join('');

/* ══════════════ 1 · MAIN ══════════════ */
fs.writeFileSync('Main.dc.html', wrap(`
<div class="pad">
  <div class="kicker">Design proposal · item-level freight flag</div>
  <h1>The mark shouldn't say “stacker”.<br>It should say <i>1,259&nbsp;lb in one piece</i>.</h1>
  <div class="rule"></div>
  <p class="lede">You asked for an icon for the hydraulic stacker. The row already says <b>HYDRAULIC STACKER</b> in the largest text on the line — an icon meaning “this is a stacker” is a second copy of words already on screen. What no surface puts in front of a dispatcher is the thing that changes how the freight gets handled: <b>one piece on this stop weighs 1,259&nbsp;lb.</b></p>

  <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;margin:30px 0 8px">
    <div class="stat"><b>1,259 lb</b><span>the single heaviest piece, on a line of quantity 1</span></div>
    <div class="stat"><b>71%</b><span>of the whole stop's 1,765&nbsp;lb sits in that one piece</span></div>
    <div class="stat"><b>7.2×</b><span>heavier than the next piece on the same stop (174&nbsp;lb)</span></div>
  </div>

  <div class="rule"></div>
  <div class="grid2">
    <div class="card">
      <h3>What fires today</h3>
      <p class="note" style="margin-bottom:10px">Nothing. I ran the real module on the real stop:</p>
      <p class="mono" style="line-height:1.6">deriveGeometryDeterministic →<br>{ skids: 4, weightLbs: 1765,<br>&nbsp;&nbsp;oversize: <b>false</b>, ambiguous: false,<br>&nbsp;&nbsp;linearFeetIn: 96, notes: [], … }</p>
      <p class="note" style="margin-top:10px">Nothing marks it. <span class="mono">board-flags.js</span> never reads <span class="mono">stopDetails</span> at all, so the flag engine cannot see a line item even in principle.</p>
    </div>
    <div class="card">
      <h3>Why the average hides it</h3>
      <p class="note">The card's summary reads <b style="color:#1c1917">“4 pallets · 4 pieces · 1765 Lbs”</b>. Divide it out and that implies 441&nbsp;lb a skid — an ordinary Uline drop.</p>
      <p class="note" style="margin-top:10px">Six of the seven lines total 506&nbsp;lb between them. The seventh is 1,259. <b style="color:#1c1917">The average is the lie</b>, and the average is the only freight number on the collapsed card.</p>
      <p class="note" style="margin-top:10px">The number itself is not hidden everywhere — the printed ticket, the Bill of Lading and the Routing popup all list the line. What none of them does is <i>mark</i> it, sort by it, or show it where loads get built.</p>
    </div>
  </div>

  <div class="rule"></div>
  <h2>The rule</h2>
  <p class="note" style="margin-bottom:14px">Not a product-name list — a derived number. It needs no vocabulary and never rots when Uline renames a SKU.</p>
  <div class="card" style="background:#1c1917;border-color:#1c1917">
    <p class="mono" style="color:#e7e5e4;font-size:12.5px;line-height:1.75">
      qty&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; = Math.max(1, Math.round(Number(line.quantity) || 1))<br>
      perPiece = toLbs(line.weight, line.weightUOM) / qty<br>
      flag&nbsp;&nbsp;&nbsp;&nbsp; = Number.isFinite(perPiece) &amp;&amp; perPiece &gt;= HEAVY_PIECE_LB
    </p>
  </div>
  <div class="grid3" style="margin-top:18px">
    <div class="card"><h3>divide by quantity</h3><p class="note">The seven line weights sum to <b style="color:#1c1917">exactly 1,765</b> — the stop total — so <span class="mono">weight</span> is the LINE total here. Consistent with this stop; the field is not documented either way, so the free read below should confirm it before anyone relies on it.</p></div>
    <div class="card"><h3>why the guard, not a bug report</h3><p class="note"><span class="mono">Number(null)</span> is 0, and <span class="mono">1259 / 0</span> is <b style="color:#1c1917">Infinity</b>, which passes any <span class="mono">&gt;=</span>. That is what <span class="mono">Math.max(1, …)</span> and <span class="mono">Number.isFinite</span> in the rule are for — this repo has shipped that exact class once already.</p></div>
    <div class="card"><h3>convert the units</h3><p class="note">The UI prints <span class="mono">weight</span> and <span class="mono">weightUOM</span> raw with no conversion, and the vendor's own example UOM is kilograms. A KG line read as LB is a <b style="color:#1c1917">2.2× error</b>. <span class="mono">toLbs()</span> already ships in <span class="mono">freight-class.mts</span>.</p></div>
  </div>
</div>`));

/* ══════════════ 2 · MARK ══════════════ */
fs.writeFileSync('Mark.dc.html', wrap(`
<div class="pad">
  <div class="kicker">The mark</div>
  <h2>A weight, drawn at the size it will actually be used</h2>
  <p class="note" style="margin-bottom:22px">Rendered, not described. The item row is 13px text, so the mark is 13px — and the delivery ticket is a black-and-white laser print, so it has to survive that too.</p>

  <div class="card" style="margin-bottom:20px">
    <h3>Recommended · “heavy piece”</h3>
    <div style="display:flex;align-items:center;gap:26px;flex-wrap:wrap;margin:14px 0 4px">
      ${[56, 22, 16, 14, 13].map((s) => `<div style="display:flex;flex-direction:column;align-items:center;gap:7px">${MARK(s)}<span class="mono" style="font-size:9px">${s}px</span></div>`).join('')}
      <div style="width:1px;height:44px;background:#e7e5e4"></div>
      <div style="display:flex;flex-direction:column;align-items:center;gap:7px">${MARK(11, true)}<span class="mono" style="font-size:9px">11px black</span></div>
      <div class="note" style="max-width:24ch">A dumbbell — two caps and a bar. Three rectangles, no interior detail to lose.</div>
    </div>
  </div>

  <div class="grid2">
    <div class="card">
      <h3>Why not a picture of a stacker</h3>
      <div style="display:flex;align-items:center;gap:18px;margin:12px 0">
        <svg width="52" height="52" viewBox="0 0 14 14"><circle cx="7" cy="7" r="7" fill="#111827" stroke="#fff" stroke-width="1.5"/><rect x="3.1" y="2.2" width="1.5" height="8.4" fill="#fff"/><rect x="4.6" y="4.6" width="4.6" height="1.2" fill="#fff"/><rect x="4.6" y="7" width="4.6" height="1.2" fill="#fff"/><rect x="2.4" y="10.6" width="7.2" height="1.1" fill="#fff"/><circle cx="3.4" cy="12.2" r=".85" fill="#fff"/><circle cx="8.8" cy="12.2" r=".85" fill="#fff"/></svg>
        <svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="7" fill="#111827" stroke="#fff" stroke-width="1.5"/><rect x="3.1" y="2.2" width="1.5" height="8.4" fill="#fff"/><rect x="4.6" y="4.6" width="4.6" height="1.2" fill="#fff"/><rect x="4.6" y="7" width="4.6" height="1.2" fill="#fff"/><rect x="2.4" y="10.6" width="7.2" height="1.1" fill="#fff"/><circle cx="3.4" cy="12.2" r=".85" fill="#fff"/><circle cx="8.8" cy="12.2" r=".85" fill="#fff"/></svg>
        <span class="tag no">unreadable at 13px</span>
      </div>
      <p class="note">A mast and forks needs five or six separate shapes. At row size they merge into a smudge — which is exactly what already happens to the truck glyphs in the existing set.</p>
    </div>
    <div class="card">
      <h3>Collision check at 13px · real glyphs</h3>
      <div style="display:flex;align-items:center;gap:16px;margin:12px 0 8px">
        ${['box_truck_only', 'liftgate_required', 'uline_straight_truck', 'no_overhead_clearance'].map((k) => `<div style="display:flex;flex-direction:column;align-items:center;gap:6px">${REAL(k, 13)}<span class="mono" style="font-size:8px">${k.split('_')[0]}</span></div>`).join('')}
        <div style="width:1px;height:34px;background:#e7e5e4"></div>
        <div style="display:flex;flex-direction:column;align-items:center;gap:6px">${MARK(13)}<span class="mono" style="font-size:8px;color:#111827"><b>heavy</b></span></div>
      </div>
      <p class="note">Drawn from the glyphs in <span class="mono">RESTRICTION_ICONS</span> itself, not redrawn by hand. <b style="color:#1c1917">Charcoal #111827</b> is the furthest from every fill in that table by RGB distance — 105 from the nearest, slate <span class="mono">#475569</span>. It is a near-neutral: 17 of the 20 fills sit above 70% saturation, so a dark neutral reads as a <i>different kind of mark</i> rather than a 21st restriction.</p>
      <p class="note" style="margin-top:9px"><b style="color:#1c1917">Honest caveat:</b> slate is the one existing fill that is also low-saturation (19%), and at 13px a dark disc with a horizontal white shape is the nearest thing to a collision this set has. The mark lives in the items list, not the pin row, so the two should rarely meet.</p>
    </div>
  </div>

  <div class="card" style="margin-top:20px">
    <h3>Alternate, if you'd rather it read as “heavy” than as “a weight”</h3>
    <div style="display:flex;align-items:center;gap:22px;margin-top:12px">
      ${[44, 22, 14, 13].map((s) => ALT(s)).join('')}
      <p class="note" style="max-width:52ch;margin-left:8px">Mass pressing onto a deck. Crisper at 13px than the dumbbell, and more distinct from <span class="mono">box_truck_only</span> — but it shares the arrow form with <span class="mono">liftgate_required</span>, and lifting is precisely the domain where the two would be confused. That trade is the reason the dumbbell leads; it is close.</p>
    </div>
  </div>
</div>`));
console.log('Main + Mark');
