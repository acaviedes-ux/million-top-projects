/**
 * sync-tp-fields.js
 * ──────────────────────────────────────────────────────────────
 * Reads `theBuilding` and `stylishAmenities` from the TP DATA tab
 * and fills in any projects.json entry where those fields are empty.
 *
 * Only FILLS IN missing values — never overwrites existing content.
 *
 * Usage:  node scripts/sync-tp-fields.js
 * ──────────────────────────────────────────────────────────────
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { google } = require('googleapis');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const PROJECTS_JSON  = path.join(__dirname, '../data/projects.json');
const TP_DATA_ID     = process.env.TP_DATA_SPREADSHEET_ID;
const TP_DATA_TAB    = 'TP DATA';

// 0-based column indices in TP DATA tab
const COL_NAME             = 1;  // B
const COL_THE_BUILDING     = 3;  // D
const COL_STYLISH_AMENITIES = 4; // E

function cell(row, idx) {
  return (row[idx] || '').trim();
}

async function main() {
  if (!TP_DATA_ID) {
    console.error('Error: TP_DATA_SPREADSHEET_ID is not set in .env');
    process.exit(1);
  }

  // ── Auth ───────────────────────────────────────────────────────
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key:   (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // ── Fetch TP DATA ──────────────────────────────────────────────
  console.log('Fetching TP DATA from Google Sheets...');
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: TP_DATA_ID,
    range: `${TP_DATA_TAB}!A:E`,
  });

  const rows     = res.data.values || [];
  const dataRows = rows.slice(1); // skip header

  // Build lookup: tpDataName (lowercase) → { theBuilding, stylishAmenities }
  const tpMap = new Map();
  for (const row of dataRows) {
    const name = cell(row, COL_NAME);
    if (!name) continue;
    tpMap.set(name.toLowerCase(), {
      theBuilding:      cell(row, COL_THE_BUILDING)      || null,
      stylishAmenities: cell(row, COL_STYLISH_AMENITIES) || null,
    });
  }
  console.log(`Loaded ${tpMap.size} entries from TP DATA\n`);

  // ── Compare + patch projects.json ─────────────────────────────
  const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));

  let filledBuilding   = 0;
  let filledAmenities  = 0;
  let noMatch          = 0;
  let alreadyComplete  = 0;

  const updated = projects.map(p => {
    const lookupKey = (p.tpDataName || p.name || '').toLowerCase();
    const tp = tpMap.get(lookupKey);

    if (!tp) {
      noMatch++;
      return p;
    }

    let changed = false;
    const patch = { ...p };

    // Fill theBuilding only if both theBuilding and the old buildingDescription are absent
    if (!p.theBuilding && !p.buildingDescription && tp.theBuilding) {
      patch.theBuilding = tp.theBuilding;
      changed = true;
      filledBuilding++;
      console.log(`  [theBuilding]      ${p.slug}`);
    }

    // Fill stylishAmenities only if currently absent
    if (!p.stylishAmenities && tp.stylishAmenities) {
      patch.stylishAmenities = tp.stylishAmenities;
      changed = true;
      filledAmenities++;
      console.log(`  [stylishAmenities] ${p.slug}`);
    }

    if (!changed) alreadyComplete++;
    return patch;
  });

  fs.writeFileSync(PROJECTS_JSON, JSON.stringify(updated, null, 2) + '\n', 'utf8');

  console.log('\n── Summary ──────────────────────────────────────');
  console.log(`  theBuilding filled:      ${filledBuilding}`);
  console.log(`  stylishAmenities filled: ${filledAmenities}`);
  console.log(`  no TP DATA match:        ${noMatch}`);
  console.log(`  already complete:        ${alreadyComplete}`);
  console.log(`  total projects:          ${projects.length}`);
  console.log('\nNext: git diff data/projects.json to review, then commit.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
