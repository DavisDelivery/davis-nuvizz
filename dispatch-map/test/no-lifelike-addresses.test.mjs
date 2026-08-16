// test/no-lifelike-addresses.test.mjs
//
// Netlify's SECRETS SCANNING greps every file under dispatch-map/ for the VALUES of this
// site's environment variables. Several of those values are email addresses on the company
// domain (NUVIZZ_DAVIS_USER is one, and .env.example says so). So an invented example
// address that happens to equal — or merely CONTAIN — one of them reads as that credential
// committed to the repo, and the deploy dies with "Build script returned non-zero exit
// code: 2" and a line number, nothing else.
//
// This has now broken main's deploy TWICE: v0.54.75 via test/gmail-lib.test.mjs, and again
// via test/customer-comms.test.mjs. Both times every local and CI check was green, because
// the scan runs only inside Netlify's build and needs the site's real env to reproduce —
// see HANDOFF.md, "Trap this release fell into".
//
// Nothing else in this repo can catch that offline. This can: it enforces the rule HANDOFF
// states — fixtures and comments use example.com / example.net / example.org, never a
// plausible real address — by refusing any company-domain address outside a short allowlist
// of ones the app genuinely needs.
//
// Note the domain below is assembled from parts. Spelling it out contiguously would make
// THIS file the thing the scanner trips on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const COMPANY = ['davisdelivery', 'com'].join('.');

// Addresses the product genuinely sends from or replies to. These already ship on main and
// deploy fine, so they are not any env var's value. Keep this list SHORT — every entry is a
// string a future credential could collide with.
const ALLOWED_LOCAL_PARTS = new Set(['customerservice', 'no-reply']);

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.netlify', 'reference']);

function walk(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full));
    else if (/\.(mts|ts|mjs|js|jsx|md|json|html)$/.test(ent.name)) out.push(full);
  }
  return out;
}

test('no file carries a lifelike company email address', () => {
  // Deliberately NOT anchored to a word boundary on the left: the scanner matches on
  // substring, so "xchad@<company>" would collide with "chad@<company>" just the same.
  const re = new RegExp(`([A-Za-z0-9._%+-]+)@${COMPANY.replace('.', '\\.')}`, 'gi');
  const offenders = [];
  for (const file of walk(ROOT)) {
    // .env.example NAMES the variables; it holds no values.
    if (/\.env\.example$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(re)) {
      if (ALLOWED_LOCAL_PARTS.has(m[1].toLowerCase())) continue;
      const line = text.slice(0, m.index).split('\n').length;
      offenders.push(`${relative(ROOT, file)}:${line} — ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [],
    `Company-domain addresses found. Netlify's secrets scan will read one of these as an\n`
    + `env-var value and fail the deploy — with a build-script exit code and nothing else to\n`
    + `go on. Use example.com / example.net / example.org instead, or add the local part to\n`
    + `ALLOWED_LOCAL_PARTS here if the product genuinely needs to send from it:\n  `
    + offenders.join('\n  '));
});

test('the guard actually fires — it is sensitive, not just quiet', () => {
  // A quiet guard that matches nothing is worse than none: it reads as proof. Drive the
  // same regex over a control string to show it catches what broke the deploy.
  const re = new RegExp(`([A-Za-z0-9._%+-]+)@${COMPANY.replace('.', '\\.')}`, 'gi');
  const control = `const to = 'chad@${COMPANY}';`;
  const hits = [...control.matchAll(re)].filter((m) => !ALLOWED_LOCAL_PARTS.has(m[1].toLowerCase()));
  assert.equal(hits.length, 1, 'the guard must catch the exact shape that broke v0.54.75');
  // …and must not flag the addresses the app legitimately ships.
  const ok = `replyTo: 'customerservice@${COMPANY}'`;
  assert.equal([...ok.matchAll(re)].filter((m) => !ALLOWED_LOCAL_PARTS.has(m[1].toLowerCase())).length, 0);
});
