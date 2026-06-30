/**
 * sync-sections.js
 * ─────────────────────────────────────────────────────────────
 * ⚠ DESTRUCTIVE — NOT FOR ROUTINE USE.
 *
 * This script REBUILDS data/projects.json from the TP DATA spreadsheet and
 * DELETES any project not listed there. TP DATA is the static catalog of
 * Top/Other Projects and is not the source of truth for which projects
 * exist on the site — projects.json + Drive + Esqueleto are.
 *
 * Historical incident: running this script removed 4 live projects
 * (kempinski, anantara, lilli, the-standard-residences-midtown) that
 * had real content but were missing from TP DATA. They were recovered
 * from git history. Don't repeat that mistake.
 *
 * If you genuinely need to onboard new TP DATA projects, ADD them to
 * TP DATA first, manually verify the spreadsheet is complete, then run:
 *
 *     node scripts/sync-sections.js --i-understand-this-deletes-projects
 *
 * Without that flag this script refuses to run. The automated workflows
 * (sync-pricelists.yml, sync-docs.yml) deliberately do NOT call this.
 *
 * Matching strategy (when allowed to run):
 *   1. Exact `tpDataName` field match
 *   2. Exact case-insensitive normalized name match (strips ®™)
 *   3. Word-overlap score ≥ 0.4 on meaningful words (length ≥ 2)
 *   4. No match → create new stub entry with generated slug
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

// Hard guard — refuse to run without the explicit acknowledgement flag.
// Anyone who actually wants to run this has to opt in by spelling out the
// consequence, which makes accidental invocation (a typo, a missed warning
// in a runbook, an AI agent running automation) impossible.
if (!process.argv.includes('--i-understand-this-deletes-projects')) {
  console.error('');
  console.error('  ⚠  sync-sections.js refused to run.');
  console.error('');
  console.error('  This script DELETES projects from data/projects.json that are');
  console.error('  not listed in the TP DATA spreadsheet. TP DATA is incomplete');
  console.error('  for at least 4 live projects (kempinski, anantara, lilli,');
  console.error('  the-standard-residences-midtown). Running this would remove');
  console.error('  them from the site.');
  console.error('');
  console.error('  If you have manually verified that TP DATA is complete and');
  console.error('  want to proceed anyway, re-run with:');
  console.error('');
  console.error('      node scripts/sync-sections.js --i-understand-this-deletes-projects');
  console.error('');
  process.exit(1);
}

require('dotenv').config();
const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

const PROJECTS_JSON = path.join(__dirname, '../data/projects.json');
const TP_DATA_ID    = process.env.TP_DATA_SPREADSHEET_ID;
const TP_DATA_TAB   = 'TP DATA';

// ── Auth ──────────────────────────────────────────────────────

function makeAuth() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key:   (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    subject: process.env.GOOGLE_IMPERSONATE_EMAIL || undefined,
  });
}

// ── Name utilities ─────────────────────────────────────────────

function toSlug(name, usedSlugs = new Set()) {
  const base = name
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // "é" → "e"
    .replace(/[®™]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // Avoid collisions with already-used slugs
  if (!usedSlugs.has(base)) return base;
  let n = 2;
  while (usedSlugs.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// Words that appear in too many project names to be meaningful for matching.
// Includes real-estate generic terms + South Florida location words.
const STOP = new Set([
  // Articles / prepositions
  'the', 'at', 'by', 'in', 'of', 'and', 'a', 'an', 'for', 'or', 'to',
  // Real-estate generic
  'hotel', 'hotels', 'private', 'residences', 'residence', 'resort',
  'collection', 'collections',
  // Generic structure / geography words
  'bay', 'ocean', 'sea', 'island', 'islands', 'water', 'waterside',
  'tower', 'towers', 'house', 'club', 'garden', 'gardens',
  'harbor', 'harbour', 'shore', 'shores', 'marina', 'row', 'terrace',
  'village', 'district',
  // Common South Florida location words
  'miami', 'beach', 'palm', 'west', 'south', 'north', 'east',
  'fort', 'lauderdale', 'brickell', 'coconut', 'coral', 'gables',
  'pompano', 'aventura', 'surfside', 'wynwood', 'edgewater',
  'midtown', 'downtown', 'grove', 'park',
]);

function normalizeName(s) {
  return s
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[®™]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordSet(name) {
  return new Set(
    normalizeName(name).split(' ').filter(w => w.length >= 2 && !STOP.has(w))
  );
}

// F1 score (harmonic mean of precision and recall) is more robust than
// Jaccard when one project name is a subset of the other (e.g. "Aria Reserve"
// vs "Aria Reserve Miami"). Precision = how much of the TP name appears in
// the existing name; Recall = how much of the existing name appears in TP.
function f1Score(nameA, nameB) {
  const a = wordSet(nameA);
  const b = wordSet(nameB);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const w of a) { if (b.has(w)) common++; }
  const precision = common / a.size;
  const recall    = common / b.size;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

// ── Matcher ────────────────────────────────────────────────────
// Uses exact matching only. Fuzzy matching was removed because hotel/brand
// project names (Ritz-Carlton Naples vs Fort Lauderdale, Rosewood Naples vs
// The Raleigh by Rosewood) share brand words that cause false-positive matches
// that are impossible to distinguish without domain knowledge.
//
// Consequence: stub entries whose TP DATA name doesn't exactly match their
// existing name get a freshly-generated slug. This is acceptable because:
//   a) Those entries have no real data to preserve.
//   b) toSlug(tpDataName) often produces the same slug anyway
//      (e.g. "Andare Residences" → "andare-residences" is identical).
//   c) Entries with real data (619-residences) use the tpDataName field
//      for reliable exact matching.

function findMatch(tpName, existingProjects, claimed) {
  const tpNorm = normalizeName(tpName);

  // Pass 1: exact tpDataName (explicit mapping already set on the entry)
  for (const p of existingProjects) {
    if (claimed.has(p.slug)) continue;
    if (p.tpDataName && p.tpDataName.toLowerCase() === tpName.toLowerCase()) return p;
  }

  // Pass 2: exact normalized name / esqueletoName (strips ® ™, lowercases, strips accents)
  for (const p of existingProjects) {
    if (claimed.has(p.slug)) continue;
    if (normalizeName(p.name) === tpNorm) return p;
    if (p.esqueletoName && normalizeName(p.esqueletoName) === tpNorm) return p;
  }

  return null; // no exact match → caller will create a new entry
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  if (!TP_DATA_ID) {
    console.error('Error: TP_DATA_SPREADSHEET_ID must be set in .env');
    process.exit(1);
  }

  const auth   = makeAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  console.log('Fetching TP DATA…');
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: TP_DATA_ID,
    range: `${TP_DATA_TAB}!A:E`,
  });

  const rows = (res.data.values || []).slice(1); // skip header row

  // Parse TP DATA into canonical project records.
  // Column A = Sección, B = Proyecto, C = Starting Price, D = The Building, E = Stylish Amenities
  const tpProjects = rows
    .filter(r => r[0] && r[1]) // need both section and name
    .map(r => ({
      section:         r[0].trim() === 'Top Projects' ? 'Top Projects' : 'Other Projects',
      tpDataName:      r[1].trim(),
      startingPrice:   (r[2] || '').trim() || null,
      theBuilding:     (r[3] || '').trim() || null,
      stylishAmenities:(r[4] || '').trim() || null,
    }));

  console.log(`  Found ${tpProjects.length} projects in TP DATA`);
  console.log(`  Top Projects: ${tpProjects.filter(p => p.section === 'Top Projects').length}`);
  console.log(`  Other Projects: ${tpProjects.filter(p => p.section === 'Other Projects').length}`);

  // Load existing projects.json
  const existing = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));
  console.log(`\nExisting projects.json: ${existing.length} entries`);

  const claimed  = new Set();  // slugs already matched to a TP DATA entry
  // usedSlugs tracks only slugs that end up in the final result.
  // Do NOT pre-populate with all existing slugs — entries not matched by
  // any TP DATA project will be dropped, freeing their slugs for reuse.
  const usedSlugs = new Set();
  const result   = [];
  let created = 0, updated = 0;

  for (const tp of tpProjects) {
    const match = findMatch(tp.tpDataName, existing, claimed);

    if (match) {
      claimed.add(match.slug);
      usedSlugs.add(match.slug); // reserve the slug in the final result
      updated++;

      // Merge: TP DATA fields win for section/tpDataName/TP content.
      // All other existing fields (slug, esqueletoName, address, contact, etc.) are preserved.
      result.push({
        ...match,
        tpDataName:       tp.tpDataName,
        section:          tp.section,
        // Only update startingPrice if TP DATA has a value
        startingPrice:    tp.startingPrice || match.startingPrice || null,
        // theBuilding: prefer TP DATA (new canonical field), fall back to old buildingDescription
        theBuilding:      tp.theBuilding || match.theBuilding || match.buildingDescription || null,
        stylishAmenities: tp.stylishAmenities || match.stylishAmenities || null,
      });

      if (normalizeName(match.name) !== normalizeName(tp.tpDataName)) {
        console.log(`  ~ Matched: "${tp.tpDataName}" → slug "${match.slug}" (was "${match.name}")`);
      }
    } else {
      // No match — create a new stub entry with a collision-safe slug
      created++;
      const slug = toSlug(tp.tpDataName, usedSlugs);
      usedSlugs.add(slug);
      console.log(`  + New: "${tp.tpDataName}" → slug "${slug}"`);
      result.push({
        slug,
        name:             tp.tpDataName,
        tpDataName:       tp.tpDataName,
        section:          tp.section,
        startingPrice:    tp.startingPrice,
        thumbnail:        null,
        hero:             null,
        theBuilding:      tp.theBuilding,
        stylishAmenities: tp.stylishAmenities,
        brochures:        [],
      });
    }
  }

  // Report dropped entries (were in JSON but not in TP DATA)
  for (const p of existing) {
    if (!claimed.has(p.slug)) {
      console.log(`  - Removed (not in TP DATA): "${p.name}" (slug: "${p.slug}")`);
    }
  }

  // Sort: Top Projects (alpha by name) → Other Projects (alpha by name)
  result.sort((a, b) => {
    if (a.section !== b.section) {
      return a.section === 'Top Projects' ? -1 : 1;
    }
    return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  });

  fs.writeFileSync(PROJECTS_JSON, JSON.stringify(result, null, 2) + '\n', 'utf8');

  console.log(`\n✓ Done`);
  console.log(`  ${updated} matched & updated`);
  console.log(`  ${created} new entries created`);
  console.log(`  Top Projects: ${result.filter(p => p.section === 'Top Projects').length}`);
  console.log(`  Other Projects: ${result.filter(p => p.section === 'Other Projects').length}`);
  console.log(`  Total: ${result.length}`);
  console.log('\nNext: git add data/projects.json && git commit -m "chore: sync sections from TP DATA"');
}

main().catch(err => { console.error(err); process.exit(1); });
