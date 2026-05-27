// POST /api/auth/google
// Verifies a Google Identity Services credential JWT, checks the allowed
// email domain, then sets an HMAC-signed session cookie.

import { createHmac } from 'node:crypto';

function signSession(payload, secret) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { credential } = req.body ?? {};
  if (!credential || typeof credential !== 'string') {
    return res.status(400).json({ error: 'Missing credential' });
  }

  // Verify JWT with Google — their server checks the signature and expiry.
  const tokenRes = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`
  );
  if (!tokenRes.ok) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const tokenData = await tokenRes.json();

  if (tokenData.aud !== process.env.GOOGLE_CLIENT_ID) {
    return res.status(401).json({ error: 'Token audience mismatch' });
  }

  const email = tokenData.email;
  const domain = email?.split('@')[1];

  if (!domain || domain !== process.env.ALLOWED_DOMAIN) {
    return res.status(403).json({ error: 'Unauthorized domain' });
  }

  const session = {
    email,
    name: tokenData.name || email,
    exp: Date.now() + 3 * 24 * 60 * 60 * 1000,
  };

  const cookieValue = signSession(session, process.env.SESSION_SECRET);
  const isVercel = process.env.VERCEL === '1';
  const secureFlag = isVercel ? '; Secure' : '';

  res.setHeader(
    'Set-Cookie',
    `auth=${cookieValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=259200${secureFlag}`
  );

  return res.status(200).json({ ok: true });
}
