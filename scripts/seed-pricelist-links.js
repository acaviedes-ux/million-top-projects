'use strict';

/**
 * seed-pricelist-links.js
 * ─────────────────────────────────────────────────────────────
 * Reads price list data from "Pre-construction Data" spreadsheet:
 *   col A = project name
 *   col K = last update date
 *   col M = Drive URL
 *
 * Matches Top Projects in data/projects.json and updates:
 *   priceList.driveFileId  — Drive file ID for the iframe embed
 *   priceList.createdAt    — "As of Month, DD of YYYY" formatted date
 *
 * Usage:
 *   node scripts/seed-pricelist-links.js
 * ─────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

const PROJECTS_JSON       = path.join(__dirname, '../data/projects.json');
const PRE_CONSTRUCTION_ID = process.env.PRE_CONSTRUCTION_SPREADSHEET_ID || '1RTDA5ZNHbHrSYTEVGuUCUdWI04TKRso--ErWmASEehU';

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
  const m1 = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m1) return m1[1];
  const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m2) return m2[1];
  return null;
}

function formatSheetDate(dateStr) {
  if (!dateStr || !dateStr.trim()) return null;
  const d = new Date(dateStr.trim());
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  }).formatToParts(d);
  const get = t => parts.find(p => p.type === t)?.value || '';
  return `As of ${get('month')}, ${get('day')} of ${get('year')}`;
}

async function main() {
  const auth   = makeAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  console.log('Reading Pre-construction Data spreadsheet…');
  const rows = await getRange(sheets, PRE_CONSTRUCTION_ID, 'Pre-construction Data!A:M');

  // Build lookup: normalized name → { originalName, fileId, createdAt }
  const sheetMap = new Map();
  for (const row of rows) {
    const name    = (row[0]  || '').trim();
    const dateStr = (row[10] || '').trim(); // col K = last update
    const url     = (row[12] || '').trim(); // col M = drive link
    if (!name || !url) continue;
    const fileId = extractFileId(url);
    if (fileId) {
      sheetMap.set(normalize(name), {
        originalName: name,
        fileId,
        createdAt: formatSheetDate(dateStr),
      });
    }
  }
  console.log(`Found ${sheetMap.size} entries with Drive links.\n`);

  const sectionArg  = process.argv.find(a => a.startsWith('--section='))?.split('=').slice(1).join('=')
                   || (process.argv.includes('--section') ? process.argv[process.argv.indexOf('--section') + 1] : null)
                   || 'Top Projects';
  console.log(`Processing section: "${sectionArg}"\n`);

  const projects    = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));
  const topProjects = projects.filter(p => p.section === sectionArg);

  const matched  = [];
  const notFound = [];

  for (const project of topProjects) {
    // Skip projects that already have a special config (button, message, or no-units)
    if (project.priceList && (project.priceList.externalUrl || project.priceList.heading || project.priceList.message)) {
      continue;
    }

    const normName = normalize(project.name);
    let entry = sheetMap.get(normName);

    if (!entry) {
      for (const [key, val] of sheetMap) {
        if (normName.includes(key) || key.includes(normName)) { entry = val; break; }
      }
    }

    if (entry) {
      project.priceList = {
        ...(project.priceList || {}),
        driveFileId: entry.fileId,
        ...(entry.createdAt ? { createdAt: entry.createdAt } : {}),
      };
      matched.push({ name: project.name, sheetName: entry.originalName, createdAt: entry.createdAt });
    } else {
      notFound.push(project.name);
    }
  }

  fs.writeFileSync(PROJECTS_JSON, JSON.stringify(projects, null, 2), 'utf8');

  console.log('── MATCHED (' + matched.length + ') ─────────────────────────────────');
  for (const m of matched) {
    console.log(`  ✓  ${m.name}`);
    if (normalize(m.name) !== normalize(m.sheetName)) {
      console.log(`       ↳ matched as: "${m.sheetName}"`);
    }
    if (m.createdAt) console.log(`       ↳ ${m.createdAt}`);
  }

  if (notFound.length) {
    console.log('\n── NOT FOUND (' + notFound.length + ') ────────────────────────────────');
    for (const n of notFound) console.log(`  ✗  ${n}`);
  }

  console.log(`\nDone. ${matched.length}/${topProjects.length} top projects updated.`);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
