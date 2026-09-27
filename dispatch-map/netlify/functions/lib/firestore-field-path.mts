// lib/firestore-field-path.mts — writing ONE ENTRY of a map field, the way Firestore reads it.
//
// PURE. No network, no imports: the request shape only, so it can be tested on its own.
//
// WHY THIS EXISTS (audit 2026-09-27). A Firestore PATCH carries two things that spell field
// names differently. In the body's `fields` map a key is a literal field NAME: "items.k" there
// is one top-level field whose name contains a dot. In updateMask.fieldPaths the same string
// is a PATH, items → k. Writing { 'items.k': v } through updateDocFields therefore sent a body
// with no `items` map and a mask naming a nested path the body did not contain — which
// Firestore applies as a delete. The problem-address queue's "Wave off" did exactly that, and
// answered { ok: true, dismissed: true } while nothing was stored.
//
// The shape Firestore wants (and the one its own client SDK sends for update(ref, {'a.b': v}))
// is a NESTED body — { items: { k: v } } — with the dotted path in the mask. Segments that are
// not plain identifiers are backtick-quoted, or a key such as "mis_split__avrt-0028093763"
// (a sanitised PRO carries hyphens) is not a valid path segment at all.

const SIMPLE_SEGMENT = /^[A-Za-z_][A-Za-z_0-9]*$/;

/** PURE. One field-path segment: bare when it is a simple identifier, otherwise backtick-quoted
 *  with backslash and backtick escaped. */
export function quoteFieldPathSegment(seg: string): string {
  const s = String(seg);
  if (SIMPLE_SEGMENT.test(s)) return s;
  return `\`${s.replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``;
}

/**
 * PURE. The body and the mask for "set `top`'s fields, and set map[key] = value", touching
 * nothing else on the document — not the map's other entries, not any other field.
 *
 * `value` null stores a null (the reader treats it as absent); it does not delete the entry.
 */
export function mapEntryPatch(top: Record<string, any>, mapField: string, key: string, value: any): { data: Record<string, any>; fieldPaths: string[] } {
  const t = top || {};
  return {
    data: { ...t, [mapField]: { [key]: value } },
    fieldPaths: [
      ...Object.keys(t).map(quoteFieldPathSegment),
      `${quoteFieldPathSegment(mapField)}.${quoteFieldPathSegment(key)}`,
    ],
  };
}
