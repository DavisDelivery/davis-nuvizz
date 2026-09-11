// src/lib/write-error.js — making a NuVizz write refusal READABLE (PURE).
//
// Chad, Sep 10 2026, on a ＋ New route that failed: "Route Creation still not working from
// our system go to devloper api from nuvizz and figure out what you are doing wrong."
//
// What the screen actually showed him was this, and nothing else:
//
//   ✗ Steven Adjenty: createRoute: Internal Server Error: {"reasons":[{"description":
//   "<DeliverItLoadResponse xmlns=\"http://schemas.nuvizzards.com/schemas/di/
//   response\">\n<DocumentID>UNKNOWN</DocumentID>\n<Status
//   >99</Status>\n<Errors class=\"java.util.ArrayList\">
//
// Every character of that is envelope. NuVizz's own account of what it objected to is in the
// <Errors> list, which is the NEXT thing in the string — and it never arrived, because
// firstError() cut the message at 300 characters (fixed in the same change as this file).
// Even untruncated it would have been three layers of wrapping around one sentence: an HTTP
// envelope, around a JSON `reasons` array, around a JSON-escaped XML document.
//
// THE LOGISTICS TEST THIS FILE HAS TO PASS. A dispatcher at 6am with a truck waiting is not
// going to read a java.util.ArrayList. They need one line telling them whether this is theirs
// to fix (a bad address, an order already on another load) or ours. So: lead with the
// vendor's own words, keep the envelope for the write log, and NEVER silently drop text —
// a clip that doesn't say it clipped is what cost the whole of Sep 9.
//
// PURE and framework-free so it can be tested directly; the screen only renders what it returns.

/** Vendor text arrives double-encoded: the XML was JSON-escaped, and (on this tenant) the
 *  escapes survive into the string we display. Turn \\uXXXX / \\n / \\t / \\" back into
 *  characters so the XML can be read at all. Never throws; a value that isn't a string
 *  comes back as ''. */
export function decodeVendorText(raw) {
  let s = typeof raw === 'string' ? raw : (raw == null ? '' : String(raw));
  if (!s) return '';
  // \uXXXX first — it is what hides the angle brackets, and decoding it can reveal \n.
  s = s.replace(/\\u([0-9a-fA-F]{4})/g, (m, hex) => {
    const code = parseInt(hex, 16);
    return Number.isFinite(code) ? String.fromCharCode(code) : m;
  });
  return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

const XML_ENTITIES = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };
const unentity = (s) => String(s).replace(/&(?:lt|gt|amp|quot|apos);/g, (m) => XML_ENTITIES[m] || m);

/** Every non-empty leaf text node inside `xml`, in document order. Deliberately tolerant:
 *  this repo has never seen the inside of a NuVizz <Errors> list, and the element names are
 *  not in the shipped OpenAPI document (grep: it does not mention DeliverItLoadResponse at
 *  all). So we do not guess at <Error>/<Message>/<Description> — we take whatever text the
 *  list actually contains. Guessing a tag name would silently show nothing on the day it
 *  matters, which is the failure mode this whole file exists to end. */
function leafTexts(xml) {
  const out = [];
  const re = /<([A-Za-z_][\w.:-]*)\b[^>]*>([^<]*)<\/\1>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const text = unentity(m[2]).trim();
    if (text) out.push({ tag: m[1], text });
  }
  return out;
}

/**
 * PURE. Pull the readable complaint out of a NuVizz rejection, however it is wrapped.
 * Returns null when there is nothing vendor-shaped to find — the caller then shows the
 * original text unchanged rather than an empty box.
 *
 * { documentId, status, errors: string[], headline } where `headline` is the one line worth
 * putting in front of a dispatcher. `errors` is every text node inside the <Errors> list.
 */
export function summarizeVendorError(raw) {
  const text = decodeVendorText(raw);
  if (!text || !/<\s*DeliverIt\w*Response/i.test(text)) return null;
  const tagText = (name) => {
    const m = new RegExp(`<${name}\\b[^>]*>([^<]*)</${name}>`, 'i').exec(text);
    return m ? unentity(m[1]).trim() : null;
  };
  const documentId = tagText('DocumentID');
  const status = tagText('Status');
  // Everything from <Errors …> to its close (or to the end, if the text was cut short).
  const block = /<Errors\b[^>]*>([\s\S]*?)(?:<\/Errors>|$)/i.exec(text);
  const errors = block
    ? leafTexts(block[1]).map((n) => (/^(?:message|description|errorLiteral|msg|reason|text)$/i.test(n.tag) ? n.text : `${n.tag}: ${n.text}`))
    : [];
  // De-dupe: a Java error list often repeats the same sentence per offending element, and
  // fourteen identical lines is not fourteen problems.
  const unique = [...new Set(errors)];
  const headline = unique.length
    ? unique.slice(0, 3).join(' · ') + (unique.length > 3 ? ` (+${unique.length - 3} more)` : '')
    : (block
      // The list was there and we could read nothing out of it — say exactly that, because
      // "no errors" and "errors we could not parse" are opposite instructions to the reader.
      ? `NuVizz rejected it and its error list could not be read${status ? ` (Status ${status})` : ''} — the full text is in the write log`
      : null);
  if (!headline) return null;
  return { documentId, status, errors: unique, headline };
}

/** The maximum a toast should carry. Long enough for a real vendor sentence, short enough
 *  to read on a phone at the dock. */
export const TOAST_MAX = 400;

/**
 * PURE. What to actually show: the vendor's own complaint when we can find it, else the raw
 * text — clipped, and SAYING SO when it clips, with where the rest lives.
 *
 * The marker is the load-bearing part. The Sep 9/10 error looked complete on screen; nothing
 * indicated 300 characters had been cut, so the missing half was never looked for.
 */
export function clipForToast(raw, max = TOAST_MAX) {
  const original = raw == null ? '' : String(raw);
  const summary = summarizeVendorError(original);
  const shown = summary ? `NuVizz refused it — ${summary.headline}` : original;
  if (shown.length <= max) return shown;
  return `${shown.slice(0, max)}… [cut — full text in the write log: nuvizz-write-log?op=newRoute&status=failed]`;
}
