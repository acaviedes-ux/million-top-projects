'use strict';
/**
 * Sync the contact field from Esqueleto → projects.json.
 * Applies the "no longer working" filter (inactive agents are skipped).
 * Only updates entries whose contact value actually changes.
 */

require('dotenv').config();
const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

const PROJECTS_JSON = path.join(__dirname, '../data/projects.json');
const ESQUELETO_ID  = process.env.ESQUELETO_SPREADSHEET_ID;
const SHEET_TAB     = 'Projects Overview';

const COL = { name: 1, inhouseNames: 30, inhousePhones: 31, inhouseEmails: 32, inhouseNotes: 33 };

if (!ESQUELETO_ID) {
  console.error('Error: ESQUELETO_SPREADSHEET_ID must be set in .env');
  process.exit(1);
}

function makeAuth() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

function cell(row, idx) {
  return (row[idx] || '').toString().trim();
}

function stripPrefix(value) {
  const i = value.indexOf(':');
  return i === -1 ? value.trim() : value.substring(i + 1).trim();
}

function extractContact(row) {
  const namesRaw = cell(row, COL.inhouseNames);
  if (!namesRaw) return null;

  const names  = namesRaw.split('\n').map(s => s.trim()).filter(Boolean);
  const phones = cell(row, COL.inhousePhones).split('\n').map(s => s.trim()).filter(Boolean);
  const emails = cell(row, COL.inhouseEmails).split('\n').map(s => s.trim()).filter(Boolean);
  const notes  = cell(row, COL.inhouseNotes).split('\n').map(s => s.trim()).filter(Boolean);

  const isInactive = i => (notes[i] || '').toLowerCase().includes('no longer working');

  const optionAIdx = notes.findIndex(n => n.toLowerCase().includes('option a'));
  let idx = optionAIdx >= 0 && !isInactive(optionAIdx)
    ? optionAIdx
    : names.findIndex((_n, i) => !isInactive(i));

  if (idx < 0) return null;

  const name  = names[idx] || '';
  if (!name) return null;

  const phone = stripPrefix(phones[idx] || '');
  const email = stripPrefix(emails[idx] || '');
  return [{ name, phone: phone || null, email: (email && email.toLowerCase() !== 'n/a') ? email : null }];
}

function contactKey(c) {
  if (!c || !c[0]) return 'null';
  return `${c[0].name}|${c[0].phone}|${c[0].email}`;
}

async function main() {
  const sheets = google.sheets({ version: 'v4', auth: makeAuth() });

  console.log('Reading Esqueleto…');
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: ESQUELETO_ID,
    range: `'${SHEET_TAB}'!A:AH`,
  });
  const rows = resp.data.values || [];
  const dataRows = rows.slice(2).filter(r => cell(r, COL.name));
  console.log(`  ${dataRows.length} project rows`);

  const esqContacts = new Map();
  for (const row of dataRows) {
    const name = cell(row, COL.name);
    esqContacts.set(name.toLowerCase(), { name, contact: extractContact(row) });
  }

  const projects = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));
  let changed = 0;
  const report = [];

  for (const p of projects) {
    const esqName = (p.esqueletoName || p.tpDataName || p.name || '').toLowerCase();
    if (!esqName) continue;

    const esq = esqContacts.get(esqName);
    if (!esq) continue;

    const newContact = esq.contact;
    const oldContact = p.contact || null;

    if (contactKey(newContact) === contactKey(oldContact)) continue;

    if (newContact === null) {
      delete p.contact;
    } else {
      p.contact = newContact;
    }

    changed++;
    report.push({
      project: p.name,
      old: oldContact && oldContact[0] ? oldContact[0].name : '(none)',
      new: newContact && newContact[0] ? newContact[0].name : '(none)',
    });
  }

  if (changed === 0) {
    console.log('No contact changes — projects.json is already up to date.');
    return;
  }

  console.log(`\n${changed} project(s) updated:`);
  for (const r of report) {
    console.log(`  ${r.project}`);
    console.log(`    old: ${r.old}`);
    console.log(`    new: ${r.new}`);
  }

  fs.writeFileSync(PROJECTS_JSON, JSON.stringify(projects, null, 2) + '\n', 'utf8');
  console.log('\nprojects.json written.');
}

main().catch(err => { console.error('❌', err.message || err); process.exit(1); });
