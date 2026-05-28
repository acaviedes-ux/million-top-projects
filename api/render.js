// GET /api/render?id=DRIVE_FILE_ID
//
// 302-redirects to Drive's direct image URL on lh3.googleusercontent.com so the
// browser renders the original full-resolution image INLINE (not Drive's viewer
// or download UI). With the image displayed inline, the team can right-click →
// "Copy Image" to paste it directly into Slack, email, presentations, etc.
//
// Why not proxy the bytes through this function?
//   • Vercel Serverless caps response bodies at ~4.5 MB. Renders are routinely
//     10–40+ MB PNGs (e.g. 6400×3904), which the previous Buffer-based proxy
//     could never have delivered.
//   • Even when streaming, the function still pays bandwidth and execution
//     time for every fetch. Redirecting to Google's CDN is instant.
//
// Requirement: each Drive file referenced in projects.json must be publicly
// readable. scripts/make-drive-files-public.js (run after every seed) ensures
// this — no service-account auth needed on the redirect target.

'use strict';

module.exports = (req, res) => {
  const { id } = req.query;

  if (!id || !/^[\w-]{10,}$/.test(id)) {
    return res.status(400).send('Missing or invalid ?id= parameter.');
  }

  // Drive file IDs are immutable — re-uploading a file always assigns a new ID,
  // so the redirect target for a given ?id= never changes. Cache aggressively.
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  res.setHeader('Location', `https://lh3.googleusercontent.com/d/${id}`);
  return res.status(302).end();
};
