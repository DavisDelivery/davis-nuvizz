// THE PLACE-MARK AND FORKLIFT ARTWORK — drawn once, reused in every form.
//
// Approved on a mockup (Chad, Sep 2026). Every glyph is authored in the 28×28 viewBox the
// disc markers use, centred on 14,14 (the forklift on 14.3,14), and every OTHER size is a
// transform of that one drawing: the badge in a corner, the badge on a restriction cluster,
// the slate glyph on a muted pin. One drawing means a school on a route pin and a school on a
// resting dot cannot drift into two different schools.
//
// Each glyph has two paints: the FILL (the shape) and the CUT (the door, the board edge, the
// wheel hubs) — the cut is painted in the colour UNDER the glyph, so it reads as a hole.
//
// PURE string builders; App.jsx composes them into the marker SVG and the legend swatches.

export const GLYPH_INK_ON_LIME = '#1f2937';   // lime on white is too faint for a detailed shape
export const GLYPH_MUTED = '#64748b';         // slate, on the planned-muted ring
export const BADGE_GROUND = '#0f172a';        // the same dark ground as the PU and count badges
export const FORKLIFT_BADGE_LIME = '#32CD32'; // the forklift on its badge wears the lime itself

// fill = the shape, cut = the colour under it.
function house(fill, cut) {
  return `<path d="M14 7.6 L7.6 13.4 H9.4 V20.2 H18.6 V13.4 H20.4 Z" fill="${fill}"/>`
    + `<rect x="12.6" y="16.2" width="2.8" height="4" fill="${cut}"/>`;
}
function school(fill, cut) {
  return `<path d="M9.7 13.9 V17.6 C11.3 19.3 16.7 19.3 18.3 17.6 V13.9 L14 16 Z" fill="${fill}"/>`
    + `<path d="M14 8.6 L21.3 12.2 L14 15.8 L6.7 12.2 Z" fill="${fill}" stroke="${cut}" stroke-width="0.9" stroke-linejoin="round"/>`
    + `<line x1="19.8" y1="12.7" x2="19.8" y2="16.9" stroke="${fill}" stroke-width="1.1" stroke-linecap="round"/>`
    + `<circle cx="19.8" cy="17.6" r="0.95" fill="${fill}"/>`;
}
function church(fill, cut) {
  return `<path d="M14 6.4 L16.3 10.8 V12.9 L19.8 15.3 V20.6 H8.2 V15.3 L11.7 12.9 V10.8 Z" fill="${fill}"/>`
    + `<path d="M12.8 20.6 V17.9 Q14 16.2 15.2 17.9 V20.6 Z" fill="${cut}"/>`;
}
function government(fill) {
  return `<path d="M14 7 L21.2 11.1 H6.8 Z" fill="${fill}"/>`
    + `<rect x="7.6" y="11.7" width="12.8" height="1.3" fill="${fill}"/>`
    + `<rect x="8.7" y="13.6" width="2.2" height="4.8" fill="${fill}"/>`
    + `<rect x="12.9" y="13.6" width="2.2" height="4.8" fill="${fill}"/>`
    + `<rect x="17.1" y="13.6" width="2.2" height="4.8" fill="${fill}"/>`
    + `<rect x="6.8" y="19" width="14.4" height="1.6" fill="${fill}"/>`;
}
function forklift(fill, cut) {
  return `<path d="M8.8 12.6 V8.8 H16.1 V10.1 H10.1 V12.6 Z" fill="${fill}"/>`
    + `<path d="M6.8 17.8 V13.6 Q6.8 12.4 8 12.4 H16.4 V17.8 Z" fill="${fill}"/>`
    + `<rect x="16.9" y="7.2" width="1.7" height="12.4" fill="${fill}"/>`
    + `<rect x="16.9" y="18.2" width="4.9" height="1.4" fill="${fill}"/>`
    + `<circle cx="9.4" cy="18.6" r="2.2" fill="${fill}"/>`
    + `<circle cx="14.4" cy="18.6" r="2.2" fill="${fill}"/>`
    + `<circle cx="9.4" cy="18.6" r="0.8" fill="${cut}"/>`
    + `<circle cx="14.4" cy="18.6" r="0.8" fill="${cut}"/>`;
}

const DRAW = { residential: house, school, church, government, forklift };
export const GLYPH_KINDS = Object.keys(DRAW);

/** The glyph's own markup in the 28×28 space — no transform. Unknown kind → ''. */
export function glyphMarkup(kind, fill, cut) {
  const f = DRAW[kind];
  return f ? f(fill, cut) : '';
}

/** CENTRE: the glyph replaces the white centre dot of a 28×28 disc. */
export function glyphCenter(kind, fill, cut) {
  const g = glyphMarkup(kind, fill, cut);
  return g ? `<g data-glyph="${kind}" data-form="center">${g}</g>` : '';
}

/**
 * BADGE: a dark disc in a corner of the 28×28 disc, the glyph small and white on it.
 * Place marks sit bottom right (21.5, 21.5); the forklift sits bottom left (6.5, 21.5) — the
 * free corner, since PU is top left and the co-located count top right.
 */
export function glyphBadge(kind, { corner = 'br', fill = '#ffffff' } = {}) {
  const g = glyphMarkup(kind, fill, BADGE_GROUND);
  if (!g) return '';
  const cx = corner === 'bl' ? 6.5 : 21.5;
  const cy = 21.5;
  const ox = kind === 'forklift' ? 14.3 : 14;
  return `<g data-glyph="${kind}" data-form="badge" data-corner="${corner}">`
    + `<circle cx="${cx}" cy="${cy}" r="6.5" fill="${BADGE_GROUND}" stroke="#ffffff" stroke-width="1.4"/>`
    + `<g transform="translate(${cx} ${cy}) scale(0.44) translate(-${ox} -14)">${g}</g></g>`;
}

/** MUTED: slate glyph in place of the centre dot of the planned-muted ring; cut-outs white. */
export function glyphMuted(kind) {
  const g = glyphMarkup(kind, GLYPH_MUTED, '#ffffff');
  return g ? `<g data-glyph="${kind}" data-form="muted"><g transform="translate(14 14) scale(0.8) translate(-14 -14)">${g}</g></g>` : '';
}

/**
 * RESTRICTION CLUSTER: a larger badge (r 8.5, stroke 2) at the bottom right of the cluster's
 * LAST disc, glyph at 0.7. (cx, cy, r) is that disc; the badge is tucked inside its bounding
 * box so the cluster's viewBox never has to grow.
 */
export function glyphClusterBadge(kind, cx, cy, r) {
  const g = glyphMarkup(kind, '#ffffff', BADGE_GROUND);
  if (!g) return '';
  const bx = cx + r - 9.5;
  const by = cy + r - 9.5;
  return `<g data-glyph="${kind}" data-form="cluster">`
    + `<circle cx="${bx}" cy="${by}" r="8.5" fill="${BADGE_GROUND}" stroke="#ffffff" stroke-width="2"/>`
    + `<g transform="translate(${bx} ${by}) scale(0.7) translate(-14 -14)">${g}</g></g>`;
}
