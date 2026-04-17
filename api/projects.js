// GET /api/projects
// Returns the full project list (name, slug, thumbnail, startingPrice)
// Dynamic names from the esqueleto sheet; static config from data/projects.json

const { google } = require('googleapis');
const path = require('path');

const SPREADSHEET_ID = process.env.ESQUELETO_SPREADSHEET_ID;
const SHEET_NAME     = 'Projects Overview';
const NAME_COL       = 1;   // Column B (0-based)
const DATA_START_ROW = 2;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  try {
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
      range: `${SHEET_NAME}!B:B`,   // Only fetch name column
    });

    const rows = response.data.values || [];

    // ── Load static config ──────────────────────────────────
    const projectsConfig = require(path.join(__dirname, '../data/projects.json'));
    const configByName   = {};
    projectsConfig.forEach(p => { configByName[p.esqueletoName] = p; });

    // ── Build list ──────────────────────────────────────────
    const projects = [];
    for (let i = DATA_START_ROW; i < rows.length; i++) {
      const name = (rows[i][0] || '').toString().trim();
      if (!name) continue;
      const cfg = configByName[name] || {};
      projects.push({
        name,
        slug:          cfg.slug          || slugify(name),
        startingPrice: cfg.startingPrice || null,
        thumbnail:     cfg.thumbnail     || null,
      });
    }

    return res.status(200).json(projects);

  } catch (err) {
    console.error('[/api/projects]', err.message);
    return res.status(500).json({ error: 'Failed to fetch projects.' });
  }
};

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim('-');
}
