'use strict';

/**
 * verify-preview-failures.js
 * ─────────────────────────────────────────────────────────────────────────
 * Takes the HIGH RISK + AT RISK files from audit-heavy-docs.js and tries to
 * confirm which of them Drive *actually* refuses to preview, vs which ones
 * load (even if a few internal pages may still fail).
 *
 * Two signals are combined:
 *
 *   1. Drive API field `hasThumbnail` — false means Drive's preview engine
 *      gave up on the file entirely. This is the strongest signal of the
 *      "This file is too large to preview" error.
 *
 *   2. Live fetch of https://drive.google.com/thumbnail?id={id}&sz=w400 —
 *      Drive serves this thumbnail through the same pipeline that drives
 *      page-level rendering. If it returns 404 / non-image, page-level
 *      previews will also fail.
 *
 *   3. File size for context.
 *
 * Files where hasThumbnail = false OR thumbnail fetch fails are classified
 * as CONFIRMED FAIL. Files where both succeed but size > 25 MB are flagged
 * as POSSIBLE PAGE-LEVEL FAIL — Drive can render page 1 but high-DPI inner
 * pages might still throw "There was a problem loading this page".
 *
 * Usage:
 *   node scripts/verify-preview-failures.js              # 25 MB threshold
 *   node scripts/verify-preview-failures.js --min 50     # only HIGH RISK
 *   node scripts/verify-preview-failures.js --json
 *
 * Why we can't just open each URL: there is no Drive API that says "can a
 * human render this in the embed viewer". The HTML viewer reports errors
 * client-side after attempting to fetch each page tile. The fields above
 * are the closest server-side proxies.
 * ─────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { google } = require('googleapis');
const fs    = require('fs');
const path  = require('path');
const https = require('https');

const PROJECTS_JSON = path.join(__dirname, '../data/projects.json');
const DOC_FIELDS = ['brochures', 'factSheets', 'presentations', 'floorPlans'];

function parseArgs() {
  const args = process.argv.slice(2);
  const minIdx = args.indexOf('--min');
  return {
    minMB: minIdx !== -1 ? parseFloat(args[minIdx + 1]) : 25,
    json:  args.includes('--json'),
  };
}

function makeAuth() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key:   (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
}

// HEAD request to thumbnail URL — return { ok, status, contentType }
function checkThumbnail(driveFileId) {
  return new Promise((resolve) => {
    const url = `https://drive.google.com/thumbnail?id=${driveFileId}&sz=w400`;
    const req = https.request(url, { method: 'GET' }, (res) => {
      // Follow 1 redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        https.get(res.headers.location, (res2) => {
          const ok = res2.statusCode === 200 &&
                     (res2.headers['content-type'] || '').startsWith('image/');
          res2.resume();
          resolve({ ok, status: res2.statusCode, contentType: res2.headers['content-type'] });
        }).on('error', () => resolve({ ok: false, status: 0 }));
        res.resume();
        return;
      }
      const ok = res.statusCode === 200 &&
                 (res.headers['content-type'] || '').startsWith('image/');
      res.resume();
      resolve({ ok, status: res.statusCode, contentType: res.headers['content-type'] });
    });
    req.on('error', () => resolve({ ok: false, status: 0 }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ ok: false, status: 'timeout' }); });
    req.end();
  });
}

async function main() {
  const { minMB, json } = parseArgs();
  const minBytes = minMB * 1024 * 1024;

  const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));
  const auth = makeAuth();
  const drive = google.drive({ version: 'v3', auth });

  // Step 1: get sizes + hasThumbnail for all candidate docs
  const queue = [];
  for (const p of projects) {
    for (const field of DOC_FIELDS) {
      for (const item of p[field] || []) {
        if (item.driveFileId) queue.push({ slug: p.slug, field, item });
      }
    }
  }

  if (!json) console.log(`Stage 1: fetching size + hasThumbnail for ${queue.length} docs...`);
  const meta = [];
  let nextIdx = 0;
  const CONCURRENCY = 6;
  async function metaWorker() {
    while (nextIdx < queue.length) {
      const e = queue[nextIdx++];
      try {
        const { data } = await drive.files.get({
          fileId: e.item.driveFileId,
          fields: 'name,size,hasThumbnail,thumbnailLink',
          supportsAllDrives: true,
        });
        const size = parseInt(data.size || '0', 10);
        meta.push({
          ...e,
          driveName:     data.name,
          size,
          hasThumbnail:  data.hasThumbnail !== false,
          thumbnailLink: data.thumbnailLink,
        });
      } catch (err) {
        meta.push({ ...e, error: err.message });
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => metaWorker()));

  // Filter to heavy candidates
  const candidates = meta.filter(m => !m.error && m.size >= minBytes);
  if (!json) console.log(`Stage 2: live thumbnail fetch for ${candidates.length} heavy candidates...`);

  // Step 2: live thumbnail fetch for each (in parallel, 8 at a time — outbound HTTP, no quota)
  let nextC = 0;
  const FETCH_CONC = 8;
  async function thumbWorker() {
    while (nextC < candidates.length) {
      const i = nextC++;
      const c = candidates[i];
      c.thumbCheck = await checkThumbnail(c.item.driveFileId);
    }
  }
  await Promise.all(Array.from({ length: FETCH_CONC }, () => thumbWorker()));

  // Classify
  const confirmedFail = [];
  const possiblePageFail = [];
  for (const c of candidates) {
    const failedApi   = !c.hasThumbnail;
    const failedFetch = c.thumbCheck && !c.thumbCheck.ok;
    if (failedApi || failedFetch) confirmedFail.push(c);
    else possiblePageFail.push(c);
  }

  if (json) {
    console.log(JSON.stringify({
      scanned: candidates.length,
      confirmedFail: confirmedFail.map(toRow),
      possiblePageFail: possiblePageFail.map(toRow),
    }, null, 2));
    return;
  }

  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(`  RESULTS  (${minMB} MB threshold, ${candidates.length} candidates checked)`);
  console.log(`══════════════════════════════════════════════════════════════════`);
  console.log(`  🔴 CONFIRMED preview failure:        ${confirmedFail.length}`);
  console.log(`  🟡 POSSIBLE page-level failure:      ${possiblePageFail.length}`);
  console.log(``);
  console.log(`Confirmed = Drive's preview engine either could not generate`);
  console.log(`a thumbnail (hasThumbnail=false) or live thumbnail fetch failed.`);
  console.log(`These ARE broken — the team can stop checking and just compress.`);
  console.log(``);
  console.log(`Possible = Drive processes page 1 fine. Inner pages may still`);
  console.log(`error out at runtime ("There was a problem loading this page").`);

  printGroup('🔴 CONFIRMED preview failure', confirmedFail);
  printGroup('🟡 POSSIBLE page-level failure (Drive renders page 1)', possiblePageFail);
}

function toRow(c) {
  return {
    slug: c.slug,
    field: c.field,
    title: c.item.title || c.driveName,
    sizeMB: +(c.size / 1024 / 1024).toFixed(1),
    hasThumbnail: c.hasThumbnail,
    thumbFetchOk: c.thumbCheck && c.thumbCheck.ok,
    thumbStatus:  c.thumbCheck && c.thumbCheck.status,
    driveUrl: `https://drive.google.com/file/d/${c.item.driveFileId}/view`,
  };
}

function printGroup(label, items) {
  if (!items.length) return;
  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(`  ${label}  —  ${items.length} files`);
  console.log(`══════════════════════════════════════════════════════════════════`);
  items.sort((a, b) => b.size - a.size);
  for (const c of items) {
    const mb = (c.size / 1024 / 1024).toFixed(1);
    const title = c.item.title || c.driveName;
    const reason = !c.hasThumbnail
      ? '(API hasThumbnail=false)'
      : (c.thumbCheck && !c.thumbCheck.ok)
        ? `(thumbnail fetch ${c.thumbCheck.status})`
        : '(both checks passed, size-only flag)';
    console.log(`\n  ${mb.padStart(5)} MB  ${c.slug}  /  ${c.field}  ${reason}`);
    console.log(`             "${title}"`);
    console.log(`             https://drive.google.com/file/d/${c.item.driveFileId}/view`);
  }
}

main().catch(err => { console.error('\n[fatal]', err); process.exit(1); });
