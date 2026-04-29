/**
 * seed-logos-resale.js
 * ─────────────────────────────────────────────────────────────
 * Downloads project logos from Drive/Webmaster/Projects Logos/Logos/
 * Logos Originales/{Resale, Resale/OFF, Pre-construction}.
 *
 * Targets only projects that are missing a projectLogo in projects.json.
 * Prefers SVG Darkmode over PNG Darkmode.
 *
 * Usage:
 *   node scripts/seed-logos-resale.js --dry   ← preview only
 *   node scripts/seed-logos-resale.js         ← download & update projects.json
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();
const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

const PROJECTS_JSON = path.join(__dirname, '../data/projects.json');
const LOGOS_DIR     = path.join(__dirname, '../images/logos');

// Logos Originales subfolders (Resale, Resale/OFF, Pre-construction)
const LOGO_FOLDER_IDS = [
  '1XJd_A-NqFGjO_KyOnUZRi_WZO8aHaq7y', // Resale
  '1BzT2_Ma332LEUoR-K_EGbPwsKEXNW2Zn', // Resale/OFF
  '1XJQFfMQynFnoPL3pw0kVbO3uSeV_tdRb', // Pre-construction
];

const MIME_TO_EXT = {
  'image/svg+xml': 'svg',
  'image/png':     'png',
  'image/jpeg':    'jpg',
  'image/webp':    'webp',
  'application/octet-stream': 'png',
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

// ── Name normalization ────────────────────────────────────────
// Converts "Jade-Signature-Logo-Darkmode.png" → "jade signature"
// Converts project slug "jade-signature" → "jade signature"
function norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[®™’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Extract the project name portion from logo filename.
// "Jade-Signature-Logo-Darkmode.png" → "jade signature"
// "The Bristol Residences Palm Beach-Logo Darkmode.svg" → "the bristol residences palm beach"
function logoFileStem(filename) {
  const base = path.basename(filename, path.extname(filename));
  // Remove "-Logo-Darkmode", "-Logo Darkmode", " Logo Darkmode" etc.
  const cleaned = base
    .replace(/-Logo[-\s]Darkmode$/i, '')
    .replace(/\s+Logo[-\s]Darkmode$/i, '');
  return norm(cleaned);
}

// ── Drive helpers ─────────────────────────────────────────────
async function listAllFiles(drive, folderId) {
  const files = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false and (mimeType = 'image/png' or mimeType = 'image/svg+xml')`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: 1000,
      pageToken: pageToken || undefined,
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  const isDry = process.argv.includes('--dry');

  if (!fs.existsSync(LOGOS_DIR)) fs.mkdirSync(LOGOS_DIR, { recursive: true });

  const auth  = makeAuth();
  const drive = google.drive({ version: 'v3', auth });

  // 1. Collect all logo files from all folders
  console.log('Scanning Drive logo folders…');
  const allFiles = [];
  for (const folderId of LOGO_FOLDER_IDS) {
    const files = await listAllFiles(drive, folderId);
    console.log(`  ${folderId}: ${files.length} files`);
    allFiles.push(...files);
  }
  console.log(`  Total: ${allFiles.length} logo files found\n`);

  // 2. Build map: normStem → { svg: fileId, png: fileId }
  //    Prefer SVG Darkmode over PNG Darkmode
  const logoMap = new Map(); // normStem → { svg?, png?, svgId?, pngId? }
  for (const f of allFiles) {
    // Only process Darkmode variants
    if (!/darkmode/i.test(f.name)) continue;
    const stem = logoFileStem(f.name);
    if (!logoMap.has(stem)) logoMap.set(stem, {});
    const entry = logoMap.get(stem);
    if (f.mimeType === 'image/svg+xml') {
      entry.svgId   = f.id;
      entry.svgName = f.name;
    } else if (f.mimeType === 'image/png') {
      entry.pngId   = f.id;
      entry.pngName = f.name;
    }
  }
  console.log(`Unique logo stems in Drive: ${logoMap.size}`);

  // 3. Load projects.json — find those missing projectLogo
  const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));
  const missing  = projects.filter(p => !p.projectLogo);
  console.log(`Projects missing projectLogo: ${missing.length}\n`);

  // 4. Match each missing project to a logo stem
  const toDownload = [];
  const noMatch    = [];

  for (const p of missing) {
    // Normalise slug and all name aliases for matching
    const normSlug = norm(p.slug.replace(/-/g, ' '));
    const aliases  = [normSlug, norm(p.name), norm(p.esqueletoName), norm(p.tpDataName)]
      .filter(Boolean);

    let matched = null;

    // Try exact match first, then prefix match
    for (const alias of aliases) {
      if (logoMap.has(alias)) { matched = { stem: alias, ...logoMap.get(alias) }; break; }
    }

    if (!matched) {
      // Partial / token-overlap match
      for (const [stem, entry] of logoMap) {
        for (const alias of aliases) {
          // both stems share ≥60% of tokens
          const aTokens = new Set(alias.split(' ').filter(t => t.length > 2));
          const bTokens = new Set(stem.split(' ').filter(t => t.length > 2));
          const inter   = [...aTokens].filter(t => bTokens.has(t)).length;
          const union   = new Set([...aTokens, ...bTokens]).size;
          if (union > 0 && inter / union >= 0.60) {
            matched = { stem, ...entry };
            break;
          }
        }
        if (matched) break;
      }
    }

    if (matched) {
      // Prefer SVG; fall back to PNG
      const fileId  = matched.svgId  || matched.pngId;
      const mime    = matched.svgId  ? 'image/svg+xml' : 'image/png';
      const ext     = MIME_TO_EXT[mime];
      const srcName = matched.svgId ? matched.svgName : matched.pngName;
      toDownload.push({ project: p, fileId, mime, ext, srcName, stem: matched.stem });
    } else {
      noMatch.push(p);
    }
  }

  console.log(`Matched:   ${toDownload.length}`);
  console.log(`No match:  ${noMatch.length}`);
  if (noMatch.length) {
    console.log('\n⚠ No Drive logo found for:');
    noMatch.forEach(p => console.log(`  ${p.slug.padEnd(50)} ${p.name}`));
  }

  if (isDry) {
    console.log('\n── DRY RUN preview ──────────────────────────────────');
    toDownload.forEach(({ project, srcName, ext, stem }) =>
      console.log(`  ${project.slug.padEnd(50)} ← ${srcName}  [stem: ${stem}]`)
    );
    console.log('\n[DRY RUN — no files written. Remove --dry to download.]');
    return;
  }

  // 5. Download
  console.log(`\nDownloading ${toDownload.length} logos…`);
  let ok = 0, failed = 0;

  for (const { project, fileId, ext, srcName } of toDownload) {
    try {
      const dl = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'arraybuffer' }
      );
      const dest = path.join(LOGOS_DIR, `${project.slug}.${ext}`);
      fs.writeFileSync(dest, Buffer.from(dl.data));

      // Update projects.json in memory
      const idx = projects.findIndex(p => p.slug === project.slug);
      if (idx !== -1) projects[idx].projectLogo = `/images/logos/${project.slug}.${ext}`;

      ok++;
      console.log(`  ✓ ${project.slug}.${ext}  ←  ${srcName}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${project.slug}: ${err.message}`);
    }
  }

  // 6. Write projects.json once
  fs.writeFileSync(PROJECTS_JSON, JSON.stringify(projects, null, 2) + '\n', 'utf8');

  console.log(`\n✓ Done`);
  console.log(`  ${ok} logos downloaded`);
  console.log(`  ${failed} errors`);
  console.log(`  ${noMatch.length} projects had no match in Drive`);
  if (ok > 0) {
    console.log('\nNext: git add images/logos data/projects.json && git commit -m "chore: add resale project logos"');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
