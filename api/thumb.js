// GET /api/thumb?id=DRIVE_FILE_ID
//
// Proxies a Google Drive thumbnail using service-account auth so we can
// serve previews for files that were uploaded via API and never opened
// in the Drive viewer (those files have no public thumbnail cached on lh3).
//
// Flow:
//   1. Call drive.files.get({ fields: 'thumbnailLink' }) with service-account
//   2. If thumbnailLink exists → fetch that lh3.googleusercontent.com URL and pipe back
//   3. If not (thumbnail not yet generated) → return a clean placeholder SVG

'use strict';

const { google } = require('googleapis');

// Module-level cache — reused across warm Lambda invocations
let _drive = null;

function getDrive() {
  if (_drive) return _drive;
  const auth = new google.auth.JWT({
    email:  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key:    (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  _drive = google.drive({ version: 'v3', auth });
  return _drive;
}

module.exports = async (req, res) => {
  const { id } = req.query;

  // Basic validation — Drive file IDs are alphanumeric + hyphens, 10+ chars
  if (!id || !/^[\w-]{10,}$/.test(id)) {
    return res.status(400).send('Missing or invalid ?id= parameter.');
  }

  try {
    const drive = getDrive();

    const { data } = await drive.files.get({
      fileId: id,
      fields: 'thumbnailLink',
    });

    if (data.thumbnailLink) {
      // thumbnailLink is a lh3.googleusercontent.com URL — publicly accessible CDN
      const imgRes = await fetch(data.thumbnailLink);

      if (imgRes.ok) {
        const buf = Buffer.from(await imgRes.arrayBuffer());
        res.setHeader('Content-Type', imgRes.headers.get('content-type') || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
        return res.send(buf);
      }
    }

    // Drive hasn't generated a thumbnail for this file yet → show placeholder
    return sendPlaceholder(res);

  } catch (err) {
    console.error('[/api/thumb] id=%s error=%s', id, err.message);
    return sendPlaceholder(res);
  }
};

// ── Placeholder ───────────────────────────────────────────────────────────────
// Minimal SVG that looks like a document icon — same proportions as a PDF page

function sendPlaceholder(res) {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="520" viewBox="0 0 400 520">',
    '  <rect width="400" height="520" fill="#f6f6f6"/>',
    '  <!-- document outline -->',
    '  <rect x="145" y="135" width="110" height="140" rx="4" fill="none" stroke="#d0d0d0" stroke-width="2"/>',
    '  <!-- folded corner -->',
    '  <path d="M225 135 L255 165 L225 165 Z" fill="#d0d0d0"/>',
    '  <path d="M225 135 L255 165 L225 165" fill="none" stroke="#d0d0d0" stroke-width="2"/>',
    '  <!-- text lines -->',
    '  <line x1="165" y1="195" x2="235" y2="195" stroke="#d0d0d0" stroke-width="2"/>',
    '  <line x1="165" y1="210" x2="235" y2="210" stroke="#d0d0d0" stroke-width="2"/>',
    '  <line x1="165" y1="225" x2="215" y2="225" stroke="#d0d0d0" stroke-width="2"/>',
    '  <!-- label -->',
    '  <text x="200" y="330" font-family="sans-serif" font-size="13" fill="#c0c0c0" text-anchor="middle">No preview available</text>',
    '</svg>',
  ].join('\n');

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).send(svg);
}
