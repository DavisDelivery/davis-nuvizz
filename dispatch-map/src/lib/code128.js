// code128.js — PURE Code 128 encoder (no DOM, no network). Returns the module
// widths (bar, space, bar, …) so any renderer (pdf-lib, SVG, canvas) can draw it.
// Code sets B (printable ASCII) and C (digit pairs); switches to C for long digit runs.

const PATTERNS = [
  '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
  '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
  '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
  '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
  '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
  '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
  '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
  '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
  '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
  '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
  '114131','311141','411131','211412','211214','211232','2331112',
];
const START_B = 104, START_C = 105, TO_C = 99, TO_B = 100, STOP = 106;

// Count the digit run starting at i.
function digitRun(s, i) { let n = 0; while (i + n < s.length && s[i + n] >= '0' && s[i + n] <= '9') n++; return n; }

/** Encode text to Code 128 symbol values (start … data … check, stop). Throws on non-ASCII. */
export function code128Values(text) {
  const s = String(text ?? '');
  if (!s) throw new Error('empty barcode');
  for (const ch of s) { const c = ch.charCodeAt(0); if (c < 32 || c > 126) throw new Error(`unsupported character ${JSON.stringify(ch)}`); }
  const vals = [];
  let set;
  let i = 0;
  const lead = digitRun(s, 0);
  if (lead >= 4) { set = 'C'; vals.push(START_C); }
  else { set = 'B'; vals.push(START_B); }
  while (i < s.length) {
    if (set === 'C') {
      const run = digitRun(s, i);
      if (run >= 2) { vals.push(Number(s.slice(i, i + 2))); i += 2; continue; }
      vals.push(TO_B); set = 'B'; continue;
    }
    // set B: switch to C only when it saves symbols (a run of >= 6, or >= 4 that ends the string).
    const run = digitRun(s, i);
    if (run >= 6 || (run >= 4 && i + run === s.length)) {
      if (run % 2 === 1) { vals.push(s.charCodeAt(i) - 32); i++; }   // odd run: first digit stays in B
      vals.push(TO_C); set = 'C'; continue;
    }
    vals.push(s.charCodeAt(i) - 32); i++;
  }
  let sum = vals[0];
  for (let k = 1; k < vals.length; k++) sum += vals[k] * k;
  vals.push(sum % 103);
  vals.push(STOP);
  return vals;
}

/** Module widths for the whole symbol (bars and spaces alternate, starting with a bar). */
export function code128Modules(text) {
  const out = [];
  for (const v of code128Values(text)) for (const d of PATTERNS[v]) out.push(Number(d));
  return out;
}

/** Total width in modules, EXCLUDING quiet zones. */
export function code128Width(text) { return code128Modules(text).reduce((a, b) => a + b, 0); }

// Self-check the table: every symbol is 11 modules, the stop is 13.
for (let k = 0; k < PATTERNS.length; k++) {
  const w = [...PATTERNS[k]].reduce((a, d) => a + Number(d), 0);
  if (w !== (k === STOP ? 13 : 11)) throw new Error(`Code 128 table corrupt at ${k}`);
}
