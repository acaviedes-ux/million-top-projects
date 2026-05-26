/**
 * seed-pricelists-from-drive.js
 * ─────────────────────────────────────────────────────────────
 * Traverses the price-list Drive folder (year → month sub-folders),
 * matches PDF filenames to projects.json entries, and populates:
 *
 *   priceList  → { driveFileId, createdAt }   e.g. "As of April, 2026"
 *   priceRange → { driveFileId, createdAt }
 *
 * Filename convention inside each month folder:
 *   "{ProjectName} - Price List {N}.pdf"
 *   "{ProjectName} - Price Range {N}.pdf"
 *
 * The Pre-construction Data sheet (col F = Price List, col G = Price Range)
 * controls which doc types each project should have; projects not in the
 * sheet are skipped.  Skip logic also respects special priceList configs
 * (externalUrl / heading / message) so existing custom setups are never
 * overwritten.
 *
 * Usage:
 *   node scripts/seed-pricelists-from-drive.js              # seed all
 *   node scripts/seed-pricelists-from-drive.js --dry        # preview only
 *   node scripts/seed-pricelists-from-drive.js --slug brickell-flatiron
 *   node scripts/seed-pricelists-from-drive.js --force      # overwrite existing
 *
 * Requires .env:
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL
 *   GOOGLE_PRIVATE_KEY
 *   PRICE_LIST_DRIVE_FOLDER_ID       ← top-level folder with year sub-folders
 *   PRE_CONSTRUCTION_SPREADSHEET_ID  ← optional override (has a safe default)
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();
const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

const PROJECTS_JSON       = path.join(__dirname, '../data/projects.json');
const PRICE_FOLDER_ID     = process.env.PRICE_LIST_DRIVE_FOLDER_ID;
const PRE_CONSTRUCTION_ID = process.env.PRE_CONSTRUCTION_SPREADSHEET_ID
                          || '1RTDA5ZNHbHrSYTEVGuUCUdWI04TKRso--ErWmASEehU';

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

// ── Auth ──────────────────────────────────────────────────────

function makeAuth() {
  return new google.auth.JWT({
    email:  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key:    (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/spreadsheets.readonly',
    ],
    subject: process.env.GOOGLE_IMPERSONATE_EMAIL || undefined,
  });
}

// ── Name normalization (same as seed-docs-from-drive.js) ─────

function norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[®™'']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ── Drive helpers ─────────────────────────────────────────────

async function listChildren(drive, folderId) {
  const all = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q:                       `'${folderId}' in parents and trashed = false`,
      fields:                  'nextPageToken, files(id, name, mimeType, modifiedTime)',
      pageSize:                1000,
      pageToken,
      supportsAllDrives:       true,   // required for Shared Drive access
      includeItemsFromAllDrives: true,
    });
    all.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return all;
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  const args       = process.argv.slice(2);
  const isDry           = args.includes('--dry');
  const isForce         = args.includes('--force');
  const isCurrentMonth  = args.includes('--current-month');
  const slugIdx         = args.indexOf('--slug');
  const targetSlug      = slugIdx !== -1 ? args[slugIdx + 1] : null;

  // When --current-month is set, restrict the search to today's year + month only.
  const now            = new Date();
  const todayYear      = now.getFullYear();
  const todayMonthNum  = now.getMonth() + 1; // 1-based

  if (!PRICE_FOLDER_ID) {
    console.error('Error: PRICE_LIST_DRIVE_FOLDER_ID must be set in .env');
    process.exit(1);
  }

  const auth   = makeAuth();
  const drive  = google.drive({ version: 'v3', auth });
  const sheets = google.sheets({ version: 'v4', auth });

  // ── 1. Read sheet: which projects have PL / PR ───────────
  console.log('Reading Pre-construction Data sheet…');
  const sheetRes = await sheets.spreadsheets.values.get({
    spreadsheetId: PRE_CONSTRUCTION_ID,
    range:         'Pre-construction Data!A:G',
  });
  const sheetRows = sheetRes.data.values || [];

  // norm(name) → { name, hasPriceList, hasPriceRange }
  const sheetMap = new Map();
  for (const row of sheetRows) {
    const name = (row[0] || '').trim();
    if (!name) continue;
    const hasPriceList  = (row[5] || '').toUpperCase() === 'TRUE';
    const hasPriceRange = (row[6] || '').toUpperCase() === 'TRUE';
    if (hasPriceList || hasPriceRange) {
      sheetMap.set(norm(name), { name, hasPriceList, hasPriceRange });
    }
  }
  console.log(`  ${sheetMap.size} projects with price docs in sheet\n`);

  // ── 2. Build neededDocs from projects.json ───────────────
  const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));
  const targets  = targetSlug ? projects.filter(p => p.slug === targetSlug) : projects;

  // norm(name) → slug (for fast file-to-project matching later)
  const normToSlug = new Map();

  // slug → { project, needsPL, needsPR }
  const neededDocs = new Map();

  for (const p of targets) {
    // Find sheet entry for this project
    const normName = norm(p.name);
    let sheetInfo = sheetMap.get(normName);

    // Substring fallback — handles minor additions like location suffixes
    // (e.g. "Cipriani Residences" ↔ "Cipriani Residences Miami")
    // Both strings must be at least 10 chars to avoid short-string false matches
    if (!sheetInfo) {
      for (const [key, info] of sheetMap) {
        const shorter = normName.length < key.length ? normName : key;
        if (shorter.length >= 10 &&
            (normName.includes(key) || key.includes(normName))) {
          sheetInfo = info;
          break;
        }
      }
    }
    if (!sheetInfo) continue;

    // Respect special priceList configs (externalUrl / heading / message)
    if (p.priceList && (p.priceList.externalUrl || p.priceList.heading || p.priceList.message)) {
      continue;
    }

    const needsPL = sheetInfo.hasPriceList  && (isForce || !(p.priceList  && p.priceList.driveFileId));
    const needsPR = sheetInfo.hasPriceRange && (isForce || !(p.priceRange && p.priceRange.driveFileId));
    if (!needsPL && !needsPR) continue;

    neededDocs.set(p.slug, { project: p, needsPL, needsPR });

    // Register name variants for fast lookup
    for (const key of [p.name, p.esqueletoName, p.tpDataName].filter(Boolean)) {
      normToSlug.set(norm(key), p.slug);
    }
  }

  console.log(`${neededDocs.size} project(s) need price docs\n`);

  // ── 3. Traverse year → month → files ────────────────────
  let updatedPL = 0;
  let updatedPR = 0;

  if (neededDocs.size > 0) {
    let yearFolders = (await listChildren(drive, PRICE_FOLDER_ID))
      .filter(f => f.mimeType === 'application/vnd.google-apps.folder')
      .filter(f => /price list \d{4}/i.test(f.name))
      .sort((a, b) => {
        const ya = parseInt((a.name.match(/\d{4}/) || ['0'])[0], 10);
        const yb = parseInt((b.name.match(/\d{4}/) || ['0'])[0], 10);
        return yb - ya; // most-recent year first
      });

    // --current-month: only look at this year's folder (skips all historical years)
    if (isCurrentMonth) {
      yearFolders = yearFolders.filter(f =>
        parseInt((f.name.match(/\d{4}/) || ['0'])[0], 10) === todayYear
      );
      console.log(`[--current-month] Restricting to year ${todayYear}, month ${todayMonthNum} (${MONTHS[todayMonthNum - 1]})\n`);
    }

    console.log(`Found ${yearFolders.length} year folder(s): ${yearFolders.map(f => f.name).join(', ')}\n`);

  outer: for (const yearFolder of yearFolders) {
    const year = parseInt((yearFolder.name.match(/\d{4}/) || ['0'])[0], 10);

    // List and sort month folders descending by month number
    let monthFolders = (await listChildren(drive, yearFolder.id))
      .filter(f => f.mimeType === 'application/vnd.google-apps.folder')
      .map(f => {
        const m = f.name.match(/price list (\d+)/i);
        return { ...f, monthNum: m ? parseInt(m[1], 10) : 0 };
      })
      .filter(f => f.monthNum > 0)
      .sort((a, b) => b.monthNum - a.monthNum); // most-recent month first

    // --current-month: only look at this month's folder
    if (isCurrentMonth) {
      monthFolders = monthFolders.filter(f => f.monthNum === todayMonthNum);
    }

    console.log(`  ${yearFolder.name}: ${monthFolders.length} month folder(s)`);

    for (const monthFolder of monthFolders) {
      const monthName = MONTHS[monthFolder.monthNum - 1] || String(monthFolder.monthNum);

      const files = await listChildren(drive, monthFolder.id);
      // Sort newest-first by modifiedTime — when admins replace a price list by
      // uploading a NEW file with the same name (instead of "Manage versions"),
      // Drive ends up with multiple files matching the same project. The script
      // stops at the first match per project, so we must scan the newest first
      // to guarantee the latest version wins.
      files.sort((a, b) =>
        new Date(b.modifiedTime || 0).getTime() - new Date(a.modifiedTime || 0).getTime()
      );
      let matchedThisMonth = 0;

      for (const file of files) {
        if (!file.name.toLowerCase().endsWith('.pdf')) continue;

        // Extract project name and doc type from filename
        const m = file.name.match(/^(.+?)\s*-\s*Price (List|Range)\s+\d+\.pdf$/i);
        if (!m) continue;

        const fileProjectNorm = norm(m[1]);
        const docType         = m[2].toLowerCase(); // 'list' or 'range'

        // Fast exact lookup
        let slug = normToSlug.get(fileProjectNorm);

        // Substring fallback — immune to same-brand/different-location false
        // positives: "Ritz-Carlton Bal Harbour" will NOT match "Ritz-Carlton
        // West Palm Beach" because neither string is a substring of the other
        if (!slug) {
          for (const [key, s] of normToSlug) {
            const shorter = fileProjectNorm.length < key.length ? fileProjectNorm : key;
            if (shorter.length >= 10 &&
                (fileProjectNorm.includes(key) || key.includes(fileProjectNorm))) {
              slug = s;
              break;
            }
          }
        }

        // "West Palm Beach" / "Palm Beach" fallback
        // Drive files often say "West Palm Beach"; projects.json may say "Palm Beach"
        if (!slug) {
          const stripWest = s => s.replace(/\bwest\b\s*/g, '').replace(/\s+/g, ' ').trim();
          const fileProjStripped = stripWest(fileProjectNorm);
          for (const [key, s] of normToSlug) {
            if (stripWest(key) === fileProjStripped) { slug = s; break; }
          }
        }
        if (!slug) continue;

        const nd = neededDocs.get(slug);
        if (!nd) continue;

        // Build createdAt from the file's modifiedTime when available (gives exact day),
        // falling back to the folder-derived month/year if modifiedTime is absent.
        const fileDate   = file.modifiedTime ? new Date(file.modifiedTime) : null;
        const plDay      = fileDate ? fileDate.getUTCDate() : null;
        const plMonth    = fileDate ? (MONTHS[fileDate.getUTCMonth()] || monthName) : monthName;
        const plYear     = fileDate ? fileDate.getUTCFullYear() : year;
        const createdAt  = plDay
          ? `As of ${plMonth} ${plDay}, ${plYear}`
          : `As of ${monthName}, ${year}`;

        if (docType === 'list' && nd.needsPL) {
          if (isDry) {
            console.log(`    ✓ [PL] ${nd.project.name}`);
            console.log(`         ${file.name} (${createdAt})`);
          } else {
            const idx = projects.findIndex(p => p.slug === slug);
            if (idx !== -1) projects[idx].priceList = { driveFileId: file.id, createdAt };
          }
          nd.needsPL = false;
          updatedPL++;
          matchedThisMonth++;
        } else if (docType === 'range' && nd.needsPR) {
          if (isDry) {
            console.log(`    ✓ [PR] ${nd.project.name}`);
            console.log(`         ${file.name} (${createdAt})`);
          } else {
            const idx = projects.findIndex(p => p.slug === slug);
            if (idx !== -1) projects[idx].priceRange = { driveFileId: file.id, createdAt };
          }
          nd.needsPR = false;
          updatedPR++;
          matchedThisMonth++;
        }
      }

      if (matchedThisMonth > 0) {
        console.log(`    → ${matchedThisMonth} match(es) in ${monthFolder.name}`);
      }

      // Early exit once all projects are resolved
      const remaining = [...neededDocs.values()].filter(nd => nd.needsPL || nd.needsPR);
      if (remaining.length === 0) break outer;
    }
  } // end outer for
  } // end if (neededDocs.size > 0)

  // ── 4. Report unresolved ─────────────────────────────────
  const unresolved = [...neededDocs.values()].filter(nd => nd.needsPL || nd.needsPR);
  if (unresolved.length) {
    console.log(`\n⚠  ${unresolved.length} project(s) not found in Drive:`);
    for (const nd of unresolved) {
      const missing = [
        nd.needsPL ? 'Price List'  : null,
        nd.needsPR ? 'Price Range' : null,
      ].filter(Boolean).join(', ');
      console.log(`  ✗ ${nd.project.name} — missing: ${missing}`);
    }
  }

  // ── 5. Cleanup: clear doc fields that the sheet says don't exist ─
  // The old seed-pricelist-links.js sometimes wrote price-range PDFs into
  // priceList because it only read col M (Drive URL) without checking doc type.
  // This corrects those cases based on the authoritative sheet data.
  let clearedPL = 0, clearedPR = 0;
  const findSheetInfo = (p) => {
    const n = norm(p.name);
    let info = sheetMap.get(n);
    if (!info) {
      for (const [key, i] of sheetMap) {
        const shorter = n.length < key.length ? n : key;
        if (shorter.length >= 10 && (n.includes(key) || key.includes(n))) {
          info = i; break;
        }
      }
    }
    return info;
  };

  for (const p of targets) {
    const info = findSheetInfo(p);
    if (!info) continue;
    // Skip projects with custom priceList config
    if (p.priceList && (p.priceList.externalUrl || p.priceList.heading || p.priceList.message)) continue;

    // Sheet says no price list → clear any stale driveFileId
    if (!info.hasPriceList && p.priceList && p.priceList.driveFileId) {
      if (isDry) {
        console.log(`  ~ [CLEAR PL] ${p.name} — sheet marks as range-only`);
      } else {
        const idx = projects.findIndex(proj => proj.slug === p.slug);
        if (idx !== -1) { projects[idx].priceList = null; clearedPL++; }
      }
    }
    // Sheet says no price range → clear any stale driveFileId
    if (!info.hasPriceRange && p.priceRange && p.priceRange.driveFileId) {
      if (isDry) {
        console.log(`  ~ [CLEAR PR] ${p.name} — sheet marks as list-only`);
      } else {
        const idx = projects.findIndex(proj => proj.slug === p.slug);
        if (idx !== -1) { projects[idx].priceRange = null; clearedPR++; }
      }
    }
  }
  if (clearedPL || clearedPR) {
    console.log(`\nCleanup: cleared ${clearedPL} stale priceList(s), ${clearedPR} stale priceRange(s)`);
  }

  // ── 6. Write or summarise ────────────────────────────────
  if (!isDry) {
    fs.writeFileSync(PROJECTS_JSON, JSON.stringify(projects, null, 2) + '\n', 'utf8');
    console.log(`\n✓ Done`);
    console.log(`  ${updatedPL}  price lists updated`);
    console.log(`  ${updatedPR}  price ranges updated`);
    if (updatedPL + updatedPR > 0) {
      console.log('\nNext: git add data/projects.json && git commit -m "chore: seed price lists from Drive"');
    }
  } else {
    console.log('\n[DRY RUN — no files written]');
    console.log(`  ${updatedPL}  price lists would be updated`);
    console.log(`  ${updatedPR}  price ranges would be updated`);
    console.log('Remove --dry to apply.');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
