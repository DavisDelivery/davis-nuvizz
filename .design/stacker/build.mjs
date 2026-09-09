import fs from 'fs';

// THE MARK — Chad's call: bright yellow #facc15, dark H.
// Dark rather than white because App.jsx:2955 readableTextColor() returns #1f2937 for
// any fill with luminance > 0.6; #facc15 is 0.77. White washes out at row size.
export const YELLOW = '#facc15';
export const INK = '#1f2937';
export const H = (px) => `<svg width="${px}" height="${px}" viewBox="0 0 14 14" role="img" aria-label="Hydraulic stacker"><title>Hydraulic stacker</title><circle cx="7" cy="7" r="7" fill="${YELLOW}" stroke="#fff" stroke-width="1.5"/><text x="7" y="9.85" font-family="system-ui,-apple-system,sans-serif" font-size="8.5" font-weight="700" fill="${INK}" text-anchor="middle" textLength="6.2" lengthAdjust="spacingAndGlyphs">H</text></svg>`;
export const H_WHITE = (px) => `<svg width="${px}" height="${px}" viewBox="0 0 14 14"><circle cx="7" cy="7" r="7" fill="${YELLOW}" stroke="#fff" stroke-width="1.5"/><text x="7" y="9.8" font-family="system-ui" font-size="8.5" font-weight="700" fill="#fff" text-anchor="middle">H</text></svg>`;

export const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Instrument+Serif&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{background:#faf9f7;color:#1c1917;font-family:'IBM Plex Sans',system-ui,sans-serif;font-size:14px;-webkit-text-size-adjust:100%}
a{color:#1e5b92}a:hover{color:#16456e}
.pad{padding:40px 44px}
h1{font-family:'Instrument Serif',Georgia,serif;font-size:40px;font-weight:400;line-height:1.08}
h2{font-family:'Instrument Serif',Georgia,serif;font-size:25px;font-weight:400;margin-bottom:6px}
.kicker{font-size:10px;font-weight:600;letter-spacing:.13em;text-transform:uppercase;color:#1e5b92;margin-bottom:12px}
.note{font-size:12.5px;line-height:1.55;color:#78716c;max-width:66ch}
.rule{height:1px;background:#e7e5e4;margin:24px 0}
.card{background:#fff;border:1px solid #e7e5e4;border-radius:9px;padding:16px 18px}
.card h3{font-size:11.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;margin-bottom:8px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#57534e}
.sz{font:400 9px ui-monospace,monospace;color:#94a3b8;margin-top:4px;text-align:center}
/* ── the real app, lifted from dispatch-map/src/App.jsx ── */
.card-app{background:#fff;border:1px solid #cbd5e1;border-radius:10px;overflow:hidden;font-family:system-ui,-apple-system,sans-serif}
.hd{background:#1e5b92;color:#fff;padding:10px 16px}
.hd .r1{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;opacity:.9}
.hd .biz{font-weight:700;font-size:16px;margin-top:2px}
.copy{background:rgba(255,255,255,.22);border-radius:4px;font-size:10px;padding:1px 6px}
.stepper{padding:12px 16px;border-bottom:1px solid #e2e8f0;background:#fff}
.track{height:2px;background:#e2e8f0;position:relative;margin:0 6px 6px}
.track i{position:absolute;top:-3px;width:8px;height:8px;border-radius:50%;background:#cbd5e1}
.track i.on{background:#16a34a}
.steps{display:flex;justify-content:space-between;font-size:10px;color:#64748b}
.banner{margin:10px 16px;padding:7px 10px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;font-size:11.5px;color:#166534}
.sec{padding:10px 16px}
.cap{font-size:10px;font-weight:600;text-transform:uppercase;color:#64748b;letter-spacing:.02em}
.addr{font-size:13px;color:#1e293b;line-height:1.4}
.btns{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;padding:0 16px 10px}
.btn{border:1px solid #e2e8f0;border-radius:8px;padding:7px 2px;font-size:10px;color:#334155;display:flex;flex-direction:column;align-items:center;gap:3px}
.sum{font-size:15px;font-weight:500;color:#1e293b}
.li{font-size:13px;line-height:1.375;margin-bottom:5px}
.lr{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.nm{min-width:0;flex:1;overflow-wrap:break-word;color:#1e293b}
.qt{flex-shrink:0;color:#64748b;white-space:nowrap;text-align:right;font-size:12px}
.sku{font-size:10px;font-family:ui-monospace,Menlo,monospace;color:#94a3b8}
.notebox{border:1px solid #e2e8f0;border-radius:6px;padding:7px 9px;margin-bottom:6px}
.notebox b{font-size:12px;color:#1e293b;font-weight:600}
.notebox span{display:block;font-size:9.5px;color:#94a3b8;margin-top:3px}
`;

export const wrap = (body) => `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <style>${CSS}</style>
</helmet>
${body}
</x-dc>
</body>
</html>
`;

// The seven real lines from PRO 007173855.
export const ITEMS = [
  ['VINYL BAGS', '020475-11 , SEQ# 4', '1 CTN · 39 Lbs', false],
  ['PLASTIC WATER COOLERS', '053125-05 , SEQ# 5', '1 CTN · 31 Lbs', false],
  ['KNIVES', '101025-08 , SEQ# 7', '1 CTN · 2 Lbs', false],
  ['PALLET STRETCH WRAP 15PCF', '156830-08 , SEQ# 6', '1 CTN · 31 Lbs', false],
  ['MISC', '187645-05 , SEQ# 1', '3 CTN · 55 Lbs', false],
  ['HYDRAULIC STACKER', '190235-07 , SEQ# 3', '1 UNT · 1259 Lbs', true],
  ['PLATFORM TRUCK', '192400-00 , SEQ# 2', '2 UNT · 348 Lbs', false],
];
export const rows = () => ITEMS.map(([n, s, q, flag]) =>
  `<div class="li"><div class="lr"><span class="nm">${n}${flag ? ' ' + H(13) : ''}</span><span class="qt">${q}</span></div><div class="sku">${s}</div></div>`).join('');

// The stop card as it really is, at a given row width.
export const stopCard = (w) => `
<div class="card-app" style="width:${w + 32}px">
  <div class="hd"><div class="r1"><span>PRO 007173855</span><span class="copy">copy</span><span style="margin-left:auto;font-weight:500">MANDI · stop 7</span></div><div class="biz">SHARPS MWS</div></div>
  <div class="stepper"><div class="track"><i class="on" style="left:0"></i><i style="left:50%"></i><i style="right:0"></i></div><div class="steps"><span>Scheduled</span><span>Out for delivery</span><span>Delivered</span></div></div>
  <div class="banner">● Tractor has delivered here — last Aug 18, 2026</div>
  <div class="sec"><div class="cap">Address</div><div class="addr">315 BELL PARK DR<br>WOODSTOCK, GA 30188</div></div>
  <div class="sec" style="padding-top:0"><div class="cap">Customer #</div><div class="addr" style="font-size:12px">MARIA GONZALEZ · <span style="color:#1d4ed8">(800) 772-5657</span></div></div>
  <div class="btns">
    <div class="btn">Text</div><div class="btn">Call</div><div class="btn">Navigate</div><div class="btn">Ticket</div>
  </div>
  <div class="sec" style="border-top:1px solid #f1f5f9">
    <div class="cap">Items (7)</div>
    <div class="sum">4 pallets · 4 pieces · 1765 Lbs</div>
    <div style="border-top:1px solid #f1f5f9;margin-top:7px;padding-top:7px">${rows()}</div>
  </div>
  <div class="sec" style="border-top:1px solid #f1f5f9">
    <div class="cap" style="margin-bottom:5px">Notes</div>
    <div class="notebox"><b>NO STRAIGHT TRUCK OR LIFT</b><span>Order instructions — INTG ULINE · Sep 8, 10:35 PM</span></div>
    <div class="notebox"><b>GATE! MUST SHIP UPRIGHT.</b><span>Order instructions — INTG ULINE · Sep 8, 10:35 PM</span></div>
  </div>
</div>`;
