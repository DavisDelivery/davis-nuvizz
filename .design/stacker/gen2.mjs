import fs from 'fs';
import { MARK, wrap, ITEMS, row } from './build.mjs';

/* ─────────────────────── 5 · PAPER — the delivery ticket ─────────────────────── */
const T = `
.tk{font-family:Arial,Helvetica,sans-serif;color:#111;font-size:11px;background:#fff;border:1px solid #e7e5e4;border-radius:9px;padding:16px}
.tk table{border-collapse:collapse;width:100%;table-layout:fixed}
.tk th{border-bottom:1px solid #bbb;background:#f0f1f3;padding:4px 6px;text-align:left;font-size:10px}
.tk td{border-bottom:1px solid #e6e6e6;padding:4px 6px;word-break:break-word}
.tk td.c,.tk th.c{text-align:center}.tk td.r,.tk th.r{text-align:right}
.mkfill{font-weight:bold;background:#111;color:#fff;border-radius:3px;padding:0 4px;font-size:9px}
`;
const head = `<tr><th style="width:22%">PO</th><th style="width:22%">PO Identifier</th><th class="c" style="width:10%">Quantity</th><th class="c" style="width:24%">Exceptions/Comments</th><th class="r" style="width:12%">Weight</th><th style="width:10%">Volume</th></tr>`;
const tkRow = (p, id, q, exc, w, bold) => `<tr><td>${p}</td><td>${id}</td><td class="c">${q}</td><td class="c">${exc}</td><td class="r">${bold ? `<b>${w}</b>` : w}</td><td></td></tr>`;

fs.writeFileSync('Paper.dc.html', wrap(`
<style>${T}</style>
<div class="pad">
  <div class="kicker">Paper · the Delivery Ticket</div>
  <h2>The column for this already exists, and it's printing nothing</h2>
  <p class="note" style="margin-bottom:22px">The ticket the driver physically carries has an <b>Exceptions/Comments</b> column — 24% of the page width — that renders a hardcoded <span class="mono">-/-</span> on every single line.</p>

  <div class="grid2">
    <div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:9px"><span class="tag chk">today</span></div>
      <div class="tk"><table><thead>${head}</thead><tbody>
        ${tkRow('MISC', '187645-05', '3', '-/-', '55 Lbs')}
        ${tkRow('HYDRAULIC STACKER', '190235-07', '1', '-/-', '1,259 Lbs')}
        ${tkRow('PLATFORM TRUCK', '192400-00', '2', '-/-', '348 Lbs')}
      </tbody></table></div>
    </div>
    <div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:9px"><span class="tag yes">proposed</span><span class="note" style="font-size:11.5px">zero layout change</span></div>
      <div class="tk"><table><thead>${head}</thead><tbody>
        ${tkRow('MISC', '187645-05', '3', '-/-', '55 Lbs')}
        ${tkRow('HYDRAULIC STACKER', '190235-07', '1', '<span class="mkfill">HEAVY</span><div style="font-size:9px;font-weight:bold;margin-top:2px">DOCK OR FORKLIFT<br>KEEP UPRIGHT</div>', '1,259 Lbs', true)}
        ${tkRow('PLATFORM TRUCK', '192400-00', '2', '-/-', '348 Lbs')}
      </tbody></table></div>
    </div>
  </div>

  <div class="rule"></div>
  <div class="grid3">
    <div class="card"><h3>no colour is load-bearing</h3>
      <div class="tk" style="filter:grayscale(1);padding:8px;margin:10px 0"><table><tbody>${tkRow('HYDRAULIC STACKER', '190235-07', '1', '<span class="mkfill">HEAVY</span>', '1,259 Lbs', true)}</tbody></table></div>
      <p class="note">The same row at 100% greyscale. Solid black on white, so a worn toner cartridge cannot erase the warning.</p></div>
    <div class="card"><h3>the ticket drops one field it needs</h3><p class="note"><span class="mono">ticketData</span> maps each line to <span class="mono">{po, ident, qty, wt}</span> — it throws away <span class="mono">quantityUOM</span>. The screen prints “1&nbsp;UNT”; the paper prints “1”. <b style="color:#1c1917">UNT is what says “machine, not carton”</b>, and restoring it is worth doing on its own.</p></div>
    <div class="card"><h3>the cover page has no roster</h3><p class="note">The Driver Manifest cover is route totals only, then one full ticket per page. Nothing between them answers “what is heavy today” before he pulls out of the yard — which is the moment load order actually gets decided.</p></div>
  </div>
</div>`));

/* ─────────────────────── 6 · ESCALATE ─────────────────────── */
fs.writeFileSync('Escalate.dc.html', wrap(`
<div class="pad">
  <div class="kicker">Escalation</div>
  <h2>Inside a collapsed list, the mark is worth nothing</h2>
  <p class="note" style="margin-bottom:24px"><span class="mono">OrderItemsSection</span> has one call site and no <span class="mono">defaultOpen</span> — it starts <b style="color:#1c1917">closed</b>. Nobody opens 700 cards and expands 700 item lists at load-building time. The mark has to reach a surface that is already being read.</p>

  <div style="display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap">
    <div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:9px"><span class="tag yes">1 · the collapsed header</span></div>
      <div class="app" style="width:348px"><div class="bar"><span>what you see without expanding</span></div><div class="in">
        <span class="cap">Items (7)</span>
        <span class="sum" style="display:block">4 pallets · 4 pieces · 1765 Lbs</span>
        <div class="mkline" style="margin-top:5px">${MARK(12)}<b class="mktxt">heaviest piece 1,259 lb — 71% of this stop</b></div>
      </div></div>
      <p class="note" style="width:348px;margin-top:9px">One line, on the summary that is already on screen. This is the single highest-value placement.</p>
    </div>
    <div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:9px"><span class="tag yes">2 · the grid's weight cell</span></div>
      <div class="app" style="width:400px"><div class="bar"><span>bottom planning grid</span></div><div style="padding:0">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="background:#f8fafc"><th style="text-align:left;padding:6px 10px;font-size:10px;text-transform:uppercase;color:#64748b;font-weight:600">Customer</th><th style="text-align:right;padding:6px 10px;font-size:10px;text-transform:uppercase;color:#64748b;font-weight:600">Skids</th><th style="text-align:right;padding:6px 10px;font-size:10px;text-transform:uppercase;color:#64748b;font-weight:600">Weight</th></tr></thead>
          <tbody>
            <tr style="border-top:1px solid #e2e8f0"><td style="padding:6px 10px;color:#1e293b">PARAGON FILMS</td><td style="text-align:right;padding:6px 10px;color:#475569">6</td><td style="text-align:right;padding:6px 10px;color:#475569">2,140</td></tr>
            <tr style="border-top:1px solid #e2e8f0;background:#fafafa"><td style="padding:6px 10px;color:#1e293b">SHARPS MWS</td><td style="text-align:right;padding:6px 10px;color:#475569">4</td><td style="text-align:right;padding:6px 10px;color:#475569"><span style="display:inline-flex;align-items:center;gap:4px;justify-content:flex-end">1,765 ${MARK(11)}</span><div style="font-size:9px;font-weight:700;color:#111827">1,259 in 1 pc</div></td></tr>
            <tr style="border-top:1px solid #e2e8f0"><td style="padding:6px 10px;color:#1e293b">MHC KENWORTH</td><td style="text-align:right;padding:6px 10px;color:#475569">2</td><td style="text-align:right;padding:6px 10px;color:#475569">880</td></tr>
          </tbody>
        </table>
      </div></div>
      <p class="note" style="width:400px;margin-top:9px">Put it where the number it corrects already lives. Sortable and filterable in a grid that already sorts — and it costs no map-pin slot.</p>
    </div>
  </div>

  <div class="rule"></div>
  <div class="grid2">
    <div class="card"><h3>Not the map pin</h3><p class="note">Pin slots are scarce — the marker collapses to “first 2 + <span class="mono">+N</span>” past three icons, and v0.65 already recorded 116 clock icons over 755 stops as “a quarter of why the map read as time-noise”. Every one of the 18 pin icons answers <i>can the truck get in the door</i>. This answers <i>can we get it off the truck</i>. Different question, different surface.</p></div>
    <div class="card"><h3>A third state, not two</h3><p class="note">The cheap saved-search pull that builds the board carries <b style="color:#1c1917">no line items at all</b> — they arrive later, per PRO, capped at 250 an run. So the mark needs <b style="color:#1c1917">flagged / clean / not looked at yet</b>. A two-state mark would quietly tell a dispatcher “nothing heavy here” about a stop whose items nobody has fetched. The <span class="mono">enriched</span> field is already on the wire, so this is buildable — but it has to be designed in, not discovered later.</p></div>
  </div>
</div>`));
console.log('2 more artboards written');
