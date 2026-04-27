'use strict';

/**
 * seed-pricelist-links.js
 * ─────────────────────────────────────────────────────────────
 * Reads price list Drive links from "Pre-construction Data" spreadsheet
 * (col A = project name, col M = Drive URL) and updates priceList.driveFileId
 * in data/projects.json for all Top Projects.
 *
 * Usage:
 *   node scripts/seed-pricelist-links.js
 *
 * Requires the same .env vars as seed-project.js plus:
 *   PRE_CONSTRUCTION_SPREADSHEET_ID
 * ─────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

const PROJECTS_JSON          = path.join(__dirname, '../data/projects.json');
const PRE_CONSTRUCTION_ID    = process.env.PRE_CONSTRUCTION_SPREADSHEET_ID || '1RTDA5ZNHbHrSYTEVGuUCUdWI04TKRso--ErWmASEehU';

function makeAuth() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    subject: process.env.GOOGLE_IMPERSONATE_EMAIL || undefined,
  });
}

async function getRange(sheets, spreadsheetId, range) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}

function normalize(s) {
  return s.toLowerCase().trim().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ');
}

function extractFileId(url) {
  if (!url) return null;
  // https://drive.google.com/file/d/{ID}/view?...
  const m1 = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m1) return m1[1];
  // https://drive.google.com/open?id={ID}
  const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m2) return m2[1];
  return null;
}

async function main() {
  const auth   = makeAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  console.log('Reading Pre-construction Data spreadsheet…');
  const rows = await getRange(sheets, PRE_CONSTRUCTION_ID, 'Pre-construction Data!A:M');

  // Build lookup map: normalized name → { originalName, fileId }
  const sheetMap = new Map();
  for (const row of rows) {
    const name = (row[0] || '').trim();
    const url  = (row[12] || '').trim(); // col M = index 12
    if (!name || !url) continue;
    const fileId = extractFileId(url);
    if (fileId) {
      sheetMap.set(normalize(name), { originalName: name, fileId });
    }
  }
  console.log(`Found ${sheetMap.size} entries with Drive links in the spreadsheet.\n`);

  const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));
  const topProjects = projects.filter(p => p.section === 'Top Projects');

  const matched   = [];
  const notFound  = [];

  for (const project of topProjects) {
    const normName = normalize(project.name);

    // Step 1: exact normalized match
    let entry = sheetMap.get(normName);

    // Step 2: one contains the other
    if (!entry) {
      for (const [key, val] of sheetMap) {
        if (normName.includes(key) || key.includes(normName)) {
          entry = val;
          break;
        }
      }
    }

    if (entry) {
      project.priceList = { ...(project.priceList || {}), driveFileId: entry.fileId };
      matched.push({ project: project.name, sheetName: entry.originalName, fileId: entry.fileId });
    } else {
      notFound.push(project.name);
    }
  }

  fs.writeFileSync(PROJECTS_JSON, JSON.stringify(projects, null, 2), 'utf8');

  console.log('── MATCHED (' + matched.length + ') ─────────────────────────────────');
  for (const m of matched) {
    console.log(`  ✓  ${m.project}`);
    if (normalize(m.project) !== normalize(m.sheetName)) {
      console.log(`       ↳ matched as: "${m.sheetName}"`);
    }
  }

  if (notFound.length) {
    console.log('\n── NOT FOUND (' + notFound.length + ') ────────────────────────────────');
    for (const n of notFound) {
      console.log(`  ✗  ${n}`);
    }
    console.log('\nAdd these driveFileId values manually in data/projects.json.');
  }

  console.log(`\nDone. ${matched.length}/${topProjects.length} top projects updated.`);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
