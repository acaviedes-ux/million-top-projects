/**
 * make-drive-files-public.js
 * ──────────────────────────────────────────────────────
 * Sets "anyone → reader" permission on every Drive file
 * referenced in data/projects.json (brochures, factSheets,
 * floorPlans, presentations, renderings, priceList, priceRange).
 *
 * This is required so that drive.google.com/thumbnail?id=… URLs
 * resolve correctly on the public website without Google auth.
 *
 * Usage:
 *   node scripts/make-drive-files-public.js           # apply
 *   node scripts/make-drive-files-public.js --dry     # preview only
 */

'use strict';

require('dotenv').config();
const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

const PROJECTS_JSON = path.join(__dirname, '../data/projects.json');

function makeAuth() {
  return new google.auth.JWT({
    email:  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key:    (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
}

async function main() {
  const isDry = process.argv.includes('--dry');
  const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));

  // Collect all unique driveFileIds across all doc fields
  const fileIds = new Set();
  for (const p of projects) {
    for (const arr of [p.brochures, p.factSheets, p.floorPlans, p.presentations]) {
      for (const doc of (arr || [])) {
        if (doc && doc.driveFileId) fileIds.add(doc.driveFileId);
      }
    }
    for (const r of (p.renderings || [])) {
      if (r && r.driveFileId) fileIds.add(r.driveFileId);
    }
    if (p.priceList  && p.priceList.driveFileId)  fileIds.add(p.priceList.driveFileId);
    if (p.priceRange && p.priceRange.driveFileId) fileIds.add(p.priceRange.driveFileId);
  }

  console.log(`Found ${fileIds.size} unique Drive file IDs\n`);
  if (isDry) {
    console.log('[DRY RUN] Would set public reader on:');
    for (const id of fileIds) console.log(' ', id);
    return;
  }

  const drive = google.drive({ version: 'v3', auth: makeAuth() });

  // Counters are shared across parallel workers
  let ok = 0, skip = 0, err = 0, done = 0;
  const total = fileIds.size;

  // Process one file: check direct permission, add anyone:reader if missing.
  // The Drive API returns inherited permissions from parent folders. Those
  // grants are real for normal viewing but DON'T satisfy the
  // drive.google.com/file/d/ID/preview iframe embed — that needs a direct
  // file-level grant. permissionDetails[].inherited === false flags it.
  async function processFile(fileId) {
    try {
      const existing = await drive.permissions.list({
        fileId,
        supportsAllDrives: true,
        fields: 'permissions(id,type,role,permissionDetails)',
      });
      const hasDirectPublic = (existing.data.permissions || []).some(p =>
        p.type === 'anyone' &&
        p.role === 'reader' &&
        (p.permissionDetails || []).some(d => d.inherited === false)
      );

      if (hasDirectPublic) {
        skip++;
      } else {
        await drive.permissions.create({
          fileId,
          supportsAllDrives: true,
          requestBody: { type: 'anyone', role: 'reader' },
        });
        ok++;
      }
    } catch (e) {
      err++;
      console.error(`\n  ✗ ${fileId}: ${e.message}`);
    } finally {
      done++;
      // Progress every 50 files: keeps GitHub Actions log readable
      if (done % 50 === 0) {
        console.log(`  ${done}/${total} (${ok} added, ${skip} skipped, ${err} errors)`);
      }
    }
  }

  // Concurrency-limited worker pool. 8 parallel requests is well below
  // Drive's 1000/100s quota and keeps total runtime under ~3 min for ~10k
  // files — comfortably within the workflow's 10-min timeout.
  const CONCURRENCY = 8;
  const queue = [...fileIds];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const fileId = queue.shift();
      if (fileId) await processFile(fileId);
    }
  });
  await Promise.all(workers);

  console.log(`\n✓ Done`);
  console.log(`  ${ok} files made public`);
  console.log(`  ${skip} already public (skipped)`);
  if (err) console.log(`  ${err} errors`);
}

main().catch(err => { console.error(err); process.exit(1); });
