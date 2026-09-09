import fs from 'fs';
import { MARK, ALT, wrap, ITEMS, row } from './build.mjs';

const list = (mark) => ITEMS.map((r) => row(r, mark && r[0] === 'HYDRAULIC STACKER')).join('');

/* ─────────────────────── 1 · MAIN — the reframe ─────────────────────── */
fs.writeFileSync('Main.dc.html', wrap(`
<div class="pad">
  <div class="kicker">Design proposal · item-level freight flag</div>
  <h1>The mark shouldn't say “stacker”.<br>It should say <i>1,259&nbsp;lb in one piece</i>.</h1>
  <div class="rule"></div>
  <p class="lede">You asked for an icon for the hydraulic stacker. The row already says <b>HYDRAULIC STACKER</b> in the largest text on the line — an icon meaning “this is a stacker” is a second copy of words already on screen. What the row does <i>not</i> say, anywhere, is the thing that changes how the freight gets handled: <b>one piece on this stop weighs 1,259&nbsp;lb.</b></p>

  <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;margin:30px 0 8px">
    <div class="stat"><b>1,259 lb</b><span>the single heaviest piece — arriving as 1&nbsp;UNT, not on a skid</span></div>
    <div class="stat"><b>71%</b><span>of the whole stop's 1,765&nbsp;lb sits in that one piece</span></div>
    <div class="stat"><b>7.2×</b><span>heavier than the next piece on the same stop (174&nbsp;lb)</span></div>
  </div>

  <div class="rule"></div>
  <div class="grid2">
    <div class="card">
      <h3>What fires today</h3>
      <p class="note" style="margin-bottom:10px">Nothing. I ran the real modules on the real stop:</p>
      <p class="mono" style="line-height:1.6">deriveGeometryDeterministic →<br>{ skids: 4, weightLbs: 1765,<br>&nbsp;&nbsp;oversize: <b>false</b>, notes: [] }</p>
      <p class="note" style="margin-top:10px">The 1,259&nbsp;lb piece is invisible to the router, the map, the grid and the flag engine. It exists in exactly one place — a collapsed line on the stop card.</p>
    </div>
    <div class="card">
      <h3>Why the average hides it</h3>
      <p class="note">The card's summary reads <b style="color:#1c1917">“4 pallets · 4 pieces · 1765 Lbs”</b>. Divide it out and that implies 441&nbsp;lb a skid — an ordinary Uline drop.</p>
      <p class="note" style="margin-top:10px">Six of the seven lines total 506&nbsp;lb between them. The seventh is 1,259. <b style="color:#1c1917">The average is the lie</b>, and the average is the only number on the collapsed card.</p>
    </div>
  </div>

  <div class="rule"></div>
  <h2>The rule</h2>
  <p class="note" style="margin-bottom:14px">Not a product-name list — a derived number. It needs no vocabulary, never rots when Uline renames a SKU, and the number itself is the message.</p>
  <div class="card" style="background:#1c1917;border-color:#1c1917">
    <p class="mono" style="color:#e7e5e4;font-size:12.5px;line-height:1.75">
      perPiece = line.weight / max(1, line.quantity)<br>
      flag&nbsp;&nbsp;&nbsp;&nbsp; = Number.isFinite(perPiece) &amp;&amp; perPiece &gt;= HEAVY_PIECE_LB
    </p>
  </div>
  <div class="grid3" style="margin-top:18px">
    <div class="card"><h3>weight is the line TOTAL</h3><p class="note">39+31+2+31+55+1259+348 = <b style="color:#1c1917">1,765</b> — matches the stop to the pound. So it must be divided by quantity, or a 3-piece line reads as one heavy one.</p></div>
    <div class="card"><h3>guard the divide</h3><p class="note"><span class="mono">1259 / Number(null)</span> is <b style="color:#1c1917">Infinity</b>, and Infinity passes a bare <span class="mono">&gt;= 500</span>. Same class of bug that once shipped a midnight deadline for a stop with no deadline.</p></div>
    <div class="card"><h3>the threshold is not knife-edge</h3><p class="note">Anything from ~250 to ~1,000&nbsp;lb gives the identical answer on this stop. <b style="color:#1c1917">500&nbsp;lb</b> as one named constant — but set it from your own freight, not from me (see the last board).</p></div>
  </div>
</div>`));

/* ─────────────────────── 2 · MARK — the icon ─────────────────────── */
const EX = [
  ['box_truck_only', '#475569', `<rect x="1.6" y="6.2" width="7.2" height="4" rx="0.5" fill="white"/><path d="M8.8 7.4h2.1l1.6 1.6v1.2H8.8z" fill="white"/>`],
  ['liftgate_required', '#7c3aed', `<path d="M7 2.2 10.2 6H8.4v3.1H5.6V6H3.8z" fill="white"/><rect x="2.6" y="10.4" width="8.8" height="1.6" rx=".4" fill="white"/>`],
  ['uline_straight_truck', '#f59e0b', `<rect x="1.4" y="4.6" width="7" height="5.4" rx="0.5" fill="white"/><path d="M8.4 6.2h2.5l2 2v1.8H8.4z" fill="white"/><circle cx="4" cy="10.2" r="1.1" fill="#f59e0b"/><circle cx="9.7" cy="10.2" r="1.1" fill="#f59e0b"/><line x1="2.5" y1="2.5" x2="11.5" y2="11.5" stroke="white" stroke-width="2" stroke-linecap="round"/>`],
];
const exBadge = (d, px) => `<svg width="${px}" height="${px}" viewBox="0 0 14 14"><circle cx="7" cy="7" r="7" fill="${d[1]}" stroke="white" stroke-width="1.5"/>${d[2]}</svg>`;

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
      <h3>Collision check, at 13px</h3>
      <div style="display:flex;align-items:center;gap:16px;margin:12px 0 8px">
        ${EX.map((d) => `<div style="display:flex;flex-direction:column;align-items:center;gap:6px">${exBadge(d, 13)}<span class="mono" style="font-size:8px">${d[0].split('_')[0]}</span></div>`).join('')}
        <div style="width:1px;height:34px;background:#e7e5e4"></div>
        <div style="display:flex;flex-direction:column;align-items:center;gap:6px">${MARK(13)}<span class="mono" style="font-size:8px;color:#111827"><b>heavy</b></span></div>
      </div>
      <p class="note"><b style="color:#1c1917">Charcoal #111827</b> is the furthest hue from every colour already in use — 105 away from the nearest (slate #475569). It also reads as a <i>different vocabulary</i>: the 18 existing icons are all saturated hues, and all of them are facts about the <b style="color:#1c1917">place</b>. This is a fact about the <b style="color:#1c1917">freight</b>.</p>
    </div>
  </div>

  <div class="card" style="margin-top:20px">
    <h3>Alternate, if you'd rather it read as “heavy” than as “a weight”</h3>
    <div style="display:flex;align-items:center;gap:22px;margin-top:12px">
      ${[44, 22, 14, 13].map((s) => ALT(s)).join('')}
      <p class="note" style="max-width:52ch;margin-left:8px">Mass pressing onto a deck. Slightly crisper at 13px than the dumbbell — but it shares the arrow form with <span class="mono">liftgate_required</span>, and lifting is precisely the domain where the two would be confused. That's why the dumbbell leads.</p>
    </div>
  </div>
</div>`));

/* ─────────────────────── 3 · PHONE ─────────────────────── */
fs.writeFileSync('Phone.dc.html', wrap(`
<div class="pad">
  <div class="kicker">Mobile · the stop sheet</div>
  <h2>Where the mark physically fits on a phone</h2>
  <p class="note" style="margin-bottom:22px">Measured at the real content widths, not guessed. A 360px phone gives the item list <b>328px</b> after padding — the narrowest case in the fleet.</p>
  <div style="display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap">
    <div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:9px"><span class="tag no">rejected</span><span class="note" style="font-size:11.5px">chip after the product name</span></div>
      <div class="app" style="width:328px"><div class="bar"><span>360px phone · 328px content</span></div><div class="in">
        <div class="li"><div class="lr"><span class="nm">PALLET STRETCH WRAP 15PCF<span class="Lchip" style="background:#fee2e2;color:#991b1b">HEAVY</span></span><span class="qt">1 CTN · 31 Lbs</span></div><div class="sku">156830-08 , SEQ# 6</div></div>
        <div class="li"><div class="lr"><span class="nm">HYDRAULIC STACKER<span class="Lchip" style="background:#fee2e2;color:#991b1b">HEAVY</span></span><span class="qt">1 UNT · 1259 Lbs</span></div><div class="sku">190235-07 , SEQ# 3</div></div>
      </div></div>
      <p class="note" style="width:328px;margin-top:9px">The chip pushes the longest product name into a wrap — and it wraps at <b style="color:#1c1917">every</b> real width, desktop included.</p>
    </div>
    <div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:9px"><span class="tag yes">recommended</span><span class="note" style="font-size:11.5px">its own line, under the SKU</span></div>
      <div class="app" style="width:328px"><div class="bar"><span>360px phone · 328px content</span></div><div class="in">${list(true)}</div></div>
      <p class="note" style="width:328px;margin-top:9px">The SKU line is short and otherwise empty. The mark and its number sit there without touching anything — nothing wraps, at 328 or 390.</p>
    </div>
  </div>
  <div class="rule"></div>
  <p class="note"><b style="color:#1c1917">One component currently serves both views.</b> <span class="mono">OrderItemsSection</span> (App.jsx:5483) is rendered once and mounted by both the desktop sidebar and the mobile sheet — deliberately, since v0.28.0 made them share so they could not drift. That is worth knowing before anyone adds a phone-only branch here.</p>
</div>`));

/* ─────────────────────── 4 · DESKTOP ─────────────────────── */
fs.writeFileSync('Desktop.dc.html', wrap(`
<div class="pad">
  <div class="kicker">Desktop · the right sidebar</div>
  <h2>The desktop card is <i>narrower</i> than the phone</h2>
  <p class="note" style="margin-bottom:22px"><span class="mono">w-[380px]</span> with <span class="mono">px-4</span> leaves <b>348px</b> of content — less than a 390px phone's 358px. Desktop is the harder case here, not the easier one, which is the opposite of the usual assumption.</p>
  <div style="display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap">
    <div>
      <div class="app" style="width:348px"><div class="bar"><span>PRO 007173855</span><span>MANDI · stop 7</span></div><div class="in">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
          <span><span class="cap">Items (7)</span><span class="sum" style="display:block">4 pallets · 4 pieces · 1765 Lbs</span></span>
          <span style="color:#94a3b8;font-size:13px">⌃</span>
        </div>
        <div style="border-top:1px solid #f1f5f9;margin-top:7px;padding-top:7px">${list(true)}</div>
      </div></div>
    </div>
    <div style="max-width:400px">
      <div class="card"><h3>What the dispatcher does with it</h3><p class="note">Assigns a truck that can get 1,259&nbsp;lb off — a dock-height trailer or a gate rated for it — and tells the loader to put it last on. Both decisions happen before the truck leaves, which is why the mark has to be visible <b style="color:#1c1917">without expanding the list</b> (next board).</p></div>
      <div class="card" style="margin-top:16px"><h3>Honest limit</h3><p class="note">A heavy piece does <b style="color:#1c1917">not</b> by itself change which truck the router picks. I checked: with no site restrictions, <span class="mono">truckCanCarry</span> returns ok for both the 26ft box and the 53ft trailer — 1,259&nbsp;lb is 12.6% of the box's 10,000&nbsp;lb rating. Truck choice is already owned by the site-level icons. Sell this as <i>information</i>, not as truck selection.</p></div>
    </div>
  </div>
</div>`));
console.log('4 artboards written');
