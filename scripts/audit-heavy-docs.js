'use strict';

/**
 * audit-heavy-docs.js
 * ─────────────────────────────────────────────────────────────────────────
 * Scans every brochure / fact sheet / presentation / floor plan referenced
 * in data/projects.json and reports those above a size threshold that have
 * historically failed to preview inside Google Drive's PDF viewer
 * ("Couldn't preview file — There was a problem loading this page").
 *
 * Drive's PDF preview engine reliably handles files up to ~25 MB. Past that,
 * preview success depends on the PDF's internal complexity (embedded images,
 * fonts, etc.) — a 30 MB plain text PDF previews fine, a 30 MB floor-plan
 * PDF with hi-res raster images often does not.
 *
 * Output: per-project list of suspicious files with size, Drive view URL,
 * and a recommendation. Use the URL to open the PDF in Drive and either:
 *   • Verify it actually previews (false positive — leave it)
 *   • Re-export it at a lower DPI / image quality
 *   • Run a PDF compressor like ilovepdf.com/compress_pdf
 *
 * After fixing files, the docs sync workflow will pick up the new versions
 * automatically (Drive assigns a new file ID on re-upload, the sweep
 * captures it on its next run).
 *
 * Usage:
 *   node scripts/audit-heavy-docs.js              # default: report ≥25 MB
 *   node scripts/audit-heavy-docs.js --min 15     # custom threshold (MB)
 *   node scripts/audit-heavy-docs.js --json       # machine-readable output
 *   node scripts/audit-heavy-docs.js --slug foo   # single project
 * ─────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

const PROJECTS_JSON = path.join(__dirname, '../data/projects.json');

// Fields we audit. Renderings are excluded — their heavy-file handling is
// already covered by the `tooLarge` flag and the lh3 redirect in /api/render.
const DOC_FIELDS = ['brochures', 'factSheets', 'presentations', 'floorPlans'];

// Tier thresholds, in bytes
const TIER_HIGH_RISK_MB = 50;   // very likely to fail preview
const TIER_AT_RISK_MB   = 25;   // possible preview failure depending on content

function makeAuth() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key:   (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
}

function parseArgs() {
  const args = process.argv.slice(2);
  const minIdx  = args.indexOf('--min');
  const slugIdx = args.indexOf('--slug');
  return {
    minMB:      minIdx  !== -1 ? parseFloat(args[minIdx + 1])  : TIER_AT_RISK_MB,
    targetSlug: slugIdx !== -1 ? args[slugIdx + 1] : null,
    json:       args.includes('--json'),
  };
}

async function main() {
  const { minMB, targetSlug, json } = parseArgs();
  const minBytes = minMB * 1024 * 1024;

  const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));
  const auth  = makeAuth();
  const drive = google.drive({ version: 'v3', auth });

  // Build the work queue: every (project, field, item) tuple with a driveFileId
  const queue = [];
  for (const p of projects) {
    if (targetSlug && p.slug !== targetSlug) continue;
    for (const field of DOC_FIELDS) {
      for (const item of p[field] || []) {
        if (item.driveFileId) {
          queue.push({ slug: p.slug, name: p.name, field, item });
        }
      }
    }
  }

  if (!json) {
    console.log(`Auditing ${queue.length} document references` +
                (targetSlug ? ` for ${targetSlug}` : '') +
                ` (threshold: ${minMB} MB)...\n`);
  }

  // Parallel fetch — same worker-pool pattern as the seed script. 6 workers
  // stays well within Drive's ~10 req/s per-user quota.
  const CONCURRENCY = 6;
  const results = [];
  let nextIdx = 0, done = 0, errors = 0;

  async function worker() {
    while (nextIdx < queue.length) {
      const i = nextIdx++;
      const entry = queue[i];
      try {
        const { data } = await drive.files.get({
          fileId: entry.item.driveFileId,
          fields: 'name,size,mimeType,trashed',
          supportsAllDrives: true,
        });
        const size = parseInt(data.size || '0', 10);
        results.push({
          ...entry,
          driveName: data.name,
          size,
          mime: data.mimeType,
          trashed: !!data.trashed,
        });
      } catch (err) {
        errors++;
        results.push({ ...entry, error: err.code || err.message });
      }
      done++;
      if (!json && done % 200 === 0) {
        process.stderr.write(`  scanned ${done}/${queue.length}\r`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // Categorize
  const broken   = results.filter(r => r.error || r.trashed);
  const heavy    = results.filter(r => !r.error && !r.trashed && r.size >= minBytes);
  const highRisk = heavy.filter(r => r.size >= TIER_HIGH_RISK_MB * 1024 * 1024);
  const atRisk   = heavy.filter(r => r.size <  TIER_HIGH_RISK_MB * 1024 * 1024);

  if (json) {
    console.log(JSON.stringify({
      scanned: results.length,
      broken: broken.length,
      heavyTotal: heavy.length,
      highRisk: highRisk.map(toReportRow),
      atRisk:   atRisk.map(toReportRow),
      brokenList: broken.map(r => ({
        slug: r.slug, field: r.field, driveFileId: r.item.driveFileId, error: r.error || 'trashed',
      })),
    }, null, 2));
    return;
  }

  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(`  SUMMARY`);
  console.log(`══════════════════════════════════════════════════════════════════`);
  console.log(`  Scanned:                       ${results.length}`);
  console.log(`  🔴 HIGH RISK (≥ ${TIER_HIGH_RISK_MB} MB):  ${highRisk.length}   ← almost certain to fail preview`);
  console.log(`  🟡 AT RISK (${minMB}–${TIER_HIGH_RISK_MB} MB):       ${atRisk.length}   ← preview may fail depending on PDF content`);
  console.log(`  ❌ Broken (404 / trashed):      ${broken.length}`);
  console.log('');

  printTier('🔴 HIGH RISK (≥ ' + TIER_HIGH_RISK_MB + ' MB)', highRisk);
  printTier('🟡 AT RISK (' + minMB + '–' + TIER_HIGH_RISK_MB + ' MB)', atRisk);

  if (broken.length) {
    console.log(`\n══════════════════════════════════════════════════════════════════`);
    console.log(`  BROKEN REFERENCES (file 404 or trashed in Drive)`);
    console.log(`══════════════════════════════════════════════════════════════════`);
    for (const r of broken) {
      console.log(`  ⚠ ${r.slug} / ${r.field}: ${r.error || 'trashed'}`);
      console.log(`     fileId: ${r.item.driveFileId}`);
    }
  }

  console.log('');
  console.log('Next step: open each Drive URL below, verify whether preview fails,');
  console.log('and if so, compress / re-export at lower DPI. The next docs sync');
  console.log('will automatically pick up the new file.');
}

function toReportRow(r) {
  return {
    slug:        r.slug,
    project:     r.name,
    field:       r.field,
    title:       r.item.title || r.driveName,
    sizeMB:      +(r.size / 1024 / 1024).toFixed(1),
    driveFileId: r.item.driveFileId,
    driveUrl:    `https://drive.google.com/file/d/${r.item.driveFileId}/view`,
  };
}

function printTier(title, items) {
  if (!items.length) return;
  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(`  ${title}  —  ${items.length} files`);
  console.log(`══════════════════════════════════════════════════════════════════`);

  items.sort((a, b) => b.size - a.size);
  for (const r of items) {
    const mb = (r.size / 1024 / 1024).toFixed(1);
    const title = r.item.title || r.driveName || '(no title)';
    console.log(`\n  ${mb.padStart(5)} MB  ${r.slug}  /  ${r.field}`);
    console.log(`             "${title}"`);
    console.log(`             https://drive.google.com/file/d/${r.item.driveFileId}/view`);
  }
}

main().catch(err => { console.error('\n[fatal]', err); process.exit(1); });
