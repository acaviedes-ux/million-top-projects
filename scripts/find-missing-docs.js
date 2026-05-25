'use strict';

/**
 * find-missing-docs.js
 * ─────────────────────────────────────────────────────────────
 * Scans ALL Drive year/month folders to find Price List and Price Range
 * PDFs for specific project slugs — bypasses the Pre-construction sheet
 * filter so it works even when hasPriceRange = FALSE in the sheet.
 *
 * Usage:
 *   node scripts/find-missing-docs.js --dry    # preview only (default)
 *   node scripts/find-missing-docs.js          # apply to projects.json
 *
 * Requires .env:
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL
 *   GOOGLE_PRIVATE_KEY
 *   PRICE_LIST_DRIVE_FOLDER_ID
 * ─────────────────────────────────────────────────────────────
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

// ── Slugs to search for ───────────────────────────────────────────────────────
// Add any slug from projects.json that is missing PL or PR
const TARGET_SLUGS = [
  'the-residences-at-mandarin-oriental-west-palm-beach',
  'mandarin-oriental-miami',
  'the-residences-at-mandarin-oriental-boca-raton',
  'the-berkeley',   // PR may be outdated — find most recent
];

// ── Auth ──────────────────────────────────────────────────────────────────────

function makeAuth() {
  return new google.auth.JWT({
    email:  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key:    (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    subject: process.env.GOOGLE_IMPERSONATE_EMAIL || undefined,
  });
}

// ── Drive helpers ─────────────────────────────────────────────────────────────

async function listChildren(drive, folderId) {
  const all = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q:                         `'${folderId}' in parents and trashed = false`,
      fields:                    'nextPageToken, files(id, name, mimeType, modifiedTime)',
      pageSize:                  1000,
      pageToken,
      supportsAllDrives:         true,
      includeItemsFromAllDrives: true,
    });
    all.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return all;
}

// ── Name normalization ────────────────────────────────────────────────────────

function norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[®™'']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const isDry = !process.argv.includes('--apply');

  if (isDry) {
    console.log('[DRY RUN] Pass --apply to write changes to projects.json\n');
  }

  if (!PRICE_FOLDER_ID) {
    console.error('Error: PRICE_LIST_DRIVE_FOLDER_ID must be set in .env');
    process.exit(1);
  }

  const auth  = makeAuth();
  const drive = google.drive({ version: 'v3', auth });

  const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));

  // Build lookup: slug → project
  const slugMap = new Map(projects.map(p => [p.slug, p]));

  // For each target slug: what are we looking for?
  const targets = TARGET_SLUGS
    .map(slug => {
      const p = slugMap.get(slug);
      if (!p) { console.warn(`⚠  Slug not found in projects.json: ${slug}`); return null; }
      return {
        slug,
        project: p,
        normNames: [p.name, p.esqueletoName, p.tpDataName]
          .filter(Boolean)
          .map(norm),
        needsPL: !p.priceList?.driveFileId,
        needsPR: !p.priceRange?.driveFileId,
        // For "find most recent" (e.g. Berkeley), always look for PR
        forcePR: slug === 'the-berkeley',
      };
    })
    .filter(Boolean);

  // Override needsPR for force targets
  for (const t of targets) {
    if (t.forcePR) t.needsPR = true;
  }

  console.log(`Searching for ${targets.length} project(s) across all Drive folders…\n`);

  // best match per (slug, docType): { fileId, createdAt, modifiedTime }
  const best = new Map(); // key: `${slug}:list` or `${slug}:range`

  // Traverse year → month → files (most recent first)
  const yearFolders = (await listChildren(drive, PRICE_FOLDER_ID))
    .filter(f => f.mimeType === 'application/vnd.google-apps.folder')
    .filter(f => /price list \d{4}/i.test(f.name))
    .sort((a, b) => {
      const ya = parseInt((a.name.match(/\d{4}/) || ['0'])[0], 10);
      const yb = parseInt((b.name.match(/\d{4}/) || ['0'])[0], 10);
      return yb - ya;
    });

  for (const yearFolder of yearFolders) {
    const year = parseInt((yearFolder.name.match(/\d{4}/) || ['0'])[0], 10);

    const monthFolders = (await listChildren(drive, yearFolder.id))
      .filter(f => f.mimeType === 'application/vnd.google-apps.folder')
      .map(f => {
        const m = f.name.match(/price list (\d+)/i);
        return { ...f, monthNum: m ? parseInt(m[1], 10) : 0 };
      })
      .filter(f => f.monthNum > 0)
      .sort((a, b) => b.monthNum - a.monthNum);

    for (const monthFolder of monthFolders) {
      const monthName = MONTHS[monthFolder.monthNum - 1];
      const files = await listChildren(drive, monthFolder.id);

      for (const file of files) {
        if (!file.name.toLowerCase().endsWith('.pdf')) continue;

        const m = file.name.match(/^(.+?)\s*-\s*Price (List|Range)\s+\d+\.pdf$/i);
        if (!m) continue;

        const fileNorm = norm(m[1]);
        const docType  = m[2].toLowerCase(); // 'list' or 'range'

        for (const t of targets) {
          if (docType === 'list' && !t.needsPL) continue;
          if (docType === 'range' && !t.needsPR) continue;

          const key = `${t.slug}:${docType}`;
          if (best.has(key)) continue; // already found a more-recent one (folders sorted newest-first)

          const matches = t.normNames.some(n => {
            if (fileNorm === n) return true;
            const shorter = fileNorm.length < n.length ? fileNorm : n;
            if (shorter.length >= 8 && (fileNorm.includes(n) || n.includes(fileNorm))) return true;
            // West Palm Beach / Palm Beach fallback
            const strip = s => s.replace(/\bwest\b\s*/g, '').replace(/\s+/g, ' ').trim();
            return strip(fileNorm) === strip(n);
          });

          if (matches) {
            const fileDate = file.modifiedTime ? new Date(file.modifiedTime) : null;
            const day      = fileDate ? fileDate.getUTCDate() : null;
            const month    = fileDate ? (MONTHS[fileDate.getUTCMonth()] || monthName) : monthName;
            const yr       = fileDate ? fileDate.getUTCFullYear() : year;
            const createdAt = day
              ? `As of ${month} ${day}, ${yr}`
              : `As of ${monthName}, ${year}`;

            best.set(key, { fileId: file.id, createdAt, fileName: file.name });
            console.log(`  ✓ [${docType === 'list' ? 'PL' : 'PR'}] ${t.project.name}`);
            console.log(`       ${file.name}`);
            console.log(`       ${createdAt} (in ${yearFolder.name} / ${monthFolder.name})`);
          }
        }
      }
    }
  }

  // ── Report and apply ──────────────────────────────────────────────────────

  console.log('\n── SUMMARY ─────────────────────────────────────────────\n');
  let updatedCount = 0;

  for (const t of targets) {
    const plKey = `${t.slug}:list`;
    const prKey = `${t.slug}:range`;
    const plFound = best.get(plKey);
    const prFound = best.get(prKey);

    console.log(t.project.name);
    if (t.needsPL) {
      console.log(`  PL: ${plFound ? '✓ found → ' + plFound.createdAt : '✗ NOT FOUND in Drive'}`);
    }
    if (t.needsPR) {
      const current = t.project.priceRange?.createdAt;
      const label   = t.forcePR && current ? `(replaces ${current})` : '';
      console.log(`  PR: ${prFound ? '✓ found → ' + prFound.createdAt + ' ' + label : '✗ NOT FOUND in Drive'}`);
    }

    if (!isDry) {
      const idx = projects.findIndex(p => p.slug === t.slug);
      if (idx === -1) continue;
      if (t.needsPL && plFound) {
        projects[idx].priceList  = { driveFileId: plFound.fileId, createdAt: plFound.createdAt };
        updatedCount++;
      }
      if (t.needsPR && prFound) {
        projects[idx].priceRange = { driveFileId: prFound.fileId, createdAt: prFound.createdAt };
        updatedCount++;
      }
    }
  }

  if (!isDry && updatedCount > 0) {
    fs.writeFileSync(PROJECTS_JSON, JSON.stringify(projects, null, 2) + '\n', 'utf8');
    console.log(`\n✓ Applied ${updatedCount} update(s) to projects.json`);
    console.log('Next: git add data/projects.json && git commit -m "fix: seed missing price range docs"');
  } else if (isDry) {
    console.log('\n[DRY RUN — no changes written. Run with --apply to update projects.json]');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
