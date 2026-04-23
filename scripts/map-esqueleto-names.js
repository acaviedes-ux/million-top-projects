/**
 * map-esqueleto-names.js
 * ─────────────────────────────────────────────────────────────
 * Sets the `esqueletoName` field on every entry in data/projects.json
 * so that seed-project.js --all can look up each project in the
 * Esqueleto (Projects Overview) spreadsheet.
 *
 * Logic per entry:
 *   1. Already has esqueletoName → skip (preserve existing value)
 *   2. Slug is in SLUG_OVERRIDE map → use that (handles same-name conflicts)
 *   3. tpDataName is in EXPLICIT_MAP → use the mapped Esqueleto name
 *   4. Default: esqueletoName = tpDataName (names match exactly in Esqueleto)
 *
 * Run once before `npm run seed:all`.
 * Usage:  node scripts/map-esqueleto-names.js
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const PROJECTS_JSON = path.join(__dirname, '../data/projects.json');

// ── Slug-level overrides ───────────────────────────────────────
// Used when two TP DATA entries share the same name but map to
// different Esqueleto projects (e.g. two different "Ocean House" buildings).
const SLUG_OVERRIDE = new Map([
  ['ocean-house',   'Ocean House Surfside'],      // Top Projects
  ['ocean-house-2', 'Ocean House South Beach'],   // Other Projects
]);

// ── Explicit tpDataName → esqueletoName map ────────────────────
// Only entries where the names differ between TP DATA and Esqueleto.
// For all other entries the names are identical so no mapping is needed.
const EXPLICIT_MAP = new Map([

  // ── Top Projects ────────────────────────────────────────────
  ['619 Brickell - NOBU',              '619 Residences by Foster + Partners + Nobu Hospitality'],
  ['Andare Residences',                'Andare Residences Fort Lauderdale'],
  ['Aria Reserve',                     'Aria Reserve Miami'],
  ['Armani Casa Pompano Beach',        'Armani Casa Residences Pompano Beach'],
  ['Cipriani Residences',              'Cipriani Residences Brickell'],
  ['EDITION® Residences Edgewater',    'EDITION Edgewater'],
  ['Faena House',                      'Faena House Miami Beach'],
  ['Faena Residences Downtown Miami',  'Faena Residences Miami Downtown Miami'],
  ['La Maré',                          'La Maré Bay Harbor Islands'],
  ['Mr. C Residences Tigertail',       'Mr. C Tigertail Coconut Grove'],
  ['ORA by Casa Tua',                  'ORA by Casa Tua Brickell'],
  ['Shore Club Private Collection Residences', 'Shore Club Private Collections Miami Beach'],
  ['Shorecrest West Palm Beach',       'Shorecrest Flagler Drive West Palm Beach'],
  ['St. Regis Residences Bahia Mar Fort Lauderdale', 'St. Regis® Residences Bahia Mar Fort Lauderdale'],
  ['The Raleigh',                      'The Raleigh by Rosewood'],
  ['The Residences at Mandarin Oriental, West Palm Beach', 'Mandarin Oriental Residences, West Palm Beach'],

  // ── Other Projects ───────────────────────────────────────────
  ['1 Hotel & Homes',                  '1 Hotel & Homes South Beach'],
  ['2000 Ocean',                       '2000 Ocean Hallandale Beach'],
  ['321 Ocean',                        '321 Ocean Miami Beach'],
  ['3200 South Ocean',                 '3200 South Ocean Highland Beach'],
  ['5000 North Ocean',                 '5000 North Ocean Singer Island'],
  ['57 Ocean',                         '57 Ocean Miami Beach'],
  ['72 Park',                          '72 Park Miami Beach'],
  ['9900 West',                        '9900 West Bay Harbor Islands'],
  ['Alina Residences',                 'Alina Residences Boca Raton'],
  ['Apogee',                           'Apogee South Beach'],
  ['Armani Casa',                      'Armani Casa Sunny Isles Beach'],
  ['Asia Brickell',                    'Asia Brickell Key'],
  ['Aston Martin Residences',          'Aston Martin Residences Downtown Miami'],
  ['Baccarat Residences',              'Baccarat Residences Brickell'],
  ['Bayview Village',                  'Bayview Village Fisher Island'],
  ['Beach House 8',                    'Beach House 8 Miami Beach'],
  ['Biltmore Row',                     'Biltmore Row Coral Gables'],
  ['Blue & Green Diamond Towers',      'Blue & Green Diamond Towers Miami Beach'],
  ['Brickell City Centre',             'Brickell City Centre Miami'],
  ['Bristol Tower',                    'Bristol Tower Brickell'],
  ['Caribbean',                        'Caribbean Miami Beach'],
  ['Casa Bella Residences Miami',      'Casa Bella by B&B Italia Downtown Miami'],
  ['Château Beach Residences',         'Château Beach Residences Sunny Isles Beach'],
  ['Continuum South Beach',            'Continuum on South Beach'],
  ['Eighty Seven Park',                'Eighty Seven Park Surfside'],
  ['Elysee Miami',                     'Elysee Miami'],  // exact — included for clarity
  ['Fendi Château',                    'Fendi Château Residences Surfside'],
  ['Forté on Flagler',                 'Forté on Flagler West Palm Beach'],
  ['Four Seasons Hotel & Private Residences', 'Four Seasons Hotel & Private Residences Fort Lauderdale'],
  ['Four Seasons Residences Las Vegas', 'Four Seasons Private Residences Las Vegas'],
  ['Gale Miami',                       'Gale Miami Hotel & Residences'],
  ['Glass Miami Beach',                'Glass South Beach'],
  ['HUB Miami',                        'HUB Miami Downtown Miami'],
  ['Il Villaggio',                     'Il Villaggio Miami'],
  ['Jade Beach',                       'Jade Beach Sunny Isles'],
  ['Jade Ocean',                       'Jade Ocean Sunny Isles Beach'],
  ['Jade Signature',                   'Jade Signature Sunny Isles Beach'],
  ['JEM Residences',                   'JEM Residences Brickell'],
  ['L\'Atelier',                       'L\'atelier Miami Beach'],
  ['La Baia North Bay Harbor',         'La Baia North Bay Harbor Islands'],
  ['La Santa Maria',                   'La Santa Maria Brickell'],
  ['Lofty Residences',                 'Lofty Residences Brickell'],
  ['Missoni Baia',                     'Missoni Baia Edgewater'],
  ['Monaco Yacht Club & Residences',   'Monaco Yacht Club & Residences Miami Beach'],
  ['Monad Terrace',                    'Monad Terrace Miami Beach'],
  ['Murano at Portofino',              'Murano at Portofino South Beach'],
  ['Muse Residences',                  'Muse Residences Sunny Isles Beach'],
  ['Ocean Delray',                     'Ocean Delray Beach'],
  ['Ocean Park',                       'Ocean Park South Beach'],
  ['Ocean Terrace',                    'Ocean Terrace Miami Beach'],
  ['Oceanside',                        'Oceanside Fisher Island'],
  ['Okan Tower',                       'Okan Tower Downtown Miami'],
  ['One Ocean',                        'One Ocean South Beach'],
  ['One Park Tower by Turnberry',      'One Park Tower by Turnberry North Miami'],
  ['One Thousand Museum',              'One Thousand Museum Downtown Miami'],
  ['Origin',                           'Origin Bay Harbor Islands'],
  ['Park Grove',                       'Park Grove Coconut Grove'],
  ['Parque Towers',                    'Parque Towers Sunny Isles Beach'],
  ['Porsche Design Tower',             'Porsche Design Tower Sunny Isles Beach'],
  ['Portofino Tower',                  'Portofino Tower South Beach'],
  ['Privé Island',                     'Privé Island Aventura'],
  ['Regalia',                          'Regalia Sunny Isles Beach'],
  ['Salato',                           'Salato Pompano Beach'],
  ['Setai Residences',                 'Setai Residences Miami Beach'],
  ['Shell Bay by Auberge',             'Shell Bay by Auberge Hallandale'],
  ['Shoma Bay',                        'Shoma Bay North Bay Village'],
  ['Sixth & Rio',                      'Sixth & Rio Fort Lauderdale'],
  ['South Flagler House',              'South Flagler House West Palm Beach'],
  ['St Regis® Residences Bal Harbour', 'St. Regis® Residences Bal Harbour'],
  ['Surf Row',                         'Surf Row Residences Surfside'],
  ['The Avenue',                       'The Avenue Coral Gables'],
  ['The Bath Club',                    'The Bath Club Miami Beach'],
  ['The Cove Residences',              'The Cove Residences Edgewater'],
  ['The Estates at Acqualina',         'The Estates at Acqualina Sunny Isles'],
  ['The Fairchild',                    'The Fairchild Coconut Grove'],
  ['The Links Estates',                'The Links Estates at Fisher Island'],
  ['The Mansions at Acqualina',        'The Mansions at Acqualina Sunny Isles'],
  ['The Residences at The Miami Beach EDITION®', 'The Residences at The Miami Beach Edition®'],
  ['The Standard Residences',          'The Standard Residences Brickell'],
  ['Turnberry Ocean Club',             'Turnberry Ocean Club Sunny Isles'],
  ['Turnberry Ocean Colony',           'Turnberry Ocean Colony Sunny Isles Beach'],
  ['Twenty Nine Indian Creek',         'Twenty Nine Indian Creek Miami Beach'],
  ['UNA Residences',                   'Una Residences Brickell'],
  ['Villa Valencia',                   'Villa Valencia Coral Gables'],
  ['W South Beach® Residences',        'W South Beach® Florida'],
  ['West Eleventh Residences',         'West Eleventh Residences Downtown Miami'],
]);

// ── Main ──────────────────────────────────────────────────────

function main() {
  const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));

  let skipped = 0, mapped = 0, defaulted = 0;

  const updated = projects.map(p => {
    // 1. Already has esqueletoName → leave it alone
    if (p.esqueletoName) {
      skipped++;
      return p;
    }

    let esqueletoName;

    // 2. Slug-level override (same tpDataName, different building)
    if (SLUG_OVERRIDE.has(p.slug)) {
      esqueletoName = SLUG_OVERRIDE.get(p.slug);
      mapped++;
      console.log(`  [slug]  "${p.slug}" → "${esqueletoName}"`);

    // 3. Explicit tpDataName mapping
    } else if (p.tpDataName && EXPLICIT_MAP.has(p.tpDataName)) {
      esqueletoName = EXPLICIT_MAP.get(p.tpDataName);
      mapped++;
      if (esqueletoName !== p.tpDataName) {
        console.log(`  [map]   "${p.tpDataName}" → "${esqueletoName}"`);
      }

    // 4. Default: assume tpDataName == esqueletoName
    } else {
      esqueletoName = p.tpDataName || p.name;
      defaulted++;
    }

    return { ...p, esqueletoName };
  });

  fs.writeFileSync(PROJECTS_JSON, JSON.stringify(updated, null, 2) + '\n', 'utf8');

  console.log(`\n✓ Done`);
  console.log(`  ${skipped} already had esqueletoName (unchanged)`);
  console.log(`  ${mapped} explicitly mapped`);
  console.log(`  ${defaulted} defaulted to tpDataName`);
  console.log(`  Total: ${updated.length}`);
  console.log(`\nNext: npm run seed:all`);
}

main();
