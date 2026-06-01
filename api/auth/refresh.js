// POST /api/auth/refresh
// Called silently on every page load. Validates the current session cookie
// and reissues it with a fresh 30-day expiry — keeping active users logged in
// indefinitely without requiring them to re-authenticate on known devices.

import { createHmac } from 'node:crypto';

const SESSION_DURATION = 30 * 24 * 60 * 60 * 1000; // 30 days in ms
const COOKIE_MAX_AGE   = 2592000;                   // 30 days in seconds

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=').trim();
  }
  return cookies;
}

function verifyAndDecode(token, secret) {
  const dotIndex = token.lastIndexOf('.');
  if (dotIndex === -1) return null;

  const payload = token.slice(0, dotIndex);
  const sig     = token.slice(dotIndex + 1);

  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (sig !== expected) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!session.exp || Date.now() > session.exp) return null;
    return session;
  } catch {
    return null;
  }
}

function signSession(payload, secret) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const cookies = parseCookies(req.headers.cookie);
  const session = verifyAndDecode(cookies['auth'] || '', process.env.SESSION_SECRET);

  if (!session) return res.status(401).json({ error: 'No valid session' });

  const refreshed = {
    email: session.email,
    name:  session.name,
    exp:   Date.now() + SESSION_DURATION,
  };

  const isVercel   = process.env.VERCEL === '1';
  const secureFlag = isVercel ? '; Secure' : '';

  res.setHeader(
    'Set-Cookie',
    `auth=${signSession(refreshed, process.env.SESSION_SECRET)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}${secureFlag}`
  );

  return res.status(200).json({ ok: true });
}
