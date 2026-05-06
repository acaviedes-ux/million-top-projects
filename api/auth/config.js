// GET /api/auth/config
// Returns the public Google OAuth Client ID for the frontend to initialize GIS.
// The Client ID is not a secret — it's safe to expose in the browser.

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ clientId: process.env.GOOGLE_CLIENT_ID || '' });
}
