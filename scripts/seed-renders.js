/**
 * seed-renders.js
 * ─────────────────────────────────────────────────────────────
 * Scans one or more Google Drive parent folders for per-project
 * subfolders, finds a "Renders / Renderings / ..." subfolder inside
 * each, picks the largest image file (best quality heuristic), and:
 *   1. Downloads it to images/renders/{slug}.{ext}
 *   2. Sets both `thumbnail` and `hero` in data/projects.json
 *
 * Usage:
 *   node scripts/seed-renders.js --dry           ← preview matches
 *   node scripts/seed-renders.js                 ← download all
 *   node scripts/seed-renders.js --override "slug=DRIVE_FILE_ID"
 *   node scripts/seed-renders.js --force         ← re-download even if already set
 *   node scripts/seed-renders.js --slug "aston-martin-residences"
 *
 * Requires .env with:
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY
 *   RENDERS_FOLDER_IDS   ← comma-separated Drive folder IDs (parent folders
 *                          that contain one subfolder per project)
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();
const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

const PROJECTS_JSON = path.join(__dirname, '../data/projects.json');
const RENDERS_DIR   = path.join(__dirname, '../images/renders');

const MIME_TO_EXT = {
  'image/svg+xml':              'svg',
  'image/png':                  'png',
  'image/jpeg':                 'jpg',
  'image/jpg':                  'jpg',
  'image/webp':                 'webp',
  'image/gif':                  'gif',
  'image/x-icon':               'ico',
  'application/octet-stream':   'jpg', // fallback
};

// ── Auth ──────────────────────────────────────────────────────

function makeAuth() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key:   (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    subject: process.env.GOOGLE_IMPERSONATE_EMAIL || undefined,
  });
}

// ── Name normalization (same as seed-logos.js) ────────────────

function norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[®™\u2019']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ── Drive helpers ─────────────────────────────────────────────

// List direct children of a folder (optionally filtered by mimeType)
async function listChildren(drive, folderId, mimeType) {
  let q = `'${folderId}' in parents and trashed = false`;
  if (mimeType) q += ` and mimeType = '${mimeType}'`;
  const res = await drive.files.list({
    q,
    fields: 'files(id, name, mimeType, size)',
    pageSize: 1000,
  });
  return res.data.files || [];
}

// List all image files inside a folder
async function listImages(drive, folderId) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false and mimeType contains 'image/'`,
    fields: 'files(id, name, mimeType, size)',
    pageSize: 1000,
  });
  return res.data.files || [];
}

// Find the renders subfolder inside a project folder.
// Matches: "Renders", "Renderings", "Renderings Compressed", etc.
async function findRendersSubfolder(drive, projectFolderId) {
  const subfolders = await listChildren(
    drive, projectFolderId, 'application/vnd.google-apps.folder'
  );
  return subfolders.find(f => /render/i.test(f.name)) || null;
}

// Pick the image with the largest size (highest quality heuristic)
function pickBestImage(files) {
  if (!files.length) return null;
  return files.slice().sort((a, b) => Number(b.size || 0) - Number(a.size || 0))[0];
}

// ── Formatting ────────────────────────────────────────────────

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n === 0) return '—';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function pad(str, len) {
  return String(str || '').substring(0, len).padEnd(len);
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  const args      = process.argv.slice(2);
  const isDry     = args.includes('--dry');
  const isForce   = args.includes('--force');

  // --slug "some-slug" → process only that one project
  const slugIdx   = args.indexOf('--slug');
  const targetSlug = slugIdx !== -1 ? args[slugIdx + 1] : null;

  // --override "slug=FILE_ID" (repeatable)
  const overrides = {}; // slug → driveFileId
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--override' && args[i + 1]) {
      const eqIdx = args[i + 1].indexOf('=');
      if (eqIdx !== -1) {
        overrides[args[i + 1].substring(0, eqIdx)] = args[i + 1].substring(eqIdx + 1);
      }
    }
  }

  // Read folder IDs from env
  const folderIds = (process.env.RENDERS_FOLDER_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  if (!folderIds.length) {
    console.error('Error: RENDERS_FOLDER_IDS must be set in .env');
    console.error('  Example: RENDERS_FOLDER_IDS=1AbCdEfGh,2IjKlMnOp');
    process.exit(1);
  }

  if (!fs.existsSync(RENDERS_DIR)) {
    fs.mkdirSync(RENDERS_DIR, { recursive: true });
  }

  const auth  = makeAuth();
  const drive = google.drive({ version: 'v3', auth });

  // ── Build project lookup map (norm → project) ─────────────
  const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));
  const projectMap = new Map(); // norm(name) → project entry
  for (const p of projects) {
    for (const key of [p.name, p.esqueletoName, p.tpDataName].filter(Boolean)) {
      const n = norm(key);
      if (!projectMap.has(n)) projectMap.set(n, p);
    }
  }

  // ── Scan parent folders → collect per-project folder matches ─
  console.log(`\nScanning ${folderIds.length} parent folder(s)…`);

  const matched    = []; // { folder, project }
  let   unmatched  = 0;

  for (const folderId of folderIds) {
    console.log(`  → ${folderId}`);
    const subfolders = await listChildren(
      drive, folderId, 'application/vnd.google-apps.folder'
    );
    console.log(`    ${subfolders.length} subfolders`);

    for (const folder of subfolders) {
      // Exact norm match first
      let project = projectMap.get(norm(folder.name));

      // Fallback: check if the folder name is a substring of any project norm, or vice-versa
      if (!project) {
        const folderNorm = norm(folder.name);
        for (const [key, p] of projectMap) {
          if (folderNorm.length >= 8 && key.includes(folderNorm.substring(0, 8))) {
            project = p;
            break;
          }
          if (key.length >= 8 && folderNorm.includes(key.substring(0, 8))) {
            project = p;
            break;
          }
        }
      }

      if (project) {
        matched.push({ folder, project });
      } else {
        unmatched++;
        if (isDry) console.log(`    ⚠ No match: "${folder.name}"`);
      }
    }
  }

  // Apply targetSlug filter
  const targets = targetSlug
    ? matched.filter(({ project }) => project.slug === targetSlug)
    : matched;

  console.log(`\n${targets.length} project folders matched, ${unmatched} unmatched\n`);

  // ── Dry-run header ────────────────────────────────────────
  if (isDry) {
    console.log(
      pad('Project', 42) +
      pad('Renders folder', 28) +
      pad('Selected file', 38) +
      'Size'
    );
    console.log('─'.repeat(115));
  }

  let downloaded = 0, skipped = 0, failed = 0, noFolder = 0;

  for (const { folder, project } of targets) {
    // Skip already-rendered projects unless --force
    if (!isForce && project.thumbnail && project.thumbnail.startsWith('/images/renders/')) {
      skipped++;
      continue;
    }

    let selectedFile    = null;
    let rendersFolderLabel = '';

    // ── Manual override takes precedence ──────────────────
    if (overrides[project.slug]) {
      try {
        const meta = await drive.files.get({
          fileId: overrides[project.slug],
          fields: 'id,name,mimeType,size',
        });
        selectedFile       = meta.data;
        rendersFolderLabel = '(override)';
      } catch (err) {
        console.error(`  ✗ Override for "${project.slug}" failed: ${err.message}`);
        failed++;
        continue;
      }
    } else {
      // ── Find renders subfolder ───────────────────────────
      const rendersFolder = await findRendersSubfolder(drive, folder.id);
      if (!rendersFolder) {
        noFolder++;
        if (isDry) {
          console.log(
            pad(project.name, 42) +
            pad('⚠ No renders subfolder', 28) +
            pad('—', 38) + '—'
          );
        } else {
          console.log(`  ⚠ No renders subfolder: "${project.name}"`);
        }
        continue;
      }

      rendersFolderLabel = rendersFolder.name;

      // ── List & pick best image ───────────────────────────
      const images = await listImages(drive, rendersFolder.id);
      if (!images.length) {
        noFolder++;
        if (isDry) {
          console.log(
            pad(project.name, 42) +
            pad(rendersFolder.name, 28) +
            pad('⚠ No images found', 38) + '—'
          );
        } else {
          console.log(`  ⚠ No images in "${rendersFolder.name}": "${project.name}"`);
        }
        continue;
      }

      selectedFile = pickBestImage(images);
    }

    // ── Dry run: just print the row ───────────────────────
    if (isDry) {
      console.log(
        pad(project.name, 42) +
        pad(rendersFolderLabel, 28) +
        pad(selectedFile.name, 38) +
        formatBytes(selectedFile.size)
      );
      continue;
    }

    // ── Download ──────────────────────────────────────────
    try {
      const meta = await drive.files.get({
        fileId: selectedFile.id,
        fields: 'name,mimeType',
      });
      const mime = meta.data.mimeType || 'image/jpeg';
      const ext  = MIME_TO_EXT[mime] || 'jpg';
      const dest = path.join(RENDERS_DIR, `${project.slug}.${ext}`);

      const dl = await drive.files.get(
        { fileId: selectedFile.id, alt: 'media' },
        { responseType: 'arraybuffer' }
      );
      fs.writeFileSync(dest, Buffer.from(dl.data));

      // Update both thumbnail and hero in the in-memory array
      const idx = projects.findIndex(p => p.slug === project.slug);
      if (idx !== -1) {
        projects[idx].thumbnail = `/images/renders/${project.slug}.${ext}`;
        projects[idx].hero      = `/images/renders/${project.slug}.${ext}`;
      }

      downloaded++;
      console.log(`  ✓ ${project.slug}.${ext}  (${formatBytes(selectedFile.size)})`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${project.slug}: ${err.message}`);
    }
  }

  // ── Write projects.json once, after all downloads ─────────
  if (!isDry) {
    fs.writeFileSync(PROJECTS_JSON, JSON.stringify(projects, null, 2) + '\n', 'utf8');
    console.log(`\n✓ Done`);
    console.log(`  ${downloaded}  renders downloaded`);
    console.log(`  ${skipped}    already had renders (skipped — use --force to re-download)`);
    console.log(`  ${noFolder}   no renders subfolder found`);
    console.log(`  ${failed}     errors`);
    if (downloaded > 0) {
      console.log('\nNext: git add images/renders data/projects.json && git commit -m "chore: add project renders"');
    }
  } else {
    console.log('\n[DRY RUN — no files written]');
    console.log('Remove --dry to download.');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
