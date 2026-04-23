/**
 * seed-logos.js
 * ─────────────────────────────────────────────────────────────
 * Reads project logos from the "Pre-construction Data" tab of the
 * "New Construction Pricing" spreadsheet (col A = name, col Q = Drive file ID),
 * downloads each logo from Google Drive, saves it to /images/logos/{slug}.{ext},
 * and writes the local path into the `projectLogo` field of data/projects.json.
 *
 * Usage:
 *   node scripts/seed-logos.js          ← all projects
 *   node scripts/seed-logos.js --dry    ← show matches without downloading
 *
 * Requires .env with:
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();
const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

const PROJECTS_JSON    = path.join(__dirname, '../data/projects.json');
const LOGOS_DIR        = path.join(__dirname, '../images/logos');
const SPREADSHEET_ID   = '1RTDA5ZNHbHrSYTEVGuUCUdWI04TKRso--ErWmASEehU';
const SHEET_TAB        = 'Pre-construction Data';

const MIME_TO_EXT = {
  'image/svg+xml':  'svg',
  'image/png':      'png',
  'image/jpeg':     'jpg',
  'image/jpg':      'jpg',
  'image/webp':     'webp',
  'image/gif':      'gif',
  'image/x-icon':   'ico',
  'application/octet-stream': 'png', // fallback
};

// ── Auth ──────────────────────────────────────────────────────

function makeAuth() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key:   (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
    subject: process.env.GOOGLE_IMPERSONATE_EMAIL || undefined,
  });
}

// ── Name normalization (for fuzzy matching) ───────────────────

function norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[®™\u2019']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  const isDry = process.argv.includes('--dry');

  if (!fs.existsSync(LOGOS_DIR)) {
    fs.mkdirSync(LOGOS_DIR, { recursive: true });
  }

  const auth    = makeAuth();
  const sheets  = google.sheets({ version: 'v4', auth });
  const drive   = google.drive({ version: 'v3', auth });

  // 1. Read spreadsheet: col A = project name, col Q = Drive file ID
  console.log(`Reading ${SHEET_TAB}…`);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TAB}!A:Q`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const rows = (res.data.values || []).slice(2); // skip 2 header rows
  const sheetMap = new Map(); // norm(name) → { name, fileId }
  for (const row of rows) {
    const name   = (row[0]  || '').toString().trim();
    const fileId = (row[16] || '').toString().trim(); // col Q = index 16
    if (name && fileId) {
      sheetMap.set(norm(name), { name, fileId });
    }
  }
  console.log(`  ${sheetMap.size} projects with logos in spreadsheet`);

  // 2. Load projects.json
  const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));

  // 3. Match each project to a sheet entry
  let matched = 0, skipped = 0, noMatch = 0, failed = 0;
  const updates = []; // { projectIdx, slug, fileId }

  for (let i = 0; i < projects.length; i++) {
    const p = projects[i];

    // Skip if already has a local logo (re-run safety)
    if (p.projectLogo && p.projectLogo.startsWith('/images/logos/')) {
      skipped++;
      continue;
    }

    // Try matching by esqueletoName, tpDataName, then name
    const candidates = [p.esqueletoName, p.tpDataName, p.name].filter(Boolean);
    let hit = null;
    for (const candidate of candidates) {
      hit = sheetMap.get(norm(candidate));
      if (hit) break;
    }

    if (!hit) {
      noMatch++;
      console.log(`  ⚠ No logo match: "${p.name}"`);
      continue;
    }

    matched++;
    updates.push({ idx: i, slug: p.slug, fileId: hit.fileId, sheetName: hit.name });
  }

  console.log(`\nMatch results:`);
  console.log(`  ${matched} matched`);
  console.log(`  ${skipped} already have local logos (skipped)`);
  console.log(`  ${noMatch} no match in spreadsheet`);

  if (isDry) {
    console.log('\n-- DRY RUN: first 10 matches --');
    updates.slice(0, 10).forEach(u =>
      console.log(`  "${projects[u.idx].name}" → ${u.fileId} → /images/logos/${u.slug}.*`)
    );
    return;
  }

  // 4. Download each logo and save locally
  console.log(`\nDownloading ${updates.length} logos…`);

  for (const u of updates) {
    try {
      // Get file metadata to determine extension
      const meta = await drive.files.get({
        fileId: u.fileId,
        fields: 'name,mimeType',
      });
      const mime = meta.data.mimeType || 'image/png';
      const ext  = MIME_TO_EXT[mime] || 'png';
      const dest = path.join(LOGOS_DIR, `${u.slug}.${ext}`);

      // Download file content
      const dl = await drive.files.get(
        { fileId: u.fileId, alt: 'media' },
        { responseType: 'arraybuffer' }
      );
      fs.writeFileSync(dest, Buffer.from(dl.data));

      // Update projects.json entry
      projects[u.idx].projectLogo = `/images/logos/${u.slug}.${ext}`;

      console.log(`  ✓ ${u.slug}.${ext} (${mime})`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${u.slug}: ${err.message}`);
    }
  }

  // 5. Write updated projects.json
  fs.writeFileSync(PROJECTS_JSON, JSON.stringify(projects, null, 2) + '\n', 'utf8');

  console.log(`\n✓ Done`);
  console.log(`  ${matched - failed} logos downloaded`);
  console.log(`  ${failed} errors`);
  console.log(`  ${noMatch} projects had no logo in spreadsheet`);
  console.log('\nNext: git add images/logos data/projects.json && git commit -m "chore: add project logos"');
}

main().catch(err => { console.error(err); process.exit(1); });
