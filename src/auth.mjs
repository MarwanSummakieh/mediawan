import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { scrypt } from 'node:crypto';
import { fail } from './store.mjs';
const derive = promisify(scrypt);
export function hashPassword(password) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(password, salt, 32).toString('hex')}`;
}
export async function verifyPassword(password, hash) {
  const [salt, expected] = String(hash || '').split(':');
  if (!/^[a-f0-9]{32}$/i.test(salt || '') || !/^[a-f0-9]{64}$/i.test(expected || '')) return false;
  return timingSafeEqual(
    await derive(password, Buffer.from(salt, 'hex'), 32),
    Buffer.from(expected, 'hex'),
  );
}
const digest = (value) => createHash('sha256').update(value).digest('hex');
export function setupAuth(app, store, config) {
  if (
    !store.one('SELECT id FROM users LIMIT 1') &&
    config.adminEmail &&
    config.adminPassword.length >= 10
  ) {
    store.run(
      'INSERT INTO users(email,name,pw_hash,role,can_download) VALUES(?,?,?,?,1)',
      config.adminEmail.toLowerCase(),
      'Administrator',
      hashPassword(config.adminPassword),
      'admin',
    );
  }
  const attempts = new Map();
  app.use((req, res, next) => {
    const cookie = /(?:^|;\s*)mediawan=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    if (cookie)
      req.user = store.one(
        'SELECT users.* FROM logins JOIN users ON users.id=logins.user_id WHERE token=? AND expires>? AND active=1',
        digest(cookie),
        Date.now(),
      );
    next();
  });
  const safe = (user) =>
    user
      ? {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          canDownload: user.role === 'admin' || !!user.can_download,
        }
      : null;
  app.get('/api/auth', (req, res) =>
    res.json({ user: safe(req.user), setupRequired: !store.one('SELECT id FROM users LIMIT 1') }),
  );
  app.post('/api/login', async (req, res, next) => {
    try {
      const key = req.ip,
        now = Date.now(),
        previous = attempts.get(key);
      const rate = previous && now - previous.start < 900000 ? previous : { start: now, count: 0 };
      if (attempts.size > 10000)
        for (const [k, v] of attempts) if (now - v.start >= 900000) attempts.delete(k);
      attempts.set(key, rate);
      if (++rate.count > 15) fail(429, 'Too many attempts. Try again in 15 minutes.');
      const { email, password } = req.body || {};
      if (typeof email !== 'string' || typeof password !== 'string' || password.length > 256)
        fail(400, 'Enter an email and password');
      const user = store.one('SELECT * FROM users WHERE email=? AND active=1', email.toLowerCase());
      if (!user || !(await verifyPassword(password, user.pw_hash)))
        fail(401, 'Email or password is incorrect');
      const token = randomBytes(32).toString('hex');
      store.run('DELETE FROM logins WHERE expires<?', now);
      store.run('INSERT INTO logins VALUES(?,?,?)', digest(token), user.id, now + 30 * 86400000);
      res.cookie('mediawan', token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: config.secureCookie,
        maxAge: 30 * 86400000,
        path: '/',
      });
      attempts.delete(key);
      res.json({ user: safe(user) });
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/logout', (req, res) => {
    const cookie = /(?:^|;\s*)mediawan=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    if (cookie) store.run('DELETE FROM logins WHERE token=?', digest(cookie));
    res.clearCookie('mediawan', { path: '/' });
    res.json({ ok: true });
  });
  app.use('/api', (req, res, next) =>
    req.user ? next() : res.status(401).json({ error: 'Sign in to continue' }),
  );
}
