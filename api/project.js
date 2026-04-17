// GET /api/project?slug=619-residences
// Returns full project data: static config + dynamic data from esqueleto

const { google } = require('googleapis');
const path = require('path');

const SPREADSHEET_ID = process.env.ESQUELETO_SPREADSHEET_ID;
const SHEET_NAME     = 'Projects Overview';
const NAME_COL       = 1;
const DATA_START_ROW = 2;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: 'Missing ?slug= parameter.' });

  try {
    // ── Static config ───────────────────────────────────────
    const projectsConfig = require(path.join(__dirname, '../data/projects.json'));
    const cfg = projectsConfig.find(p => p.slug === slug);
    if (!cfg) return res.status(404).json({ error: 'Project not found in config.' });

    // ── Google Sheets auth ──────────────────────────────────
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key:  (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const sheets   = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:AH`,
    });

    const rows = response.data.values || [];
    let row = null;
    for (let i = DATA_START_ROW; i < rows.length; i++) {
      if ((rows[i][NAME_COL] || '').toString().trim() === cfg.esqueletoName) {
        row = rows[i];
        break;
      }
    }

    if (!row) return res.status(404).json({ error: 'Project not found in spreadsheet.' });

    // ── Build response ──────────────────────────────────────
    return res.status(200).json({
      // Static
      name:               cfg.name,
      slug:               cfg.slug,
      startingPrice:      cfg.startingPrice || null,
      hero:               cfg.hero          || null,
      buildingDescription:cfg.buildingDescription || null,
      stylishAmenities:   cfg.stylishAmenities    || null,
      brochures:          cfg.brochures           || [],
      // Dynamic from sheet
      address:            val(row, 8)    || null,
      developer:          val(row, 14)   || null,
      architecture:       val(row, 15)   || null,
      interiorDesign:     val(row, 16)   || null,
      completionDate:     val(row, 13)   || null,
      depositStructure:   multiline(row, 19),
      rentalRestrictions: multiline(row, 17),
      parkingSpaces:      multiline(row, 18),
      hoa:                val(row, 21)   || null,
      contact:            buildContact(row),
    });

  } catch (err) {
    console.error('[/api/project]', err.message);
    return res.status(500).json({ error: 'Failed to fetch project data.' });
  }
};

// ── Helpers ──────────────────────────────────────────────────

function val(row, col) {
  return (row[col] || '').toString().trim() || null;
}

function multiline(row, col) {
  const v = val(row, col);
  if (!v) return null;
  return v.split('\n').map(s => s.trim()).filter(Boolean);
}

function buildContact(row) {
  const raw = (row[30] || '').toString().trim();
  if (!raw) return null;

  const names  = raw.split('\n').map(s => s.trim()).filter(Boolean);
  const phones = (row[31] || '').toString().split('\n');
  const emails = (row[32] || '').toString().split('\n');

  return names.map((name, i) => ({
    name,
    phone: afterColon(phones[i] || ''),
    email: afterColon(emails[i] || ''),
  }));
}

function afterColon(s) {
  if (!s) return '';
  const idx = s.indexOf(':');
  return idx === -1 ? s.trim() : s.substring(idx + 1).trim();
}
