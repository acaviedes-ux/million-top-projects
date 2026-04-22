/**
 * seed-project.js
 * ─────────────────────────────────────────────────────────────
 * One-time migration script: reads project data from Google Sheets
 * (Esqueleto + TP DATA) and writes it into data/projects.json.
 *
 * Usage:
 *   node scripts/seed-project.js "619 Residences by Foster + Partners + Nobu Hospitality"
 *   node scripts/seed-project.js --all        ← seeds every slug in projects.json
 *
 * Requires a .env file (or env vars) with:
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL
 *   GOOGLE_PRIVATE_KEY
 *   ESQUELETO_SPREADSHEET_ID          ← PROJECT_INFO_SPREADSHEET_ID from the main app
 *   TP_DATA_SPREADSHEET_ID            ← PROJECT_INFO_LOG_SPREADSHEET_ID (contains TP DATA tab)
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();
const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────

const PROJECTS_JSON   = path.join(__dirname, '../data/projects.json');
const ESQUELETO_ID    = process.env.ESQUELETO_SPREADSHEET_ID;
const TP_DATA_ID      = process.env.TP_DATA_SPREADSHEET_ID;
const TP_DATA_TAB     = 'TP DATA';

// ── Esqueleto (Projects Overview) column map (0-based indices) ─
// Row layout: headers in row 2, data from row 3.
// Column B (index 1) = project name — used to find the row.
const ESQ = {
  name:               1,   // B — project identifier
  address:            8,   // I
  completionDate:     12,  // M
  developer:          14,  // O
  architecture:       15,  // P
  interiorDesign:     16,  // Q
  rentalRestrictions: 17,  // R
  parkingSpaces:      18,  // S
  depositStructure:   19,  // T
  hoa:                21,  // V
  inhouseNames:       30,  // AE — one agent per line
  inhousePhones:      31,  // AF — "Name: +1 (xxx)..." one per line
  inhouseEmails:      32,  // AG — "Name: email@..." one per line
  inhouseNotes:       33,  // AH — "Name: Option A | Option B | No longer working..."
};

// ── TP DATA tab column map (0-based indices) ──────────────────
// Row layout: headers in row 1, data from row 2.
// Actual headers: Sección | Proyecto | Starting Price | THE BUILDING | STYLISH AMENITIES
// Column A (index 0) = "Sección" (section label, e.g. "Top Projects") — NOT the name
// Column B (index 1) = "Proyecto" — project identifier used to find the row
const TP = {
  name:             1,  // B — project identifier
  startingPrice:    2,  // C
  theBuilding:      3,  // D
  stylishAmenities: 4,  // E
};

// ── Google auth ───────────────────────────────────────────────
// Uses JWT (same as price_lists_update) — supports domain-wide delegation
// via GOOGLE_IMPERSONATE_EMAIL when set.

function makeAuth() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
    subject: process.env.GOOGLE_IMPERSONATE_EMAIL || undefined,
  });
}

// ── Sheet helpers ─────────────────────────────────────────────

async function getRange(sheets, spreadsheetId, range) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}

function cell(row, idx) {
  return (row[idx] || '').toString().trim();
}

function multiline(row, idx) {
  const v = cell(row, idx);
  if (!v) return null;
  const lines = v.split('\n').map(s => s.trim()).filter(Boolean);
  return lines.length ? lines : null;
}

// ── Contact card: extract Option A agent only ─────────────────
function extractOptionAContact(row) {
  const namesRaw  = cell(row, ESQ.inhouseNames);
  const phonesRaw = cell(row, ESQ.inhousePhones);
  const emailsRaw = cell(row, ESQ.inhouseEmails);
  const notesRaw  = cell(row, ESQ.inhouseNotes);

  if (!namesRaw) return null;

  const names  = namesRaw.split('\n').map(s => s.trim()).filter(Boolean);
  const phones = phonesRaw.split('\n').map(s => s.trim()).filter(Boolean);
  const emails = emailsRaw.split('\n').map(s => s.trim()).filter(Boolean);
  const notes  = notesRaw.split('\n').map(s => s.trim()).filter(Boolean);

  // Find which line index contains "Option A" in notes (AH)
  const optionAIndex = notes.findIndex(n =>
    n.toLowerCase().includes('option a')
  );

  // If no Option A found, fall back to index 0 (first active agent)
  const idx = optionAIndex >= 0 ? optionAIndex : 0;

  const name  = names[idx]  || '';
  const phone = stripPrefix(phones[idx]  || '');
  const email = stripPrefix(emails[idx] || '');

  if (!name) return null;

  return [{ name, phone: phone || null, email: email || null }];
}

// Strips "Name: " prefix that the inhouse columns use
function stripPrefix(value) {
  const colonIdx = value.indexOf(':');
  return colonIdx === -1 ? value.trim() : value.substring(colonIdx + 1).trim();
}

// ── Main seeder ───────────────────────────────────────────────

async function seedProject(projectName, tpDataName = null) {
  console.log(`\n→ Seeding: "${projectName}"`);
  const tpLookup = tpDataName || projectName;
  if (tpDataName) console.log(`  TP DATA lookup name: "${tpLookup}"`);

  const auth   = makeAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  // 1. Read Esqueleto (headers in row 2, data from row 3)
  const esqRows = await getRange(sheets, ESQUELETO_ID, 'Projects Overview!A:AH');
  if (esqRows.length < 3) throw new Error('Esqueleto: fewer than 3 rows — check tab name.');

  const esqData = esqRows.slice(2); // skip title row (1) and headers row (2)
  const esqRow  = esqData.find(r =>
    cell(r, ESQ.name).toLowerCase() === projectName.toLowerCase()
  );
  if (!esqRow) {
    console.warn(`  ⚠ "${projectName}" not found in Esqueleto — skipping.`);
    return null;
  }
  console.log('  ✓ Found in Esqueleto');

  // 2. Read TP DATA tab (headers in row 1, data from row 2)
  // Uses tpLookup (which may differ from projectName) for matching.
  const tpRows = await getRange(sheets, TP_DATA_ID, `${TP_DATA_TAB}!A:E`);
  const tpData = tpRows.slice(1); // skip header row
  const tpRow  = tpData.find(r =>
    cell(r, TP.name).toLowerCase() === tpLookup.toLowerCase()
  );
  if (!tpRow) {
    console.warn(`  ⚠ "${tpLookup}" not found in TP DATA — theBuilding/amenities/startingPrice will be empty.`);
  } else {
    console.log('  ✓ Found in TP DATA');
  }

  // 3. Build the updated project fields
  const updates = {
    startingPrice:      tpRow ? cell(tpRow, TP.startingPrice)    || null : undefined,
    address:            cell(esqRow, ESQ.address)                || null,
    developer:          cell(esqRow, ESQ.developer)              || null,
    architecture:       cell(esqRow, ESQ.architecture)           || null,
    interiorDesign:     cell(esqRow, ESQ.interiorDesign)         || null,
    completionDate:     cell(esqRow, ESQ.completionDate)         || null,
    theBuilding:        tpRow ? cell(tpRow, TP.theBuilding)       || null : undefined,
    depositStructure:   multiline(esqRow, ESQ.depositStructure),
    stylishAmenities:   tpRow ? cell(tpRow, TP.stylishAmenities)  || null : undefined,
    parkingSpaces:      multiline(esqRow, ESQ.parkingSpaces),
    rentalRestrictions: multiline(esqRow, ESQ.rentalRestrictions),
    hoa:                cell(esqRow, ESQ.hoa)                    || null,
    contact:            extractOptionAContact(esqRow),
  };

  // Remove keys explicitly set to undefined (field not available in TP DATA)
  Object.keys(updates).forEach(k => updates[k] === undefined && delete updates[k]);

  return updates;
}

// ── projects.json updater ─────────────────────────────────────

function updateProjectsJson(esqueletoName, updates) {
  const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));
  const idx = projects.findIndex(p =>
    (p.esqueletoName || p.name).toLowerCase() === esqueletoName.toLowerCase()
  );

  if (idx === -1) {
    console.warn(`  ⚠ No entry in projects.json for "${esqueletoName}" — skipping JSON update.`);
    return;
  }

  // Merge updates into existing entry (keeps slug, thumbnail, hero, brochures, etc.)
  projects[idx] = { ...projects[idx], ...updates };

  fs.writeFileSync(PROJECTS_JSON, JSON.stringify(projects, null, 2) + '\n', 'utf8');
  console.log(`  ✓ projects.json updated for slug="${projects[idx].slug}"`);
}

// ── CLI entrypoint ────────────────────────────────────────────

async function main() {
  if (!ESQUELETO_ID || !TP_DATA_ID) {
    console.error('Error: ESQUELETO_SPREADSHEET_ID and TP_DATA_SPREADSHEET_ID must be set in .env');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const isAll = args[0] === '--all';

  // --tp-name "..." override for single-project runs where the TP DATA tab
  // uses a different name than the Esqueleto spreadsheet.
  const tpNameFlagIdx = args.indexOf('--tp-name');
  const tpNameOverride = tpNameFlagIdx !== -1 ? args[tpNameFlagIdx + 1] : null;

  // targets: array of { esqueletoName, tpDataName }
  let targets;
  if (isAll) {
    // Seed every project in projects.json that has an esqueletoName.
    // Reads the optional tpDataName alias from the JSON entry.
    const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));
    targets = projects
      .filter(p => p.esqueletoName)
      .map(p => ({ esqueletoName: p.esqueletoName, tpDataName: p.tpDataName || null }));
    console.log(`Seeding all ${targets.length} projects...`);
  } else if (args[0] && args[0] !== '--tp-name') {
    // Read tpDataName from projects.json unless an explicit --tp-name was given.
    let resolvedTpName = tpNameOverride;
    if (!resolvedTpName) {
      const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));
      const entry = projects.find(p =>
        (p.esqueletoName || p.name).toLowerCase() === args[0].toLowerCase()
      );
      resolvedTpName = entry?.tpDataName || null;
    }
    targets = [{ esqueletoName: args[0], tpDataName: resolvedTpName }];
  } else {
    console.error('Usage:');
    console.error('  node scripts/seed-project.js "619 Residences by Foster + Partners + Nobu Hospitality"');
    console.error('  node scripts/seed-project.js "619 Residences ..." --tp-name "619 Brickell - NOBU"');
    console.error('  node scripts/seed-project.js --all');
    process.exit(1);
  }

  let ok = 0, failed = 0;
  for (const { esqueletoName, tpDataName } of targets) {
    try {
      const updates = await seedProject(esqueletoName, tpDataName);
      if (updates) {
        updateProjectsJson(esqueletoName, updates);
        ok++;
      }
    } catch (err) {
      console.error(`  ✗ Error for "${esqueletoName}":`, err.message);
      failed++;
    }
  }

  console.log(`\nDone — ${ok} updated, ${failed} failed.`);
  if (ok > 0) {
    console.log('\nNext: git add data/projects.json && git commit -m "chore: seed project data" && git push');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
