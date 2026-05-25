// GET /api/render?id=DRIVE_FILE_ID
//
// Proxies the full-resolution image from Drive using the service account.
// Unlike /api/thumb, no resizing — serves the original file bytes at full quality.
// Used by the rendering gallery so team members can right-click → Copy Image
// without going through the Google Drive UI.

'use strict';

const { google } = require('googleapis');

let _drive = null;

function getDrive() {
  if (_drive) return _drive;
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key:   (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  _drive = google.drive({ version: 'v3', auth });
  return _drive;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { id } = req.query;

  if (!id || !/^[\w-]{10,}$/.test(id)) {
    return res.status(400).send('Missing or invalid ?id= parameter.');
  }

  try {
    const drive = getDrive();

    // Get mime type and size before downloading
    const { data: meta } = await drive.files.get({
      fileId: id,
      fields: 'mimeType,size',
      supportsAllDrives: true,
    });

    const mime = meta.mimeType || 'application/octet-stream';

    // Only proxy image files — renders are always JPEG or PNG
    if (!mime.startsWith('image/')) {
      return res.status(415).send('Not an image file.');
    }

    // Guard against accidentally proxying huge files (renders are typically 200KB–4MB)
    const size = parseInt(meta.size || '0', 10);
    if (size > 25 * 1024 * 1024) {
      return res.status(413).send('File too large.');
    }

    // Download original file — no resizing, full quality
    const response = await drive.files.get(
      { fileId: id, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );

    const buf = Buffer.from(response.data);

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', buf.length);
    // Cache for 1 day; serve stale for up to 7 days while revalidating in background
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');

    return res.send(buf);

  } catch (err) {
    console.error('[/api/render] id=%s error=%s', id, err.message);
    return res.status(500).send('Failed to load render.');
  }
};
