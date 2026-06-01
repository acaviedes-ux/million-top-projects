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
 *                               externalUrl: '<from esqueleto col AM>',
 *                               kind: 'ufs' }
 *   SOLD OUT    → priceList = { heading: 'SOLD OUT',          kind: 'sold-out' }
 *   PAUSED      → priceList = { heading: 'PAUSED PROJECT',    kind: 'paused' }
 *   CUSTOM      → priceList = { heading: '<text>',            kind: 'message' }
 *   HYBRID      → priceList unchanged + unitsForSale: { externalUrl }
 *                 (only Five Park Miami Beach)
 *
 * Wipe policy: all existing priceList/priceRange/priceDocs are REPLACED for
 * categories MLS, UFS, SOLD-OUT, PAUSED, CUSTOM. The HYBRID category keeps
 * its existing priceList and only adds the unitsForSale field.
 *
 * URLs are baked in below — pulled once from the esqueleto sheet column AM
 * (Website Million). Re-run only when those URLs change.
 *
 * Usage
 * ─────
 *   node scripts/configure-special-projects.js          # apply
 *   node scripts/configure-special-projects.js --dry    # preview only
 * ─────────────────────────────────────────────────────────────────────────
 */

const fs   = require('fs');
const path = require('path');

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
  'ocean-house', 'ocean-park', 'oceanside', 'one-ocean',
  'paramount-fort-lauderdale-beach', 'parque-towers',
  'porsche-design-tower', 'portofino-tower', 'prive-island',
  'south-pointe-towers', 'the-bath-club', 'the-bristol', 'the-fairchild',
  'the-mansions-at-acqualina', // user typo: "The Maisons" → The Mansions
  'the-palace-at-bal-harbour',
  'the-residences-at-the-miami-beach-edition',
  'the-ritz-carlton-residences-bal-harbour', 'turnberry-ocean-colony',
  'villa-valencia', 'w-south-beach-residences',
];

// UFS map: slug → external URL (from esqueleto col AM)
const UFS_URLS = {
  '2000-ocean':                                'https://www.2000oceaninhallandale.com/',
  '57-ocean':                                  'https://www.57oceancondomiami.com/',
  'apogee':                                    'https://www.apogeecondosouthbeach.com/',
  'armani-casa':                               'https://www.armaniresidencesmiami.com/',
  'aston-martin-residences':                   'https://astonmartinresidencesdowntownmiami.nestcapitals.com/',
  'auberge-beach-residences-spa-fort-lauderdale': 'https://www.aubergebeachsresidences.com',
  'continuum-south-beach':                     'https://www.continummsouthbeach.com/',
  'eighty-seven-park':                         'https://www.eightysevenparkcondo.com/',
  'fendi-chateau':                             'https://www.fendichateaumiami.com/',
  'four-seasons-hotel-private-residences':     'https://fourseasonsresidencesfortlauderdale.nestcapitals.com/',
  'grove-at-grand-bay':                        'https://www.groveatgranbay.com/',
  'jade-ocean':                                'https://www.jadeoceancondo.com/',
  'jade-signature':                            'https://www.jadesignatures.com/',
  'muse-residences':                           'https://www.museresidencesmiami.com/',
  'oceana-bal-harbour':                        'https://www.oceanaballlharbour.com/',
  'oceana-key-biscayne':                       'https://www.oceanakeybisscayne.com/',
  'one-thousand-museum':                       'https://www.1000museumiami.com/',
  'palazzo-del-sol':                           'https://www.palazzodellsol.com/',
  'palazzo-della-luna':                        'https://www.palazzoodellaluna.com/',
  'park-grove':                                'https://www.parkgrovecondomiami.com/',
  'regalia':                                   'https://www.regaliaresidenses.com/',
  'setai-residences':                          'https://setaimiamibeach.nestcapitals.com/',
  'the-estates-at-acqualina':                  'https://www.estatessatacqualina.com/',
  'the-ritz-carlton-residences-sunny-isles':   'https://ritzcarltonsunnyisles.nestcapitals.com/',
  'turnberry-ocean-club':                      'https://www.turnberryoceansclub.com/',
};

// Hybrid: Five Park keeps its existing priceList AND gets a UFS button.
// Stored separately so it doesn't overwrite the developer-units price list.
const HYBRID_UFS = {
  'five-park-miami-beach': 'https://www.fiveparkresidenses.com/',
};

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

// Projects whose current price list must be left alone.
const KEEP_AS_IS = [
  'alana-bay-harbor-islands',
  'alina-residences',
  'five-park-miami-beach',     // hybrid — its priceList stays; UFS button added separately
  'forte-on-flagler',
];

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const isDry = process.argv.includes('--dry');
  const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));
  const slugToIdx = new Map(projects.map((p, i) => [p.slug, i]));

  const log = { mls: [], ufs: [], soldOut: [], paused: [], custom: [], hybrid: [], notFound: [] };

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

  // MLS
  for (const slug of MLS_SLUGS) {
    if (setPriceList(slug, { heading: 'Check Availability on MLS', kind: 'mls' }, 'MLS')) {
      log.mls.push(slug);
    }
  }

  // UFS
  for (const [slug, url] of Object.entries(UFS_URLS)) {
    if (setPriceList(slug, { heading: 'UNITS FOR SALE', externalUrl: url, kind: 'ufs' }, 'UFS')) {
      log.ufs.push(slug);
    }
  }

  // SOLD OUT
  for (const slug of SOLD_OUT_SLUGS) {
    if (setPriceList(slug, { heading: 'SOLD OUT', kind: 'sold-out' }, 'SOLD OUT')) {
      log.soldOut.push(slug);
    }
  }

  // PAUSED
  for (const slug of PAUSED_SLUGS) {
    if (setPriceList(slug, { heading: 'PAUSED PROJECT', kind: 'paused' }, 'PAUSED')) {
      log.paused.push(slug);
    }
  }

  // CUSTOM
  for (const [slug, text] of Object.entries(CUSTOM_TEXTS)) {
    if (setPriceList(slug, { heading: text, kind: 'message' }, 'CUSTOM')) {
      log.custom.push(slug + ' ("' + text + '")');
    }
  }

  // HYBRID: priceList stays, unitsForSale is added on top
  for (const [slug, url] of Object.entries(HYBRID_UFS)) {
    const i = slugToIdx.get(slug);
    if (i === undefined) { log.notFound.push({ slug, category: 'HYBRID' }); continue; }
    if (!isDry) projects[i].unitsForSale = { externalUrl: url };
    log.hybrid.push(slug);
  }

  // ── Report ─────────────────────────────────────────────────────────────
  console.log('=== CONFIGURE SPECIAL PROJECTS' + (isDry ? ' [DRY RUN]' : '') + ' ===\n');
  console.log('MLS banner          :', log.mls.length, 'projects');
  console.log('UNITS FOR SALE      :', log.ufs.length, 'projects');
  console.log('SOLD OUT            :', log.soldOut.length, 'projects');
  console.log('PAUSED              :', log.paused.length, 'projects');
  console.log('CUSTOM message      :', log.custom.length, 'projects');
  console.log('HYBRID (PDF + UFS)  :', log.hybrid.length, 'projects (' + log.hybrid.join(', ') + ')');
  console.log('KEEP AS-IS (untouched):', KEEP_AS_IS.length, 'projects');

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
    const total = log.mls.length + log.ufs.length + log.soldOut.length + log.paused.length + log.custom.length + log.hybrid.length;
    console.log('\n✓ Applied configs to ' + total + ' project(s)');
  } else {
    console.log('\n[DRY RUN — no files written]');
  }
}

main();
