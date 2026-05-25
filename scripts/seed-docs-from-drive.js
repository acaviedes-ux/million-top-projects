/**
 * seed-docs-from-drive.js
 * ─────────────────────────────────────────────────────────────
 * Scans the central Drive folder for per-project subfolders, then
 * reads each category subfolder (Brochure, Fact Sheet, Floor Plans,
 * Presentation, Renderings) and populates the corresponding arrays
 * in data/projects.json.
 *
 * PDFs → { title, driveFileId }   (title = variant extracted from filename)
 * Images → { driveFileId, alt }   (displayed via Drive thumbnail URL, no download)
 *
 * Usage:
 *   node scripts/seed-docs-from-drive.js              # seed all matched projects
 *   node scripts/seed-docs-from-drive.js --dry        # preview only, no writes
 *   node scripts/seed-docs-from-drive.js --slug cipriani-residences
 *   node scripts/seed-docs-from-drive.js --force      # overwrite already-populated
 *
 * Requires .env with:
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL
 *   GOOGLE_PRIVATE_KEY
 *   DOCS_DRIVE_FOLDER_ID        ← ID of folder whose direct children are project folders
 *   EXTRA_DOCS_FOLDER_IDS       ← (optional) comma-separated IDs of additional folders
 *                                  whose direct children are also project folders
 *                                  (e.g. the Preconstruction and Resale subfolders)
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();
const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

const PROJECTS_JSON  = path.join(__dirname, '../data/projects.json');
const DOCS_FOLDER_ID = process.env.DOCS_DRIVE_FOLDER_ID;

// Additional folders to scan (comma-separated IDs in env var)
const EXTRA_FOLDER_IDS = (process.env.EXTRA_DOCS_FOLDER_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// Category subfolder names → projects.json field
const CATEGORY_MAP = [
  { field: 'brochures',     names: ['brochure', 'brochures'] },
  { field: 'factSheets',    names: ['fact sheet', 'fact sheets'] },
  { field: 'floorPlans',    names: ['floor plan', 'floor plans'] },
  { field: 'presentations', names: ['presentation', 'presentations'] },
  { field: 'renderings',    names: ['rendering', 'renderings'] },
];

// Mime types considered images
const IMAGE_MIMES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif',
  'image/heic', 'image/heif',
]);

// ── Auth ──────────────────────────────────────────────────────

function makeAuth() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key:   (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    subject: process.env.GOOGLE_IMPERSONATE_EMAIL || undefined,
  });
}

// ── Name normalization (mirrors seed-renders.js exactly) ──────

function norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[®™’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ── Drive helpers ─────────────────────────────────────────────

// supportsAllDrives + includeItemsFromAllDrives are required for folders
// that live outside the service account's own Drive (personal Drive shares,
// non-member shared drives, etc.)
const DRIVE_LIST_OPTS = {
  supportsAllDrives: true,
  includeItemsFromAllDrives: true,
};

async function listChildren(drive, folderId) {
  const res = await drive.files.list({
    ...DRIVE_LIST_OPTS,
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType)',
    pageSize: 1000,
  });
  return res.data.files || [];
}

async function listChildrenPaged(drive, folderId) {
  const all = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      ...DRIVE_LIST_OPTS,
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: 1000,
      pageToken,
    });
    all.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return all;
}

// Recursively list all non-folder files under a folder.
// Each returned file carries `_subPath` (array of subfolder names, [] for
// files at the root of the search) so callers can preserve grouping context.
async function listFilesRecursive(drive, folderId, pathSegments = []) {
  const all = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      ...DRIVE_LIST_OPTS,
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: 1000,
      pageToken,
    });
    for (const f of res.data.files || []) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        const children = await listFilesRecursive(drive, f.id, [...pathSegments, f.name]);
        all.push(...children);
      } else {
        all.push({ ...f, _subPath: pathSegments });
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return all;
}

// ── Title extraction ──────────────────────────────────────────
// Input:  "Cipriani Residences - Fact Sheet - Canaletto Collection - EN.pdf"
// Output: "Canaletto Collection - EN"
//
// Strategy: strip "^anything - CategoryName - " from the start,
// then strip the .pdf extension. If nothing remains, return "".

function extractTitle(filename) {
  let title = filename.replace(/\.pdf$/i, '').trim();

  // Try to strip "ProjectName - Category - " prefix where Category is known
  const stripped = title.replace(
    /^.+?\s*-\s*(?:Brochures?|Fact Sheets?|Floor Plans?|Presentations?)\s*-\s*/i,
    ''
  );

  // If the regex consumed something meaningful, use the remainder
  if (stripped !== title && stripped.length > 0) {
    return stripped.trim();
  }

  // Fallback: if there is no variant (e.g. "619 Brickell - Floor Plans"),
  // return an empty string — the section title is sufficient.
  return '';
}

// ── Field population ──────────────────────────────────────────

function buildDocItems(files) {
  const items = [];
  for (const f of files) {
    const mime = (f.mimeType || '').toLowerCase();

    if (mime === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) {
      const baseTitle = extractTitle(f.name);
      const sub = (f._subPath || []).join(' / ');
      const title = sub
        ? (baseTitle ? `${sub} - ${baseTitle}` : sub)
        : baseTitle;
      items.push({ title, driveFileId: f.id });
    }
  }
  // Sort by filename so order is deterministic
  items.sort((a, b) => {
    const na = a.title.toLowerCase();
    const nb = b.title.toLowerCase();
    return na < nb ? -1 : na > nb ? 1 : 0;
  });
  return items;
}

function buildRenderItems(files) {
  const items = [];
  for (const f of files) {
    const mime = (f.mimeType || '').toLowerCase();
    if (IMAGE_MIMES.has(mime) || mime.startsWith('image/')) {
      const baseAlt = f.name.replace(/\.(jpe?g|png|webp|gif|heic|heif)$/i, '').trim();
      const sub = (f._subPath || []).join(' / ');
      const alt = sub ? `${sub} - ${baseAlt}` : baseAlt;
      items.push({ driveFileId: f.id, alt });
    }
  }
  // Sort numerically by the trailing number in the filename if present
  items.sort((a, b) => {
    const numA = parseInt((a.alt.match(/\d+$/) || ['0'])[0], 10);
    const numB = parseInt((b.alt.match(/\d+$/) || ['0'])[0], 10);
    if (numA !== numB) return numA - numB;
    return a.alt.localeCompare(b.alt);
  });
  return items;
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  const args       = process.argv.slice(2);
  const isDry      = args.includes('--dry');
  const isForce    = args.includes('--force');
  const slugIdx    = args.indexOf('--slug');
  const targetSlug = slugIdx !== -1 ? args[slugIdx + 1] : null;

  if (!DOCS_FOLDER_ID && EXTRA_FOLDER_IDS.length === 0) {
    console.error('Error: DOCS_DRIVE_FOLDER_ID (or EXTRA_DOCS_FOLDER_IDS) must be set in .env');
    process.exit(1);
  }

  const auth  = makeAuth();
  const drive = google.drive({ version: 'v3', auth });

  // ── Build project lookup map ──────────────────────────────
  const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));
  const projectMap = new Map(); // norm(key) → project entry
  for (const p of projects) {
    for (const key of [p.name, p.esqueletoName, p.tpDataName].filter(Boolean)) {
      const n = norm(key);
      if (!projectMap.has(n)) projectMap.set(n, p);
    }
  }

  // ── Collect project folders from all configured roots ─────
  // Each root folder is expected to have direct children that are project folders.
  const allRoots = [
    ...(DOCS_FOLDER_ID ? [DOCS_FOLDER_ID] : []),
    ...EXTRA_FOLDER_IDS,
  ];

  const projectFolders = [];
  for (const rootId of allRoots) {
    console.log(`\nScanning root folder: ${rootId}`);
    const children = await listChildren(drive, rootId);
    const folders  = children.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
    console.log(`  ${folders.length} project folders found`);
    projectFolders.push(...folders);
  }
  console.log(`\nTotal project folders: ${projectFolders.length}`);

  // ── Match Drive folders → projects.json entries ───────────
  const matched   = [];
  const unmatched = [];

  for (const folder of projectFolders) {
    const folderNorm = norm(folder.name);

    let project = projectMap.get(folderNorm);

    // Prefix fallback (handles minor name length differences)
    if (!project) {
      for (const [key, p] of projectMap) {
        const len = Math.min(folderNorm.length, key.length, 12);
        if (len >= 8 && folderNorm.substring(0, len) === key.substring(0, len)) {
          project = p;
          break;
        }
      }
    }

    if (project) {
      matched.push({ folder, project });
    } else {
      unmatched.push(folder.name);
    }
  }

  // Apply --slug filter
  const targets = targetSlug
    ? matched.filter(({ project }) => project.slug === targetSlug)
    : matched;

  console.log(`${targets.length} matched, ${unmatched.length} unmatched`);
  if (unmatched.length) {
    console.log('  Unmatched folders:');
    unmatched.forEach(n => console.log(`    ⚠ "${n}"`));
  }
  console.log('');

  if (isDry) {
    console.log('DRY RUN — listing categories per project:\n');
  }

  let updated = 0, skipped = 0, failed = 0;

  for (const { folder, project } of targets) {
    // Skip already-populated projects unless --force
    const alreadyDone =
      (project.brochures && project.brochures.length) ||
      (project.factSheets && project.factSheets.length) ||
      (project.floorPlans && project.floorPlans.length) ||
      (project.presentations && project.presentations.length) ||
      (project.renderings && project.renderings.length);

    if (!isForce && alreadyDone) {
      skipped++;
      if (isDry) console.log(`  ↷ ${project.slug} (already populated, use --force)`);
      continue;
    }

    try {
      // List subfolders inside this project folder
      const subfolders = await listChildren(drive, folder.id);
      const subMap = new Map(); // norm(name) → folder item
      for (const sf of subfolders) {
        if (sf.mimeType === 'application/vnd.google-apps.folder') {
          subMap.set(norm(sf.name), sf);
        }
      }

      const updates = {};

      for (const cat of CATEGORY_MAP) {
        // Find the matching subfolder (try each known name variant)
        let catFolder = null;
        for (const name of cat.names) {
          catFolder = subMap.get(name);
          if (catFolder) break;
        }

        if (!catFolder) continue;

        // Renderings: recurse into nested subfolders (luxury projects often
        // organize their large galleries by theme: Exterior/, Interior/, etc.)
        // Docs (brochures, fact sheets, floor plans, presentations): root only.
        // Internal subfolders like "Individuals" or "Other Floor Plans" are
        // editorial organization and must NOT be flattened into the doc list.
        let files;
        if (cat.field === 'renderings') {
          files = await listFilesRecursive(drive, catFolder.id);
          updates[cat.field] = buildRenderItems(files);
        } else {
          const allChildren = await listChildren(drive, catFolder.id);
          files = allChildren.filter(
            f => f.mimeType !== 'application/vnd.google-apps.folder'
          );
          updates[cat.field] = buildDocItems(files);
        }
      }

      if (isDry) {
        console.log(`  ✓ ${project.slug}`);
        for (const [field, items] of Object.entries(updates)) {
          console.log(`      ${field}: ${items.length} items`);
          items.slice(0, 3).forEach(it => {
            const label = it.title !== undefined
              ? (it.title || '(no variant)')
              : (it.alt || '');
            console.log(`        • "${label}" (${it.driveFileId})`);
          });
          if (items.length > 3) console.log(`        … and ${items.length - 3} more`);
        }
      } else {
        // Apply updates to the in-memory array
        const idx = projects.findIndex(p => p.slug === project.slug);
        if (idx !== -1) {
          for (const [field, items] of Object.entries(updates)) {
            projects[idx][field] = items;
          }
        }
        updated++;
        const counts = Object.entries(updates)
          .map(([f, items]) => `${f}:${items.length}`)
          .join(' ');
        console.log(`  ✓ ${project.slug}  [${counts}]`);
      }
    } catch (err) {
      failed++;
      console.error(`  ✗ ${project.slug}: ${err.message}`);
    }
  }

  // ── Write projects.json ───────────────────────────────────
  if (!isDry) {
    fs.writeFileSync(PROJECTS_JSON, JSON.stringify(projects, null, 2) + '\n', 'utf8');
    console.log(`\n✓ Done`);
    console.log(`  ${updated}  projects updated`);
    console.log(`  ${skipped}  already populated (skipped — use --force to overwrite)`);
    console.log(`  ${failed}   errors`);
    if (updated > 0) {
      console.log('\nNext: git add data/projects.json && git commit -m "chore: seed docs and renders from Drive"');
    }
  } else {
    console.log('\n[DRY RUN — no files written]');
    console.log('Remove --dry to apply.');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
