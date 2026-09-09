import fs from 'fs';
import { MARK, wrap } from './build.mjs';

/* ══════════════ 5 · PAPER ══════════════ */
const TSTY = `
.tk{font-family:Arial,Helvetica,sans-serif;color:#111;font-size:11px;background:#fff;border:1px solid #e7e5e4;border-radius:9px;padding:16px}
.tk table{border-collapse:collapse;width:100%;table-layout:fixed}
.tk th{border-bottom:1px solid #bbb;background:#f0f1f3;padding:4px 6px;text-align:left;font-size:10px}
.tk td{border-bottom:1px solid #e6e6e6;padding:4px 6px;word-break:break-word}
.tk td.c,.tk th.c{text-align:center}.tk td.r,.tk th.r{text-align:right}
.mkfill{font-weight:bold;background:#111;color:#fff;border-radius:3px;padding:0 4px;font-size:9px}
.mkink{font-weight:bold;border:1.5px solid #111;border-radius:3px;padding:0 4px;font-size:9px;color:#111}
`;
const head = `<tr><th style="width:22%">PO</th><th style="width:22%">PO Identifier</th><th class="c" style="width:10%">Quantity</th><th class="c" style="width:24%">Exceptions/Comments</th><th class="r" style="width:12%">Weight</th><th style="width:10%">Volume</th></tr>`;
const r = (p, id, q, exc, w, b) => `<tr><td>${p}</td><td>${id}</td><td class="c">${q}</td><td class="c">${exc}</td><td class="r">${b ? `<b>${w}</b>` : w}</td><td></td></tr>`;
const FLAG_FILL = '<span class="mkfill">HEAVY</span><div style="font-size:9px;font-weight:bold;margin-top:2px">DOCK OR FORKLIFT<br>KEEP UPRIGHT</div>';
const FLAG_INK = '<span class="mkink">HEAVY</span><div style="font-size:9px;font-weight:bold;margin-top:2px">DOCK OR FORKLIFT<br>KEEP UPRIGHT</div>';

fs.writeFileSync('Paper.dc.html', wrap(`
<helmet><style>${TSTY}</style></helmet>
<div class="pad">
  <div class="kicker">Paper · the Delivery Ticket</div>
  <h2>The column for this already exists, and it's printing nothing</h2>
  <p class="note" style="margin-bottom:22px">The ticket the driver carries has an <b>Exceptions/Comments</b> column — 24% of the page — rendering a hardcoded <span class="mono">-/-</span> on every line.</p>

  <div class="grid2">
    <div>
      <div style="margin-bottom:9px"><span class="tag chk">today</span></div>
      <div class="tk"><table><thead>${head}</thead><tbody>
        ${r('MISC', '187645-05', '3', '-/-', '55 Lbs')}
        ${r('HYDRAULIC STACKER', '190235-07', '1', '-/-', '1,259 Lbs')}
        ${r('PLATFORM TRUCK', '192400-00', '2', '-/-', '348 Lbs')}
      </tbody></table></div>
    </div>
    <div>
      <div style="margin-bottom:9px"><span class="tag yes">proposed</span><span class="note" style="font-size:11.5px;margin-left:8px">zero layout change</span></div>
      <div class="tk"><table><thead>${head}</thead><tbody>
        ${r('MISC', '187645-05', '3', '-/-', '55 Lbs')}
        ${r('HYDRAULIC STACKER', '190235-07', '1', FLAG_INK, '1,259 Lbs', true)}
        ${r('PLATFORM TRUCK', '192400-00', '2', '-/-', '348 Lbs')}
      </tbody></table></div>
    </div>
  </div>

  <div class="rule"></div>
  <div class="grid3">
    <div class="card"><h3>ink, not a fill — this is the real print test</h3>
      <div style="display:flex;gap:10px;margin:10px 0">
        <div class="tk" style="padding:7px;flex:1"><table><tbody><tr><td class="c">${FLAG_FILL}</td></tr></tbody></table><div style="font-size:9px;color:#78716c;margin-top:5px">solid fill</div></div>
        <div class="tk" style="padding:7px;flex:1;background:#fff"><table><tbody><tr><td class="c" style="color:#fff">${FLAG_FILL}</td></tr></tbody></table><div style="font-size:9px;color:#991b1b;margin-top:5px">same, backgrounds off</div></div>
      </div>
      <p class="note">Browsers drop background graphics when “print backgrounds” is off — a white-on-black chip then prints <b style="color:#1c1917">white on white</b>. The proposed mark uses a <b style="color:#1c1917">stroked outline and black text</b>, which survives either way. Greyscale is the wrong test; this is the right one.</p></div>
    <div class="card"><h3>the ticket drops the field that matters</h3><p class="note"><span class="mono">ticketData</span> maps each line to <span class="mono">{po, ident, qty, wt}</span> — it discards <span class="mono">quantityUOM</span>. The screen prints “1&nbsp;UNT”; the paper prints “1”. <b style="color:#1c1917">UNT is the hint that this is a machine, not a carton</b>. The Bill of Lading already carries the UOM; the ticket doesn't.</p></div>
    <div class="card"><h3>there is no manifest cover to put it on</h3><p class="note">Page 1 of the Driver Manifest is the summary header <b style="color:#1c1917">plus the first ticket</b> — not a standalone cover — and every ticket after starts a new page. So there is no per-stop roster page today; adding “heavy pieces on this route” to that header is a real change, not a slot waiting to be filled.</p></div>
  </div>
</div>`));

/* ══════════════ 6 · ESCALATE ══════════════ */
fs.writeFileSync('Escalate.dc.html', wrap(`
<div class="pad">
  <div class="kicker">Escalation</div>
  <h2>Inside a collapsed list, the mark is worth little</h2>
  <p class="note" style="margin-bottom:24px"><span class="mono">OrderItemsSection</span> takes a <span class="mono">defaultOpen</span> prop, but its single call site omits it — so on every stop card the list starts <b style="color:#1c1917">closed</b>. Load building happens in the bottom grid, whose columns are Pallets / Loose / Weight / Restrictions / Load / Driver; it never opens a card. A mark only inside the list is a mark read after the truck is chosen.</p>

  <div style="display:flex;gap:26px;align-items:flex-start;flex-wrap:wrap">
    <div>
      <div style="margin-bottom:9px"><span class="tag yes">1 · the collapsed header</span></div>
      <div class="app" style="width:347px"><div class="bar">what you see without expanding</div><div style="padding:10px 16px">
        <span class="cap">Items (7)</span>
        <span class="sum" style="display:block">4 pallets · 4 pieces · 1765 Lbs</span>
        <div class="mkline" style="margin-top:5px">${MARK(12)}<b class="mktxt">heaviest piece 1,259 lb — 71% of this stop</b></div>
      </div></div>
      <p class="note" style="width:347px;margin-top:9px">One line, on the summary already on screen. Highest value for the least new surface.</p>
    </div>
    <div>
      <div style="margin-bottom:9px"><span class="tag yes">2 · the grid's weight cell</span></div>
      <div class="app" style="width:400px"><div class="bar">bottom planning grid</div>
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="background:#f8fafc"><th style="text-align:left;padding:6px 10px;font-size:10px;text-transform:uppercase;color:#64748b;font-weight:600">Customer</th><th style="text-align:right;padding:6px 10px;font-size:10px;text-transform:uppercase;color:#64748b;font-weight:600">Skids</th><th style="text-align:right;padding:6px 10px;font-size:10px;text-transform:uppercase;color:#64748b;font-weight:600">Weight</th></tr></thead>
          <tbody>
            <tr style="border-top:1px solid #e2e8f0"><td style="padding:6px 10px;color:#1e293b">PARAGON FILMS</td><td style="text-align:right;padding:6px 10px;color:#475569">6</td><td style="text-align:right;padding:6px 10px;color:#475569">2,140</td></tr>
            <tr style="border-top:1px solid #e2e8f0;background:#fafafa"><td style="padding:6px 10px;color:#1e293b">SHARPS MWS</td><td style="text-align:right;padding:6px 10px;color:#475569">4</td><td style="text-align:right;padding:6px 10px;color:#475569"><span style="display:inline-flex;align-items:center;gap:4px;justify-content:flex-end">1,765 ${MARK(11)}</span><div style="font-size:9px;font-weight:700;color:#111827">1,259 in 1 pc</div></td></tr>
            <tr style="border-top:1px solid #e2e8f0"><td style="padding:6px 10px;color:#1e293b">MHC KENWORTH</td><td style="text-align:right;padding:6px 10px;color:#475569">2</td><td style="text-align:right;padding:6px 10px;color:#475569">880</td></tr>
          </tbody>
        </table></div>
      <p class="note" style="width:400px;margin-top:9px">Put it where the number it corrects already lives — sortable in a grid that already sorts, and it costs no map-pin slot.</p>
    </div>
  </div>

  <div class="rule"></div>
  <div class="grid2">
    <div class="card"><h3>Not the map pin</h3><p class="note">Pin slots are scarce: the marker draws 2–3 icons and collapses 4+ to “first 2 + <span class="mono">+N</span>”. The 20 keys in <span class="mono">RESTRICTION_ICONS</span> are about the <i>place and its clock</i> — can the truck get in, and is anyone there. This answers “can we get it off the truck”, which is a freight question. Different question, different surface.</p><p class="note" style="margin-top:9px">That table has already been pruned once for noise: <span class="mono">appointment_required</span> was redrawn from a clock to a handset in v0.65 because it was “a quarter of why the map read as time-noise”. Adding a freight mark to the pin row would re-earn that.</p></div>
    <div class="card"><h3>A third state, not two</h3><p class="note">The cheap saved-search pull that builds the board carries <b style="color:#1c1917">no line items</b> — they arrive later, per PRO, capped at 250 a run. So the mark needs <b style="color:#1c1917">flagged / clean / not looked at yet</b>. Two states would quietly tell a dispatcher “nothing heavy here” about a stop whose items nobody has fetched. The <span class="mono">enriched</span> field is already on the wire, so this is buildable — but only if it is designed in now.</p></div>
  </div>
</div>`));
console.log('Paper + Escalate');
