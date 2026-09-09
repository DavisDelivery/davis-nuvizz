import fs from 'fs';

// ── one visual system, duplicated into each sandboxed artboard ──────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{background:#faf9f7;color:#1c1917;font-family:'IBM Plex Sans',system-ui,sans-serif;font-size:14px;-webkit-text-size-adjust:100%}
a{color:#1e5b92}a:hover{color:#16456e}
.pad{padding:44px 48px}
h1{font-family:'Instrument Serif',Georgia,serif;font-size:44px;font-weight:400;line-height:1.05;letter-spacing:-.01em}
h2{font-family:'Instrument Serif',Georgia,serif;font-size:27px;font-weight:400;line-height:1.15;margin-bottom:6px}
.kicker{font-size:10px;font-weight:600;letter-spacing:.13em;text-transform:uppercase;color:#1e5b92;margin-bottom:13px}
.lede{font-size:16px;line-height:1.55;color:#44403c;max-width:62ch}
.note{font-size:12.5px;line-height:1.55;color:#78716c;max-width:70ch}
.rule{height:1px;background:#e7e5e4;margin:26px 0}
.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px}
.grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}
.card{background:#fff;border:1px solid #e7e5e4;border-radius:9px;padding:18px 20px}
.card h3{font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#1c1917;margin-bottom:9px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#57534e}
.tag{display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;padding:3px 8px;border-radius:5px}
.tag.no{background:#fee2e2;color:#991b1b}.tag.yes{background:#dcfce7;color:#166534}.tag.chk{background:#e0e7ff;color:#3730a3}
.stat{display:flex;flex-direction:column;gap:3px}
.stat b{font-family:'Instrument Serif',Georgia,serif;font-size:36px;font-weight:400;line-height:1}
.stat span{font-size:11.5px;color:#78716c;line-height:1.35}
/* ── verbatim app vocabulary (App.jsx) ── */
.app{background:#fff;border:1px solid #cbd5e1;border-radius:9px;overflow:hidden;font-family:system-ui,-apple-system,sans-serif}
.app .bar{background:#1e5b92;color:#fff;padding:7px 16px;font-size:11px;font-weight:600;display:flex;justify-content:space-between}
.app .in{padding:11px 16px}
.cap{font-size:11px;font-weight:600;text-transform:uppercase;color:#64748b;letter-spacing:.01em}
.sum{font-size:15px;font-weight:500;color:#1e293b}
.li{font-size:13px;line-height:1.375;margin-bottom:5px}
.lr{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.nm{min-width:0;flex:1;overflow-wrap:break-word;color:#1e293b}
.qt{flex-shrink:0;color:#64748b;white-space:nowrap;text-align:right;font-size:12px}
.sku{font-size:10px;font-family:ui-monospace,Menlo,monospace;color:#94a3b8}
.Lchip{margin-left:4px;padding:0 4px;border-radius:4px;background:#fef3c7;color:#92400e;font-size:9px;font-weight:600;vertical-align:middle}
.mkline{display:flex;align-items:center;gap:5px;margin-top:2px}
.mktxt{font:700 10px system-ui;color:#111827}
`;

// the recommended mark, one definition used everywhere
const MARK = (px, mono) => `<svg width="${px}" height="${px}" viewBox="0 0 14 14" role="img" aria-label="Heavy piece"><title>Heavy piece</title><circle cx="7" cy="7" r="7" fill="${mono ? '#000' : '#111827'}" stroke="#fff" stroke-width="1.5"/><rect x="1.9" y="4.1" width="2.4" height="5.8" rx=".6" fill="#fff"/><rect x="9.7" y="4.1" width="2.4" height="5.8" rx=".6" fill="#fff"/><rect x="4.3" y="6.1" width="5.4" height="1.8" fill="#fff"/></svg>`;
const ALT = (px) => `<svg width="${px}" height="${px}" viewBox="0 0 14 14"><circle cx="7" cy="7" r="7" fill="#111827" stroke="#fff" stroke-width="1.5"/><rect x="5.8" y="1.9" width="2.4" height="4.2" fill="#fff"/><path d="M7 9.5 3.2 5.5h7.6z" fill="#fff"/><rect x="2.3" y="10.6" width="9.4" height="1.7" rx=".4" fill="#fff"/></svg>`;

const wrap = (body) => `<!doctype html>
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

const ITEMS = [
  ['VINYL BAGS', '020475-11 , SEQ# 4', '1 CTN · 39 Lbs'],
  ['PLASTIC WATER COOLERS', '053125-05 , SEQ# 5', '1 CTN · 31 Lbs'],
  ['KNIVES', '101025-08 , SEQ# 7', '1 CTN · 2 Lbs'],
  ['PALLET STRETCH WRAP 15PCF', '156830-08 , SEQ# 6', '1 CTN · 31 Lbs'],
  ['MISC', '187645-05 , SEQ# 1', '3 CTN · 55 Lbs'],
  ['HYDRAULIC STACKER', '190235-07 , SEQ# 3', '1 UNT · 1259 Lbs'],
  ['PLATFORM TRUCK', '192400-00 , SEQ# 2', '2 UNT · 348 Lbs'],
];
const row = (r, mark) => `<div class="li"><div class="lr"><span class="nm">${r[0]}</span><span class="qt">${r[2]}</span></div><div class="sku">${r[1]}</div>${mark ? `<div class="mkline">${MARK(13)}<b class="mktxt">1,259 lb in ONE piece · dock or forklift</b></div>` : ''}</div>`;

export { CSS, MARK, ALT, wrap, ITEMS, row };
