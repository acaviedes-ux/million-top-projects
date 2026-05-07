'use strict';

/**
 * update-pricelist-dates.js
 * ─────────────────────────────────────────────────────────────
 * Reads the driveFileId already stored in priceList / priceRange entries
 * of projects.json, fetches each file's modifiedTime from Drive, and
 * rewrites createdAt as "As of Month DD, YYYY".
 *
 * This is a one-shot backfill — use whenever projects.json has createdAt
 * values that are missing the day (e.g. "As of April, 2026").
 *
 * Usage:
 *   node scripts/update-pricelist-dates.js           # update all
 *   node scripts/update-pricelist-dates.js --dry     # preview only
 *   node scripts/update-pricelist-dates.js --slug brickell-flatiron
 *
 * Requires .env:
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL
 *   GOOGLE_PRIVATE_KEY
 * ─────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

const PROJECTS_JSON = path.join(__dirname, '../data/projects.json');

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

function makeAuth() {
  return new google.auth.JWT({
    email:  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key:    (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    subject: process.env.GOOGLE_IMPERSONATE_EMAIL || undefined,
  });
}

/** Fetch modifiedTime for a single file ID. Returns null on error. */
async function getModifiedTime(drive, fileId) {
  try {
    const res = await drive.files.get({
      fileId,
      fields: 'modifiedTime',
      supportsAllDrives: true,
    });
    return res.data.modifiedTime || null;
  } catch (err) {
    console.warn(`  ⚠ Could not fetch modifiedTime for ${fileId}: ${err.message}`);
    return null;
  }
}

/** Format a Drive ISO 8601 timestamp as "As of Month DD, YYYY". */
function formatDate(isoString) {
  const d = new Date(isoString);
  const day   = d.getUTCDate();
  const month = MONTHS[d.getUTCMonth()];
  const year  = d.getUTCFullYear();
  return `As of ${month} ${day}, ${year}`;
}

async function main() {
  const args       = process.argv.slice(2);
  const isDry      = args.includes('--dry');
  const slugIdx    = args.indexOf('--slug');
  const targetSlug = slugIdx !== -1 ? args[slugIdx + 1] : null;

  const auth  = makeAuth();
  const drive = google.drive({ version: 'v3', auth });

  const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));
  const targets  = targetSlug ? projects.filter(p => p.slug === targetSlug) : projects;

  // Collect all (slug, field, fileId) triples to update
  const work = [];
  for (const p of targets) {
    if (p.priceList  && p.priceList.driveFileId)  work.push({ slug: p.slug, field: 'priceList',  fileId: p.priceList.driveFileId });
    if (p.priceRange && p.priceRange.driveFileId) work.push({ slug: p.slug, field: 'priceRange', fileId: p.priceRange.driveFileId });
  }

  if (work.length === 0) {
    console.log('No price list / price range entries found.');
    return;
  }

  console.log(`Fetching modifiedTime for ${work.length} file(s)…\n`);

  // Fetch all in parallel (Drive metadata calls are lightweight)
  const CONCURRENCY = 10;
  const updated = [];
  const skipped = [];

  for (let i = 0; i < work.length; i += CONCURRENCY) {
    const batch = work.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (item) => {
      const modifiedTime = await getModifiedTime(drive, item.fileId);
      if (!modifiedTime) { skipped.push(item); return; }

      const newCreatedAt = formatDate(modifiedTime);
      const project = projects.find(p => p.slug === item.slug);
      if (!project) return;

      const current = project[item.field]?.createdAt || '(none)';
      if (current === newCreatedAt) return; // already correct, skip

      if (!isDry) {
        project[item.field].createdAt = newCreatedAt;
      }

      updated.push({ name: project.name, field: item.field, from: current, to: newCreatedAt });
    }));
  }

  // Report
  if (updated.length === 0) {
    console.log('All entries already have the correct date format — nothing to update.');
  } else {
    for (const u of updated) {
      const tag = u.field === 'priceRange' ? '[PR]' : '[PL]';
      console.log(`  ${isDry ? '(dry) ' : '✓ '}${tag} ${u.name}`);
      console.log(`       ${u.from}  →  ${u.to}`);
    }
  }

  if (skipped.length > 0) {
    console.log(`\n⚠ Skipped ${skipped.length} file(s) (Drive fetch failed):`);
    for (const s of skipped) console.log(`  ✗ ${s.slug} / ${s.field} (${s.fileId})`);
  }

  if (!isDry && updated.length > 0) {
    fs.writeFileSync(PROJECTS_JSON, JSON.stringify(projects, null, 2) + '\n', 'utf8');
    console.log(`\n✓ Done — ${updated.length} createdAt value(s) updated in projects.json`);
    console.log('\nNext: git add data/projects.json && git commit -m "chore: backfill price list dates with day"');
  } else if (isDry) {
    console.log('\n[DRY RUN — no files written]');
    console.log(`  ${updated.length} entry/entries would be updated`);
    console.log('Remove --dry to apply.');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
