'use strict';
/**
 * Find fields whose value carries no information — a lone dash, a dot, "N/A",
 * "TBD" — so the site can drop them instead of rendering an empty row.
 *
 * Read-only by default. Pass --apply to strip them from data/projects.json.
 */

const fs = require('fs');
const path = require('path');

const PROJECTS_JSON = path.join(__dirname, '../data/projects.json');
const APPLY = process.argv.includes('--apply');

// A value says nothing if, once trimmed, it is only punctuation/whitespace or a
// known "no data" token. Kept deliberately tight: "0" and "$0" are real answers,
// and a legitimate value never looks like this.
const NO_INFO_TOKENS = new Set([
  'n/a', 'na', 'n.a', 'n.a.', 'nan', 'none', 'null', 'nil',
  'tbd', 'tba', 'pending', 'no', 'no info', 'no information',
  'sin informacion', 'sin información', 'sin info', 'no aplica',
  '-', '--', '---', '.', '..', '...', '?', '??', 'x',
]);

function isNoInfo(value) {
  if (value === null || value === undefined) return false; // already absent
  if (typeof value !== 'string') return false;
  const t = value.trim();
  if (t === '') return true;
  // only punctuation / dashes / dots / bullets / whitespace
  if (/^[\s\-–—_.·•*,;:/\\|]+$/.test(t)) return true;
  return NO_INFO_TOKENS.has(t.toLowerCase());
}

// Fields the site renders as labelled rows. Only these matter for the bug.
const RENDERED_FIELDS = [
  'theBuilding', 'stylishAmenities', 'address', 'developer', 'architecture',
  'interiorDesign', 'completionDate', 'startingPrice', 'hoa',
  'rentalRestrictions', 'parkingSpaces', 'depositStructure',
];

function classify(value) {
  if (value === null || value === undefined) return null; // nothing to do
  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: 'empty-array' };
    const bad = value.filter(isNoInfo);
    if (bad.length === value.length) return { kind: 'array-all-no-info' };
    if (bad.length > 0) return { kind: 'array-some-no-info', keep: value.filter(v => !isNoInfo(v)) };
    return null;
  }
  if (isNoInfo(value)) return { kind: 'scalar-no-info' };
  return null;
}

const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));
const findings = [];

for (const p of projects) {
  for (const field of RENDERED_FIELDS) {
    const verdict = classify(p[field]);
    if (!verdict) continue;
    findings.push({
      slug: p.slug, name: p.name, field,
      before: JSON.stringify(p[field]),
      kind: verdict.kind,
      keep: verdict.keep,
    });
  }
}

// ── report ──
const byKind = findings.reduce((acc, f) => { (acc[f.kind] ||= []).push(f); return acc; }, {});
console.log(`Scanned ${projects.length} projects across ${RENDERED_FIELDS.length} rendered fields.\n`);
console.log(`Found ${findings.length} field(s) with no information:\n`);
for (const [kind, list] of Object.entries(byKind)) {
  console.log(`── ${kind} (${list.length}) ──`);
  for (const f of list) {
    console.log(`   ${f.name}`);
    console.log(`      ${f.field} = ${f.before}${f.keep ? `   → keep ${JSON.stringify(f.keep)}` : ''}`);
  }
  console.log();
}
const byField = findings.reduce((a, f) => { a[f.field] = (a[f.field] || 0) + 1; return a; }, {});
console.log('per field:', JSON.stringify(byField, null, 1));

if (!APPLY) {
  console.log('\n(dry run — pass --apply to strip these)');
  process.exit(0);
}

// ── apply ──
let changed = 0;
for (const p of projects) {
  for (const field of RENDERED_FIELDS) {
    const verdict = classify(p[field]);
    if (!verdict) continue;
    if (verdict.kind === 'array-some-no-info') {
      p[field] = verdict.keep;
    } else {
      // A field the site should not render at all: null matches how every
      // other absent field in this file is stored.
      p[field] = null;
    }
    changed++;
  }
}
fs.writeFileSync(PROJECTS_JSON, JSON.stringify(projects, null, 2) + '\n', 'utf8');
console.log(`\nApplied: ${changed} field(s) cleared. projects.json written.`);
