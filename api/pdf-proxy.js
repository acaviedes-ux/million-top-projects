// GET /api/pdf-proxy?id=DRIVE_FILE_ID
//
// Authenticated proxy that streams Drive PDFs to the browser.
// The session cookie is validated by middleware.js before this handler runs.
//
// Range requests are supported so that pdfjs-dist (running in the browser) can
// fetch only the bytes it needs for page-1 rendering, rather than the full PDF.
// For an 88 MB file pdfjs typically only needs ~200 KB via 2-3 range requests.

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
  const { id } = req.query;

  if (!id || !/^[\w-]{10,}$/.test(id)) {
    return res.status(400).send('Missing or invalid ?id= parameter.');
  }

  // Allow pdfjs-dist to make range requests from the browser
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const drive = getDrive();

    // File size is needed to construct a valid Content-Range header
    const { data: meta } = await drive.files.get({
      fileId: id,
      fields: 'size,mimeType',
      supportsAllDrives: true,
    });

    const fileSize = parseInt(meta.size || '0', 10);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');

    const rangeHeader = req.headers['range'];

    if (rangeHeader && fileSize > 0) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end   = match[2] ? Math.min(parseInt(match[2], 10), fileSize - 1)
                                : fileSize - 1;

        const { data } = await drive.files.get(
          { fileId: id, alt: 'media', supportsAllDrives: true },
          { responseType: 'arraybuffer', headers: { Range: `bytes=${start}-${end}` } }
        );

        const buf       = Buffer.from(data);
        const actualEnd = start + buf.length - 1;

        res.setHeader('Content-Range',  `bytes ${start}-${actualEnd}/${fileSize}`);
        res.setHeader('Content-Length', buf.length);
        return res.status(206).send(buf);
      }
    }

    // Full download (no range or unrecognised range syntax)
    const { data } = await drive.files.get(
      { fileId: id, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );

    const buf = Buffer.from(data);
    res.setHeader('Content-Length', buf.length);
    return res.status(200).send(buf);

  } catch (err) {
    console.error('[/api/pdf-proxy] id=%s error=%s', id, err.message);
    return res.status(500).send('Error fetching file.');
  }
};
