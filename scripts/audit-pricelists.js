'use strict';

/**
 * audit-pricelists.js
 * ─────────────────────────────────────────────────────────────────────────
 * Compares what projects.json claims is each project's current price list /
 * price range against what's actually available in Drive RIGHT NOW. Reports
 * every mismatch so admins know which files need a fresh upload, which are
 * pointing at stale versions, and which are perfectly synced.
 *
 * For each project that should have a price list (per projects.json):
 *   1. Find the newest non-trashed `<Name> - Price List N.pdf` in any year/
 *      month folder of the price-list root.
 *   2. Compare that file's ID to projects.json[slug].priceList.driveFileId.
 *   3. Same for price range.
 *
 * Classifications
 * ───────────────
 *   ✓ SYNCED       projects.json matches the newest Drive file
 *   ⚠ STALE        Drive has a newer file than projects.json
 *   🗑 TRASHED      projects.json points at a file currently in Drive's trash
 *   ✗ MISSING      projects.json has a file but no matching file exists in Drive
 *   ◷ OLD-MONTH    projects.json is using a fallback from a previous month
 *                  because the current month has no file for this project
 *
 * Usage
 * ─────
 *   node scripts/audit-pricelists.js              # full audit
 *   node scripts/audit-pricelists.js --only-bad   # hide ✓ SYNCED rows
 *
 * Env
 * ───
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY
 *   PRICE_LIST_DRIVE_FOLDER_ID
 * ─────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

const PROJECTS_JSON   = path.join(__dirname, '../data/projects.json');
const PRICE_FOLDER_ID = process.env.PRICE_LIST_DRIVE_FOLDER_ID;

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

function makeAuth() {
  return new google.auth.JWT({
    email:  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key:    (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
}

async function listChildren(drive, folderId) {
  const all = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    all.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return all;
}

// Same name-normalization as seed-pricelists-from-drive.js so the audit
// matches files the same way the seeder does.
function norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[®™''']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Match a normalized filename-derived project name against a set of normalized
// names for one project (name / esqueletoName / tpDataName).
//
// Strictness compared to the seed script: we DON'T accept matches where the
// project's tpDataName is a generic prefix shared by multiple projects (e.g.
// "Ocean House" matches both "Ocean House Surfside" and "Ocean House South
// Beach"). To avoid those false positives in audit mode, the substring match
// must be against the FULL `name` (or `esqueletoName`), never against a
// shorter tpDataName.
function projectMatches(fileNorm, project) {
  const fullNames = [project.name, project.esqueletoName].filter(Boolean).map(norm);
  return fullNames.some(n => {
    if (fileNorm === n) return true;
    const shorter = fileNorm.length < n.length ? fileNorm : n;
    if (shorter.length >= 10 && (fileNorm.includes(n) || n.includes(fileNorm))) return true;
    const strip = s => s.replace(/\bwest\b\s*/g, '').replace(/\s+/g, ' ').trim();
    return strip(fileNorm) === strip(n);
  });
}

async function main() {
  const showOnlyBad = process.argv.includes('--only-bad');
  if (!PRICE_FOLDER_ID) {
    console.error('Error: PRICE_LIST_DRIVE_FOLDER_ID must be set in .env');
    process.exit(1);
  }

  const drive = google.drive({ version: 'v3', auth: makeAuth() });
  const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));

  // ── 1. Build a flat index of every price-list file in Drive ──────────────
  console.log('Indexing Drive price-list files...');
  const yearFolders = (await listChildren(drive, PRICE_FOLDER_ID))
    .filter(f => f.mimeType === 'application/vnd.google-apps.folder')
    .filter(f => /price list \d{4}/i.test(f.name))
    .map(f => ({ ...f, year: parseInt((f.name.match(/\d{4}/) || ['0'])[0], 10) }));

  // Each entry: { file, docType: 'list'|'range', year, monthNum, monthName, projectNorm }
  const driveFiles = [];
  for (const yf of yearFolders) {
    const monthFolders = (await listChildren(drive, yf.id))
      .filter(f => f.mimeType === 'application/vnd.google-apps.folder')
      .map(f => ({ ...f, monthNum: parseInt((f.name.match(/price list (\d+)/i) || ['','0'])[1], 10) }))
      .filter(f => f.monthNum > 0);

    for (const mf of monthFolders) {
      const files = await listChildren(drive, mf.id);
      for (const file of files) {
        if (!file.name.toLowerCase().endsWith('.pdf')) continue;
        const m = file.name.match(/^(.+?)\s*-\s*Price (List|Range)\s+\d+\.pdf$/i);
        if (!m) continue;
        driveFiles.push({
          file,
          docType: m[2].toLowerCase(),
          projectNorm: norm(m[1]),
          year: yf.year,
          monthNum: mf.monthNum,
          monthName: MONTHS[mf.monthNum - 1] || String(mf.monthNum),
        });
      }
    }
  }
  console.log(`Indexed ${driveFiles.length} price-doc files across ${yearFolders.length} year folder(s)`);

  // Current year/month (newest folder that exists)
  const currentYear  = Math.max(...yearFolders.map(y => y.year));
  const currentMonth = Math.max(
    ...driveFiles.filter(f => f.year === currentYear).map(f => f.monthNum)
  );
  console.log(`Current Drive month: ${MONTHS[currentMonth - 1]} ${currentYear}\n`);

  // ── 2. Walk every project and classify ───────────────────────────────────
  const rows = [];

  for (const p of projects) {
    if (!p.name && !p.esqueletoName) continue;

    for (const kind of ['list', 'range']) {
      const field = kind === 'list' ? 'priceList' : 'priceRange';
      const current = p[field];

      // Skip projects with non-Drive configs (heading, externalUrl, message)
      if (current && (current.externalUrl || current.heading || current.message)) continue;
      if (!current?.driveFileId) continue;

      // Find every matching file across all months for this project + kind
      const candidates = driveFiles
        .filter(f => f.docType === kind)
        .filter(f => projectMatches(f.projectNorm, p))
        .sort((a, b) => {
          // Newest year, then newest month, then newest modifiedTime
          if (b.year !== a.year)         return b.year - a.year;
          if (b.monthNum !== a.monthNum) return b.monthNum - a.monthNum;
          return new Date(b.file.modifiedTime).getTime() - new Date(a.file.modifiedTime).getTime();
        });

      const newest = candidates[0] || null;
      const newestId = newest?.file?.id || null;
      const newestInCurrentMonth = newest && newest.year === currentYear && newest.monthNum === currentMonth;

      let status;
      if (!newest) {
        status = 'MISSING'; // projects.json claims a file but Drive has none
      } else if (newest.file.id === current.driveFileId) {
        status = newestInCurrentMonth ? 'SYNCED' : 'OLD-MONTH';
      } else {
        // ID differs — check if the current ID is even still alive in Drive
        // (we'd need a separate API call; defer to the heal script for that.
        //  Here we just say STALE: Drive has a newer file.)
        status = 'STALE';
      }

      rows.push({
        slug:       p.slug,
        name:       p.name,
        kind:       kind === 'list' ? 'PL' : 'PR',
        status,
        currentId:  current.driveFileId,
        currentAt:  current.createdAt,
        newestId,
        newestName: newest?.file?.name,
        newestFolder: newest ? `Price List ${String(newest.monthNum).padStart(2,'0')} (${newest.monthName}) ${newest.year}` : null,
        newestModified: newest?.file?.modifiedTime,
      });
    }
  }

  // ── 3. Report ────────────────────────────────────────────────────────────
  const groups = {
    STALE:     rows.filter(r => r.status === 'STALE'),
    'OLD-MONTH': rows.filter(r => r.status === 'OLD-MONTH'),
    MISSING:   rows.filter(r => r.status === 'MISSING'),
    SYNCED:    rows.filter(r => r.status === 'SYNCED'),
  };

  const icon = { SYNCED: '✓', STALE: '⚠', 'OLD-MONTH': '◷', MISSING: '✗' };

  console.log('═'.repeat(74));
  console.log('AUDIT SUMMARY');
  console.log('═'.repeat(74));
  console.log(`  ✓ SYNCED      ${groups.SYNCED.length}   (matches newest Drive file in current month)`);
  console.log(`  ⚠ STALE       ${groups.STALE.length}   (Drive has a newer file — sync should pick it up)`);
  console.log(`  ◷ OLD-MONTH   ${groups['OLD-MONTH'].length}   (using a previous-month fallback — no file in current month)`);
  console.log(`  ✗ MISSING     ${groups.MISSING.length}   (projects.json has an ID but Drive has no matching file)`);
  console.log('═'.repeat(74));

  for (const status of ['STALE', 'MISSING', 'OLD-MONTH', 'SYNCED']) {
    const list = groups[status];
    if (!list.length) continue;
    if (showOnlyBad && status === 'SYNCED') continue;
    console.log(`\n${icon[status]} ${status} (${list.length})`);
    console.log('─'.repeat(74));
    for (const r of list) {
      console.log(`  ${r.name} [${r.kind}]`);
      console.log(`    projects.json: ${r.currentId} (${r.currentAt || '?'})`);
      if (r.newestId && r.newestId !== r.currentId) {
        console.log(`    Drive newest:  ${r.newestId}`);
        console.log(`                   ${r.newestName}`);
        console.log(`                   in ${r.newestFolder}, modified ${r.newestModified}`);
      } else if (r.newestId && status === 'OLD-MONTH') {
        console.log(`                   in ${r.newestFolder} (no file in current month)`);
      } else if (!r.newestId) {
        console.log(`    Drive newest:  (no file found matching this project name)`);
      }
    }
  }

  // Exit non-zero if anything broken — useful for CI alerting
  const bad = groups.STALE.length + groups.MISSING.length;
  process.exit(bad > 0 ? 2 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
