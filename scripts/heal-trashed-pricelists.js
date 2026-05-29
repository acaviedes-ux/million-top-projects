'use strict';

/**
 * heal-trashed-pricelists.js
 * ─────────────────────────────────────────────────────────────────────────
 * Detects price list / price range Drive files that have been moved to the
 * trash AFTER being seeded into projects.json, and removes the broken
 * references so end users don't see "File is in owner's trash".
 *
 * Why we don't search for replacements here anymore
 * ────────────────────────────────────────────────
 * Under the old central-folder system (Price List YYYY / Price List MM …)
 * this script had to walk the entire year/month tree to find a fallback.
 * Under the new per-project source (each project's "Price Lists" subfolder),
 * the `seed-pricelists-from-project-folders.js` script already scans the
 * canonical location and writes whatever is currently there — trashed files
 * vanish automatically from the next seed run. This script's job is just to
 * close the small window where the seed hasn't run yet but a file has been
 * trashed.
 *
 * Behaviour:
 *   - Single-doc legacy fields (priceList / priceRange) pointing at a trashed
 *     file → delete the field. The UI falls back to "Coming soon".
 *   - priceDocs[] containing a trashed entry → filter it out. If only one
 *     entry remains, collapse back to legacy shape (priceList or priceRange).
 *     If zero remain, clear the field.
 *
 * Usage
 * ─────
 *   node scripts/heal-trashed-pricelists.js          # apply
 *   node scripts/heal-trashed-pricelists.js --dry    # report only
 *
 * Env
 * ───
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY
 * ─────────────────────────────────────────────────────────────────────────
 */

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
  if (isDry) console.log('[DRY RUN] No changes will be written\n');

  const drive = google.drive({ version: 'v3', auth: makeAuth() });
  const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));

  // Step 1: collect every (slug, where, fileId) reference
  const refs = [];
  for (const p of projects) {
    if (p.priceList?.driveFileId)
      refs.push({ slug: p.slug, where: 'priceList', fileId: p.priceList.driveFileId });
    if (p.priceRange?.driveFileId)
      refs.push({ slug: p.slug, where: 'priceRange', fileId: p.priceRange.driveFileId });
    if (Array.isArray(p.priceDocs)) {
      p.priceDocs.forEach((doc, i) => {
        if (doc?.driveFileId)
          refs.push({ slug: p.slug, where: 'priceDocs', index: i, fileId: doc.driveFileId });
      });
    }
  }

  console.log(`Verifying ${refs.length} price doc reference(s)...`);

  // Step 2: check trashed status in parallel
  const trashed = [];
  const queue = [...refs];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const ref = queue.shift();
      if (!ref) continue;
      try {
        const { data } = await drive.files.get({
          fileId: ref.fileId,
          supportsAllDrives: true,
          fields: 'trashed,name',
        });
        if (data.trashed) trashed.push({ ...ref, name: data.name });
      } catch (e) {
        // 404 / not found also counts as broken
        trashed.push({ ...ref, name: '(not found)', error: e.message });
      }
    }
  }));

  if (!trashed.length) {
    console.log('✓ All price doc references are healthy — nothing to heal.');
    return;
  }

  console.log(`\nFound ${trashed.length} broken reference(s):`);
  trashed.forEach(t => {
    const loc = t.where === 'priceDocs' ? `priceDocs[${t.index}]` : t.where;
    console.log(`  ✗ ${t.slug} (${loc}): ${t.name}`);
  });

  if (isDry) {
    console.log('\n[DRY RUN] Run without --dry to apply.');
    return;
  }

  // Step 3: apply removals. Group by slug so we mutate each project once.
  // For priceDocs[] we filter out broken indices; if exactly one survives we
  // collapse it back into the matching legacy field (priceList / priceRange).
  const bySlug = new Map();
  for (const t of trashed) {
    if (!bySlug.has(t.slug)) bySlug.set(t.slug, []);
    bySlug.get(t.slug).push(t);
  }

  for (const [slug, items] of bySlug) {
    const proj = projects.find(p => p.slug === slug);
    if (!proj) continue;

    // Legacy single fields → just delete
    if (items.some(i => i.where === 'priceList'))  delete proj.priceList;
    if (items.some(i => i.where === 'priceRange')) delete proj.priceRange;

    // priceDocs[] → filter out broken indices
    const docItems = items.filter(i => i.where === 'priceDocs');
    if (docItems.length && Array.isArray(proj.priceDocs)) {
      const badIdx = new Set(docItems.map(i => i.index));
      proj.priceDocs = proj.priceDocs.filter((_, i) => !badIdx.has(i));

      // Collapse to legacy shape when only one remains
      if (proj.priceDocs.length === 1) {
        const d = proj.priceDocs[0];
        if (d.kind === 'range') {
          proj.priceRange = { driveFileId: d.driveFileId, createdAt: d.createdAt };
        } else {
          proj.priceList  = { driveFileId: d.driveFileId, createdAt: d.createdAt };
        }
        delete proj.priceDocs;
      } else if (proj.priceDocs.length === 0) {
        delete proj.priceDocs;
      }
    }
  }

  fs.writeFileSync(PROJECTS_JSON, JSON.stringify(projects, null, 2) + '\n', 'utf8');
  console.log(`\n✓ Applied ${trashed.length} removal(s) to projects.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
