// test/no-lifelike-addresses.test.mjs
//
// Netlify's SECRETS SCANNING greps every file under dispatch-map/ for the VALUES of this
// site's environment variables and fails the deploy on a hit. It has now broken main's
// deploy four times, and each time the only signal was "Build script returned non-zero exit
// code: 2" — every local and CI check green, because the scan runs solely inside Netlify's
// build and reproducing it needs the site's real environment.
//
// HOW IT ACTUALLY WORKS, which took four rounds to pin down and is worth writing once:
//
//   • It matches the env value as a plain SUBSTRING of the file's bytes.
//   • It is CASE-SENSITIVE. This is why the owner's first name, Capitalised, appears
//     hundreds of times in App.jsx and deploys fine, while the same word lower-cased at the
//     front of a fixture address does not. (This comment cannot spell the offending string
//     out — writing it here would trip the scan on this very file. That is not a joke: an
//     earlier draft of this file did exactly that, and was two of the five matches.)
//   • NUVIZZ_DAVIS_USER is a NuVizz LOGIN USERNAME — a short, ordinary word — not an email
//     address, which is what everyone assumed. That is the trap: a short value matches
//     inside strings that look nothing like a credential. An example address built from a
//     real person's first name contains it; changing the DOMAIN to example.com does not
//     help, because the local part is the part that matches.
//
// So the rule for fixtures is not "use example.com". It is: **never build an example address
// out of a real person's name.** Use a role word — ops, inbox, customer, driver, alt.
//
// AND IF IT HAPPENS ANYWAY, do not guess like I did. The failed deploy carries the answer:
//   deploy_validations_report.secret_scan_result
// names the file, the line, and the env KEY for every match. It is one read through the
// Netlify API or MCP (get-deploy with the deploy id), and it turns a multi-round guessing
// game into a thirty-second lookup. Nothing local can substitute for it.
//
// What this file can still enforce mechanically is the narrower rule below. It cannot know
// the secret values — writing one here to test against would BE the bug — so it guards the
// one class it can see: company-domain addresses that the app does not genuinely send from.
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

const addressRe = () => new RegExp(`([A-Za-z0-9._%+-]+)@${COMPANY.replace('.', '\\.')}`, 'gi');

test('no file carries a lifelike company email address', () => {
  const offenders = [];
  for (const file of walk(ROOT)) {
    // .env.example NAMES the variables; it holds no values.
    if (/\.env\.example$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(addressRe())) {
      if (ALLOWED_LOCAL_PARTS.has(m[1].toLowerCase())) continue;
      const line = text.slice(0, m.index).split('\n').length;
      offenders.push(`${relative(ROOT, file)}:${line} — ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [],
    `Company-domain addresses found. Netlify's secrets scan can read one of these as an\n`
    + `env-var value and fail the deploy. Use a ROLE word at example.com — ops@, inbox@,\n`
    + `customer@ — never a person's name, and never the company domain. Add the local part\n`
    + `to ALLOWED_LOCAL_PARTS here only if the product genuinely sends from it:\n  `
    + offenders.join('\n  '));
});

test('the guard actually fires — it is sensitive, not just quiet', () => {
  // A quiet guard that matches nothing is worse than none: it reads as proof. Drive the same
  // matcher over a control string to show it catches what it claims to.
  const control = `const to = 'someone@${COMPANY}';`;
  const hits = [...control.matchAll(addressRe())].filter((m) => !ALLOWED_LOCAL_PARTS.has(m[1].toLowerCase()));
  assert.equal(hits.length, 1, 'the guard must catch a company-domain address');
  // …and must not flag the addresses the app legitimately ships.
  const ok = `replyTo: 'customerservice@${COMPANY}'`;
  assert.equal([...ok.matchAll(addressRe())].filter((m) => !ALLOWED_LOCAL_PARTS.has(m[1].toLowerCase())).length, 0);
});
