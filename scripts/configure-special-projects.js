'use strict';

/**
 * configure-special-projects.js
 * ─────────────────────────────────────────────────────────────────────────
 * Applies the per-category UI configurations the project lead defined for
 * the price-list section. These projects either do NOT have a price list at
 * all (resale, sold-out, paused) or have one but ALSO point to an external
 * MLS-style site (UNITS FOR SALE). For all of them, the auto-seeder should
 * NEVER overwrite their config — the seeder respects `priceList.heading`,
 * `priceList.externalUrl`, and `priceList.message`.
 *
 * Categories:
 *   MLS         → priceList = { heading: 'Check Availability on MLS', kind: 'mls' }
 *   UFS         → priceList = { heading: 'UNITS FOR SALE',
 *                               externalUrl: '<from sheet col E>',
 *                               kind: 'ufs' }
 *   SOLD OUT    → priceList = { heading: 'SOLD OUT',          kind: 'sold-out' }
 *   PAUSED      → priceList = { heading: 'PAUSED PROJECT',    kind: 'paused' }
 *   CUSTOM      → priceList = { heading: '<text>',            kind: 'message' }
 *
 * Source of truth for UFS URLs
 * ────────────────────────────
 * The UFS URLs live in a Google Sheet (UFS_URLS_SHEET_ID below) column E
 * "BOTÓN UNITS FOR SALE URL". Column C contains the project URL on the live
 * site (e.g. https://top-projects.millionluxury.com/projects/<slug>) — we
 * parse the slug out of that path rather than fuzzy-matching by name, so
 * ambiguous cases like "Ocean House Surfside" vs "Ocean House South Beach"
 * resolve deterministically.
 *
 * Conflict resolution
 * ───────────────────
 * UFS is applied LAST so any slug that appears in both MLS_SLUGS and the
 * sheet ends up as UFS (the sheet wins). Wipe policy: all existing
 * priceList/priceRange/priceDocs/unitsForSale are REPLACED.
 *
 * Usage
 * ─────
 *   node scripts/configure-special-projects.js          # apply
 *   node scripts/configure-special-projects.js --dry    # preview only
 * ─────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { google } = require('googleapis');

const UFS_URLS_SHEET_ID = '1rogHcsBWK3qVM94NU4fKxKMiYwLUX-mrx4u5ZTNF7rs';

const PROJECTS_JSON = path.join(__dirname, '../data/projects.json');

// ── Category configurations ──────────────────────────────────────────────────
// Each entry is a slug from projects.json. The 8 projects from the project
// lead's list that do NOT exist in projects.json are tracked in MISSING_FROM_JSON
// for the final report. They are intentionally skipped.

const MLS_SLUGS = [
  '1-hotel-homes', '3200-south-ocean', '321-ocean', '5000-north-ocean',
  'adagio-fort-lauderdale', 'arte-surfside', 'asia-brickell',
  'aurora-sunny-isles-beach', 'bal-harbour-tower', 'bayview-village',
  'beach-house-8', 'biltmore-row', 'blue-green-diamond-towers',
  'brickell-city-centre', 'bristol-tower', 'caribbean',
  'chateau-beach-residences', 'elysee-miami', 'glass-miami-beach',
  'il-villaggio', 'jade-beach', 'l-atelier', 'la-santa-maria',
  'missoni-baia', 'monaco-yacht-club-residences', 'monad-terrace',
  'murano-at-portofino', 'murano-grande-at-portofino', 'ocean-delray',
  // Note: Ocean House Surfside (slug: ocean-house) KEEPS its real price list —
  // do NOT add it here. Only the South Beach building is MLS-only.
  'ocean-house-2',  // Ocean House South Beach
  'ocean-park', 'oceanside', 'one-ocean',
  'paramount-fort-lauderdale-beach', 'parque-towers',
  'porsche-design-tower', 'portofino-tower', 'prive-island',
  'south-pointe-towers', 'the-bath-club', 'the-bristol', 'the-fairchild',
  'the-mansions-at-acqualina', // user typo: "The Maisons" → The Mansions
  'the-palace-at-bal-harbour',
  'the-residences-at-the-miami-beach-edition',
  'the-ritz-carlton-residences-bal-harbour', 'turnberry-ocean-colony',
  'villa-valencia', 'w-south-beach-residences',
];

// UFS URLs are now read from the spreadsheet on every run (see fetchUfsUrls).
// To change a URL, edit column E of the sheet and re-run this script.

const CUSTOM_TEXTS = {
  'casa-cipriani': 'No Units Available',
  'the-raleigh':   'No Pricing Available',
};

const SOLD_OUT_SLUGS = []; // all 5 from the user list are missing from projects.json
const PAUSED_SLUGS   = []; // both from the user list are missing from projects.json

// Projects from the list that don't exist in projects.json yet — skipped.
const MISSING_FROM_JSON = [
  { name: 'St Regis Bal Harbour',                         category: 'MLS' },
  { name: '600 Miami World Center',                       category: 'SOLD OUT' },
  { name: 'Aman Miami Beach Residences',                  category: 'SOLD OUT' },
  { name: 'Indian Creek Residences and Yacht Club',       category: 'SOLD OUT' },
  { name: 'La Baia South Bay Harbor',                     category: 'SOLD OUT' },
  { name: 'One Twenty Brickell Residences',               category: 'SOLD OUT' },
  { name: '719 Biltmore',                                 category: 'PAUSED' },
  { name: '7918 West Drive',                              category: 'PAUSED' },
];

// ── UFS URL fetcher ──────────────────────────────────────────────────────────

/**
 * Read column E (BOTÓN UNITS FOR SALE URL) from the source-of-truth sheet
 * and extract the slug from column C (project page URL, where the slug is
 * embedded in the /projects/<slug> path). Returns { slug → url }.
 * Rows without an HTTP URL in col E are silently dropped.
 */
async function fetchUfsUrls() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key:   (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: UFS_URLS_SHEET_ID,
    range: 'Sheet1!A2:E',
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = res.data.values || [];

  const out = {};
  const malformed = [];
  for (const r of rows) {
    const projectUrl = String(r[2] || '');
    const ufsUrl     = String(r[4] || '').trim();
    if (!/^https?:\/\//i.test(ufsUrl)) continue;
    const m = projectUrl.match(/\/projects\/([^/?#]+)/);
    if (!m) { malformed.push({ name: r[1], projectUrl, ufsUrl }); continue; }
    out[m[1]] = ufsUrl;
  }
  return { urls: out, malformed };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const isDry = process.argv.includes('--dry');
  const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));
  const slugToIdx = new Map(projects.map((p, i) => [p.slug, i]));

  console.log('Fetching UFS URLs from sheet…');
  const { urls: ufsUrls, malformed } = await fetchUfsUrls();
  console.log('  → ' + Object.keys(ufsUrls).length + ' UFS URLs loaded');
  if (malformed.length) {
    console.log('  ⚠ ' + malformed.length + ' rows had URL in col E but no slug in col C:');
    malformed.forEach(m => console.log('    -', m.name, '(' + m.projectUrl + ')'));
  }

  const log = { mls: [], ufs: [], soldOut: [], paused: [], custom: [], notFound: [], overrides: [] };

  // Clear any prior unitsForSale field — hybrid mode was removed; UFS is now
  // always a full priceList replacement.
  if (!isDry) {
    for (const p of projects) delete p.unitsForSale;
  }

  function setPriceList(slug, config, category) {
    const i = slugToIdx.get(slug);
    if (i === undefined) {
      log.notFound.push({ slug, category });
      return false;
    }
    if (!isDry) {
      projects[i].priceList = config;
      delete projects[i].priceRange;
      delete projects[i].priceDocs;
    }
    return true;
  }

  // 1. MLS first (UFS will override below if same slug is in the sheet)
  for (const slug of MLS_SLUGS) {
    if (setPriceList(slug, { heading: 'Check Availability on MLS', kind: 'mls' }, 'MLS')) {
      log.mls.push(slug);
    }
  }

  // 2. SOLD OUT
  for (const slug of SOLD_OUT_SLUGS) {
    if (setPriceList(slug, { heading: 'SOLD OUT', kind: 'sold-out' }, 'SOLD OUT')) {
      log.soldOut.push(slug);
    }
  }

  // 3. PAUSED
  for (const slug of PAUSED_SLUGS) {
    if (setPriceList(slug, { heading: 'PAUSED PROJECT', kind: 'paused' }, 'PAUSED')) {
      log.paused.push(slug);
    }
  }

  // 4. CUSTOM
  for (const [slug, text] of Object.entries(CUSTOM_TEXTS)) {
    if (setPriceList(slug, { heading: text, kind: 'message' }, 'CUSTOM')) {
      log.custom.push(slug + ' ("' + text + '")');
    }
  }

  // 5. UFS LAST — sheet wins. If a slug was also in MLS_SLUGS, this overwrites.
  for (const [slug, url] of Object.entries(ufsUrls)) {
    const wasMls = log.mls.includes(slug);
    if (setPriceList(slug, { heading: 'UNITS FOR SALE', externalUrl: url, kind: 'ufs' }, 'UFS')) {
      log.ufs.push(slug);
      if (wasMls) log.overrides.push(slug + ' (MLS → UFS)');
    }
  }

  // ── Report ─────────────────────────────────────────────────────────────
  console.log('\n=== CONFIGURE SPECIAL PROJECTS' + (isDry ? ' [DRY RUN]' : '') + ' ===');
  console.log('MLS banner          :', log.mls.length - log.overrides.length, 'projects (after UFS overrides)');
  console.log('UNITS FOR SALE      :', log.ufs.length, 'projects');
  console.log('SOLD OUT            :', log.soldOut.length, 'projects');
  console.log('PAUSED              :', log.paused.length, 'projects');
  console.log('CUSTOM message      :', log.custom.length, 'projects');
  if (log.overrides.length) {
    console.log('\nUFS overrides (sheet won over hardcoded category):');
    log.overrides.forEach(o => console.log('  -', o));
  }

  if (log.notFound.length) {
    console.log('\n⚠ Slugs not in projects.json (skipped):');
    log.notFound.forEach(n => console.log('  -', n.slug, '(' + n.category + ')'));
  }

  if (MISSING_FROM_JSON.length) {
    console.log('\n⚠ Project names from user list that do NOT exist in projects.json:');
    MISSING_FROM_JSON.forEach(m => console.log('  -', m.name, '(' + m.category + ')'));
    console.log('  → Skipped. Add them to projects.json manually if you want them on the site.');
  }

  if (!isDry) {
    fs.writeFileSync(PROJECTS_JSON, JSON.stringify(projects, null, 2) + '\n', 'utf8');
    // Total = MLS_remaining + UFS + SOLD + PAUSED + CUSTOM (no double counting)
    const total = (log.mls.length - log.overrides.length) + log.ufs.length
                + log.soldOut.length + log.paused.length + log.custom.length;
    console.log('\n✓ Applied configs to ' + total + ' project(s)');
  } else {
    console.log('\n[DRY RUN — no files written]');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
