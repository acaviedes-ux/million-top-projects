// Vercel Edge Middleware — protects all routes behind Google auth.
// Runs before any static file or serverless function is served.

export const config = {
  matcher: ['/(.*)',],
};

const PUBLIC_PATHS = new Set([
  '/login.html',
  '/login',
  '/style.css',
  '/images/logo.png',
  '/favicon.ico',
]);

function isPublic(pathname) {
  if (PUBLIC_PATHS.has(pathname)) return true;
  // All /api/auth/* endpoints are public (login, logout, config)
  if (pathname.startsWith('/api/auth')) return true;
  return false;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=').trim();
  }
  return cookies;
}

function base64urlToBuffer(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (base64.length % 4)) % 4;
  const padded = base64 + '='.repeat(padding);
  const binary = atob(padded);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

async function verifySession(token, secret) {
  const dotIndex = token.lastIndexOf('.');
  if (dotIndex === -1) return null;

  const payload = token.slice(0, dotIndex);
  const sig = token.slice(dotIndex + 1);

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64urlToBuffer(sig),
      new TextEncoder().encode(payload)
    );
    if (!valid) return null;

    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const session = JSON.parse(json);

    if (!session.exp || Date.now() > session.exp) return null;

    return session;
  } catch {
    return null;
  }
}

export default async function middleware(request) {
  const url = new URL(request.url);
  const { pathname } = url;

  if (isPublic(pathname)) return;

  const cookies = parseCookies(request.headers.get('cookie'));
  const authCookie = cookies['auth'];

  if (!authCookie) {
    const loginUrl = new URL('/login.html', request.url);
    loginUrl.searchParams.set('from', pathname + url.search);
    return Response.redirect(loginUrl, 302);
  }

  const secret = process.env.SESSION_SECRET;
  const session = await verifySession(authCookie, secret);

  if (!session) {
    const loginUrl = new URL('/login.html', request.url);
    loginUrl.searchParams.set('from', pathname + url.search);
    return Response.redirect(loginUrl, 302);
  }
}
