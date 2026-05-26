'use strict';

/**
 * heal-trashed-pricelists.js
 * ─────────────────────────────────────────────────────────────────────────
 * Detects price list / price range Drive files that have been moved to the
 * trash AFTER being seeded into projects.json. When found, searches the
 * year/month price-list folder tree (newest first) for a non-trashed file
 * matching the project name and re-points projects.json at it.
 *
 * Background
 * ──────────
 * seed-pricelists-from-drive.js queries Drive with `trashed = false`, so it
 * never picks up a trashed file. But it can't react when a file goes to the
 * trash LATER — the projects.json reference becomes broken. End users see
 * "File is in owner's trash" instead of the PDF preview.
 *
 * This script closes that gap:
 *   1. Reads every driveFileId from projects.json (priceList + priceRange).
 *   2. Asks Drive for each file's `trashed` flag (8-way parallel).
 *   3. For trashed files, scans price-list year/month folders newest-first
 *      and picks the first non-trashed file whose name matches the project.
 *   4. Writes the corrected IDs back to projects.json.
 *
 * Usage
 * ─────
 *   node scripts/heal-trashed-pricelists.js          # apply
 *   node scripts/heal-trashed-pricelists.js --dry    # report only
 *
 * Env
 * ───
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY  — Drive auth
 *   PRICE_LIST_DRIVE_FOLDER_ID                        — root price folder
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
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
}

// ── Drive helpers ────────────────────────────────────────────────────────────

async function listChildren(drive, folderId, extraQuery = '') {
  const all = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false ${extraQuery}`,
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, trashed)',
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

// Normalize project names for fuzzy matching (handles ® ™ accents, etc.)
function norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[®™''']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ── Replacement finder ───────────────────────────────────────────────────────

/**
 * Build a `slug → { yearFolder, monthFolder, file }` index of non-trashed
 * price-list files, sorted newest first. Used to quickly find a replacement
 * for a trashed file without re-scanning Drive per project.
 */
async function buildIndex(drive, project, docType /* 'list' | 'range' */) {
  if (!PRICE_FOLDER_ID) throw new Error('PRICE_LIST_DRIVE_FOLDER_ID is required');

  const candidates = [];
  const targetNames = [project.name, project.esqueletoName, project.tpDataName]
    .filter(Boolean)
    .map(norm);

  // Year folders, newest first
  const yearFolders = (await listChildren(drive, PRICE_FOLDER_ID))
    .filter(f => f.mimeType === 'application/vnd.google-apps.folder')
    .filter(f => /price list \d{4}/i.test(f.name))
    .map(f => ({ ...f, year: parseInt((f.name.match(/\d{4}/) || ['0'])[0], 10) }))
    .sort((a, b) => b.year - a.year);

  for (const yearFolder of yearFolders) {
    const monthFolders = (await listChildren(drive, yearFolder.id))
      .filter(f => f.mimeType === 'application/vnd.google-apps.folder')
      .map(f => ({ ...f, monthNum: parseInt((f.name.match(/price list (\d+)/i) || ['','0'])[1], 10) }))
      .filter(f => f.monthNum > 0)
      .sort((a, b) => b.monthNum - a.monthNum); // newest month first

    for (const monthFolder of monthFolders) {
      const files = await listChildren(drive, monthFolder.id);

      for (const file of files) {
        if (!file.name.toLowerCase().endsWith('.pdf')) continue;
        const m = file.name.match(/^(.+?)\s*-\s*Price (List|Range)\s+\d+\.pdf$/i);
        if (!m) continue;
        if (m[2].toLowerCase() !== docType) continue;

        const fileNorm = norm(m[1]);
        const matches = targetNames.some(n => {
          if (fileNorm === n) return true;
          const shorter = fileNorm.length < n.length ? fileNorm : n;
          if (shorter.length >= 8 && (fileNorm.includes(n) || n.includes(fileNorm))) return true;
          // West Palm Beach / Palm Beach fallback
          const strip = s => s.replace(/\bwest\b\s*/g, '').replace(/\s+/g, ' ').trim();
          return strip(fileNorm) === strip(n);
        });

        if (matches) {
          // Return the first match — folders are already iterated newest-first
          const fileDate = file.modifiedTime ? new Date(file.modifiedTime) : null;
          const day      = fileDate ? fileDate.getUTCDate() : null;
          const month    = fileDate ? MONTHS[fileDate.getUTCMonth()] : null;
          const year     = fileDate ? fileDate.getUTCFullYear() : yearFolder.year;
          const createdAt = day
            ? `As of ${month} ${day}, ${year}`
            : `As of ${MONTHS[monthFolder.monthNum - 1]}, ${yearFolder.year}`;
          return { fileId: file.id, fileName: file.name, createdAt, folder: yearFolder.name + ' / ' + monthFolder.name };
        }
      }
    }
  }
  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const isDry = process.argv.includes('--dry');
  if (isDry) console.log('[DRY RUN] No changes will be written\n');

  const drive = google.drive({ version: 'v3', auth: makeAuth() });
  const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));

  // Step 1 — collect every (slug, kind, id) tuple we need to verify
  const docs = [];
  for (const p of projects) {
    if (p.priceList?.driveFileId)  docs.push({ slug: p.slug, project: p, kind: 'list',  id: p.priceList.driveFileId });
    if (p.priceRange?.driveFileId) docs.push({ slug: p.slug, project: p, kind: 'range', id: p.priceRange.driveFileId });
  }
  console.log(`Verifying ${docs.length} price documents...`);

  // Step 2 — check trashed status in parallel (Drive API quota allows this safely)
  const trashed = [];
  const queue = [...docs];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const doc = queue.shift();
      if (!doc) continue;
      try {
        const { data } = await drive.files.get({
          fileId: doc.id,
          supportsAllDrives: true,
          fields: 'trashed,name',
        });
        if (data.trashed) trashed.push({ ...doc, name: data.name });
      } catch (e) {
        // 404 / not found also counts as broken
        trashed.push({ ...doc, name: '(not found)', error: e.message });
      }
    }
  }));

  if (!trashed.length) {
    console.log('✓ All price documents are healthy — nothing to heal.');
    return;
  }

  console.log(`\nFound ${trashed.length} trashed/missing reference(s):`);
  trashed.forEach(t => console.log(`  ✗ ${t.slug} (${t.kind === 'list' ? 'PL' : 'PR'}): ${t.name}`));

  // Step 3 — for each broken reference, search for a replacement
  console.log('\nSearching for replacements...');
  const fixes = [];
  for (const t of trashed) {
    const replacement = await buildIndex(drive, t.project, t.kind);
    if (replacement) {
      console.log(`  ✓ ${t.slug} (${t.kind === 'list' ? 'PL' : 'PR'}) → ${replacement.fileName} (${replacement.folder})`);
      fixes.push({ ...t, replacement });
    } else {
      // No replacement anywhere — remove the broken reference so the UI falls
      // back to "Coming soon" instead of showing a trash error.
      console.log(`  ⚠ ${t.slug} (${t.kind === 'list' ? 'PL' : 'PR'}): no replacement found → will REMOVE reference`);
      fixes.push({ ...t, replacement: null });
    }
  }

  // Step 4 — apply fixes
  if (isDry) {
    console.log('\n[DRY RUN] Run without --dry to apply.');
    return;
  }

  for (const fix of fixes) {
    const proj = projects.find(p => p.slug === fix.slug);
    if (!proj) continue;
    const field = fix.kind === 'list' ? 'priceList' : 'priceRange';
    if (fix.replacement) {
      proj[field] = {
        driveFileId: fix.replacement.fileId,
        createdAt:   fix.replacement.createdAt,
      };
    } else {
      delete proj[field];
    }
  }

  fs.writeFileSync(PROJECTS_JSON, JSON.stringify(projects, null, 2) + '\n', 'utf8');
  console.log(`\n✓ Applied ${fixes.length} fix(es) to projects.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
