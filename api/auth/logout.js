// GET /api/auth/logout
// Clears the session cookie and redirects to the login page.

export default function handler(req, res) {
  res.setHeader(
    'Set-Cookie',
    'auth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'
  );
  res.redirect(302, '/login.html');
}
