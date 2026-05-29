'use strict';

/**
 * seed-pricelists-from-project-folders.js
 * ─────────────────────────────────────────────────────────────────────────
 * Replaces the central-folder seeder. Each project's Drive folder now has a
 * "Price Lists" subfolder. We list every PDF directly under it (NOT recursing
 * into "Previous Price Lists" or any other subfolder) and treat each one as a
 * price doc for that project.
 *
 * Schema in projects.json (hybrid):
 *   - When the project has exactly ONE price doc → keep the legacy single
 *     fields `priceList: { driveFileId, createdAt }` or `priceRange: { ... }`.
 *   - When the project has 2+ docs → use the new array form:
 *       `priceDocs: [ { driveFileId, createdAt, title, kind }, ... ]`
 *     and clear the legacy fields.
 *
 * Initial migration safety
 * ────────────────────────
 * `--initial-migration` preserves the existing `createdAt` for any file
 * whose Drive `createdTime` is on or before 2026-05-26 AND whose ID was
 * already in projects.json. Files newer than the cutoff (or new ones) get
 * the freshly-derived "As of <Month Day, Year>" string. After the first
 * run-with-flag completes, future runs (cron) should NOT pass the flag —
 * they will always refresh dates.
 *
 * Usage
 * ─────
 *   node scripts/seed-pricelists-from-project-folders.js --initial-migration
 *   node scripts/seed-pricelists-from-project-folders.js              # cron
 *   node scripts/seed-pricelists-from-project-folders.js --dry        # preview
 *   node scripts/seed-pricelists-from-project-folders.js --slug 888-brickell
 *
 * Env
 * ───
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY
 *   DOCS_DRIVE_FOLDER_ID, EXTRA_DOCS_FOLDER_IDS  (same roots as seed-docs)
 * ─────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

const PROJECTS_JSON  = path.join(__dirname, '../data/projects.json');
const DOCS_FOLDER_ID = process.env.DOCS_DRIVE_FOLDER_ID;
const EXTRA_FOLDER_IDS = (process.env.EXTRA_DOCS_FOLDER_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// Migration cutoff: files created on/before this date keep their existing
// projects.json createdAt during --initial-migration. Files created after
// this date always get their fresh Drive createdTime.
const MIGRATION_CUTOFF = new Date('2026-05-26T23:59:59Z');

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

const DRIVE_LIST_OPTS = {
  supportsAllDrives: true,
  includeItemsFromAllDrives: true,
};

// ── Auth ─────────────────────────────────────────────────────────────────────

function makeAuth() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key:   (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    subject: process.env.GOOGLE_IMPERSONATE_EMAIL || undefined,
  });
}

// ── Name normalization (same as seed-docs-from-drive.js) ─────────────────────

function norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[®™''']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const FILLERS = new Set([
  'the', 'at', 'by', 'of', 'and', 'a',
  'residences', 'residence', 'hotel', 'homes', 'home',
]);

function coreKey(s) {
  return norm(s)
    .split(' ')
    .filter(t => t && !FILLERS.has(t))
    .sort()
    .join(' ');
}

// ── Drive helpers ────────────────────────────────────────────────────────────

async function listChildren(drive, folderId) {
  const res = await drive.files.list({
    ...DRIVE_LIST_OPTS,
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType, createdTime, modifiedTime)',
    pageSize: 1000,
  });
  return res.data.files || [];
}

// ── Title extraction ─────────────────────────────────────────────────────────
//
// Filename example: "888 Brickell by Dolce & Gabbana - Price List 2026 04 (2) - Penthouses.pdf"
// Wanted title:     "888 Brickell by Dolce & Gabbana - Price List - Penthouses"
//
// Rule per user spec: "Nombre completo del archivo, sin pdf y sin el número
// del final." We strip the .pdf extension and the version block
// "<space>YYYY MM (N)" wherever it appears (typical Drive convention).
// We also collapse leftover " - - " sequences.

function extractTitle(filename) {
  return filename
    .replace(/\.pdf$/i, '')
    .replace(/\s+\d{4}\s+\d{1,2}\s*\(\d+\)/g, '')   // "2026 04 (2)"
    .replace(/\s+\d{4}\s+\d{1,2}(?=\s|$|\s*-)/g, '') // "2026 04" without paren
    .replace(/\s*\(\d+\)\s*/g, ' ')                  // stray "(N)"
    .replace(/\s+-\s+-\s+/g, ' - ')                  // collapse double dashes
    .replace(/\s+/g, ' ')
    .trim();
}

// "list" if filename has "Price List"-style word, "range" if "Price Range".
// Default to "list" so unrecognized variants don't get silently dropped.
function detectKind(filename) {
  return /\bprice\s+range\b/i.test(filename) ? 'range' : 'list';
}

// "As of May 29, 2026"
function formatAsOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `As of ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args              = process.argv.slice(2);
  const isDry             = args.includes('--dry');
  const isInitialMigration = args.includes('--initial-migration');
  const slugIdx           = args.indexOf('--slug');
  const targetSlug        = slugIdx !== -1 ? args[slugIdx + 1] : null;

  if (!DOCS_FOLDER_ID && EXTRA_FOLDER_IDS.length === 0) {
    console.error('Error: DOCS_DRIVE_FOLDER_ID (or EXTRA_DOCS_FOLDER_IDS) must be set');
    process.exit(1);
  }

  if (isInitialMigration) {
    console.log('[--initial-migration] Preserving existing dates for files created on/before',
      MIGRATION_CUTOFF.toISOString());
  }

  const drive = google.drive({ version: 'v3', auth: makeAuth() });
  const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));

  // Build lookup maps for project matching
  const projectMap = new Map();      // norm(name) → project
  const coreMap    = new Map();      // coreKey → Set<slug>
  const slugToProject = new Map(projects.map(p => [p.slug, p]));
  for (const p of projects) {
    for (const key of [p.name, p.esqueletoName, p.tpDataName].filter(Boolean)) {
      const n = norm(key);
      if (!projectMap.has(n)) projectMap.set(n, p);
      const c = coreKey(key);
      if (c) {
        if (!coreMap.has(c)) coreMap.set(c, new Set());
        coreMap.get(c).add(p.slug);
      }
    }
  }

  // Find every project folder across all configured roots, match it to a project
  const matched = new Map(); // slug → array of project folders (1 project can have folders in multiple roots)
  const allRoots = [
    ...(DOCS_FOLDER_ID ? [DOCS_FOLDER_ID] : []),
    ...EXTRA_FOLDER_IDS,
  ];
  for (const rootId of allRoots) {
    const children = await listChildren(drive, rootId);
    const folders = children.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
    for (const folder of folders) {
      let project = projectMap.get(norm(folder.name));
      if (!project) {
        const slugs = coreMap.get(coreKey(folder.name));
        if (slugs && slugs.size === 1) project = slugToProject.get([...slugs][0]);
      }
      if (project) {
        if (!matched.has(project.slug)) matched.set(project.slug, []);
        matched.get(project.slug).push(folder);
      }
    }
  }

  console.log(`Matched ${matched.size} project(s) to Drive folders\n`);

  // ── Process each matched project ─────────────────────────────────────────
  const slugs = targetSlug ? [targetSlug] : [...matched.keys()];
  let processed = 0, updated = 0, skipped = 0, multiDocProjects = 0;

  for (const slug of slugs) {
    const projectFolders = matched.get(slug);
    if (!projectFolders) {
      if (targetSlug) console.log(`⚠ ${slug}: no Drive folder matched`);
      continue;
    }

    const project = slugToProject.get(slug);
    if (!project) continue;

    // Look for "Price Lists" subfolder in each project folder
    const collectedFiles = [];
    let foundPriceListsFolder = false;

    for (const pf of projectFolders) {
      const subs = await listChildren(drive, pf.id);
      const priceListsFolder = subs.find(s =>
        s.mimeType === 'application/vnd.google-apps.folder' &&
        /^price\s*lists?$/i.test(s.name)
      );
      if (!priceListsFolder) continue;
      foundPriceListsFolder = true;

      // List direct children only — Previous Price Lists is a subfolder, so
      // its contents are NOT included (we only collect non-folder items).
      const docs = await listChildren(drive, priceListsFolder.id);
      for (const d of docs) {
        if (d.mimeType === 'application/vnd.google-apps.folder') continue;
        if (!d.name.toLowerCase().endsWith('.pdf')) continue;
        collectedFiles.push(d);
      }
    }

    if (!foundPriceListsFolder) {
      // Project's Drive folder doesn't have "Price Lists" yet — skip silently.
      // Existing priceList/priceRange in projects.json is left intact.
      skipped++;
      continue;
    }

    processed++;

    if (collectedFiles.length === 0) {
      // Price Lists folder exists but is empty → clear any legacy fields
      const idx = projects.findIndex(p => p.slug === slug);
      if (idx !== -1 && !isDry) {
        if (projects[idx].priceList?.driveFileId)  delete projects[idx].priceList;
        if (projects[idx].priceRange?.driveFileId) delete projects[idx].priceRange;
        if (projects[idx].priceDocs)               delete projects[idx].priceDocs;
      }
      console.log(`  ◌ ${slug}: empty Price Lists folder — cleared`);
      continue;
    }

    // Build doc records. Preserve existing dates per the migration cutoff rule.
    const existingById = new Map();
    if (project.priceList?.driveFileId)  existingById.set(project.priceList.driveFileId, project.priceList);
    if (project.priceRange?.driveFileId) existingById.set(project.priceRange.driveFileId, project.priceRange);
    for (const doc of (project.priceDocs || [])) {
      if (doc.driveFileId) existingById.set(doc.driveFileId, doc);
    }

    const docs = collectedFiles.map(f => {
      const created  = new Date(f.createdTime);
      const modified = new Date(f.modifiedTime || f.createdTime);
      const existing = existingById.get(f.id);

      // Decision rule: prefer modifiedTime for the displayed "As of" — it
      // reflects "Manage versions" content updates that keep the same fileId.
      // createdTime is only used as the migration-cutoff reference so that
      // pre-existing dates on old files aren't overwritten in step 1.
      let createdAt;
      if (isInitialMigration && existing && created <= MIGRATION_CUTOFF) {
        createdAt = existing.createdAt;
      } else {
        createdAt = formatAsOf(modified);
      }

      return {
        driveFileId: f.id,
        createdAt,
        title: extractTitle(f.name),
        kind:  detectKind(f.name),
      };
    });

    // Sort: lists first (general first, then variants alphabetically), ranges last.
    // A doc with no variant (title ends with "Price List" or just "Price Range")
    // sorts before variant docs so it appears as the leading card.
    docs.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'list' ? -1 : 1;
      const aVariant = / - [^-]+$/.test(a.title) && !/Price (List|Range)$/i.test(a.title);
      const bVariant = / - [^-]+$/.test(b.title) && !/Price (List|Range)$/i.test(b.title);
      if (aVariant !== bVariant) return aVariant ? 1 : -1;
      return a.title.localeCompare(b.title);
    });

    // Apply to projects.json (hybrid schema)
    const idx = projects.findIndex(p => p.slug === slug);
    if (idx === -1) continue;

    if (isDry) {
      console.log(`  ✓ ${slug} (${docs.length} doc${docs.length === 1 ? '' : 's'})`);
      docs.forEach(d => console.log(`      [${d.kind}] "${d.title}" — ${d.createdAt}`));
    } else if (docs.length === 1) {
      // Single doc → legacy fields
      const d = docs[0];
      if (d.kind === 'list') {
        projects[idx].priceList  = { driveFileId: d.driveFileId, createdAt: d.createdAt };
        delete projects[idx].priceRange;
      } else {
        projects[idx].priceRange = { driveFileId: d.driveFileId, createdAt: d.createdAt };
        delete projects[idx].priceList;
      }
      delete projects[idx].priceDocs;
      updated++;
    } else {
      // Multiple docs → priceDocs[] (and clear legacy)
      projects[idx].priceDocs = docs;
      delete projects[idx].priceList;
      delete projects[idx].priceRange;
      updated++;
      multiDocProjects++;
    }
  }

  if (!isDry) {
    fs.writeFileSync(PROJECTS_JSON, JSON.stringify(projects, null, 2) + '\n', 'utf8');
  }

  console.log(`\n✓ Done`);
  console.log(`  ${processed} project(s) had a Price Lists folder`);
  console.log(`  ${updated}  project(s) updated`);
  console.log(`  ${multiDocProjects}  with multiple docs (priceDocs[])`);
  console.log(`  ${skipped}  project(s) skipped (no Price Lists folder in Drive)`);
  if (isDry) console.log('\n[DRY RUN — no files written]');
}

main().catch(err => { console.error(err); process.exit(1); });
