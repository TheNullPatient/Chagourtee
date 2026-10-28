const bcrypt = require('bcrypt');
const crypto = require('crypto');
const fp = require('fastify-plugin');

const SALT_ROUNDS = 10;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function hashPassword(password) {
  return bcrypt.hashSync(password, SALT_ROUNDS);
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

function createSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

function isOwnerOrModerator(role) {
  return role === 'owner' || role === 'moderator';
}

/**
 * Cookie options for the session cookie.
 *
 * `secure` must only be enabled when the app is actually served over HTTPS.
 * Browsers silently drop `Secure` cookies received over plain HTTP, except on
 * localhost (which is treated as a trustworthy origin). That is why a build
 * running in production mode over a LAN IP (http://192.168.x.x) could log in
 * successfully but then look unauthenticated on every request.
 *
 * By default the flag is derived from the request protocol (including
 * X-Forwarded-Proto for reverse proxies). Set CHAGOURTEE_COOKIE_SECURE=true/false
 * to override it explicitly.
 */
function isSecureRequest(request) {
  const explicit = String(process.env.CHAGOURTEE_COOKIE_SECURE || '').trim().toLowerCase();
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;

  const forwardedProto = String(request?.headers?.['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();

  return request?.protocol === 'https' || forwardedProto === 'https';
}

function getSessionCookieOptions(request) {
  return {
    httpOnly: true,
    secure: isSecureRequest(request),
    path: '/',
    sameSite: 'strict',
  };
}

function requireAuth(fastify, _opts, done) {
  fastify.decorate('requireAuth', async function (request, reply) {
    if (!request.session?.userId) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const user = fastify.getUser(request.session.userId);
    if (!user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    request.user = user;
  });
  fastify.decorate('requireOwnerOrModerator', async function (request, reply) {
    if (!request.session?.userId) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const user = fastify.getUser(request.session.userId);
    if (!user || !isOwnerOrModerator(user.role)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    request.user = user;
  });
  fastify.decorate('requireOwner', async function (request, reply) {
    if (!request.session?.userId) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const user = fastify.getUser(request.session.userId);
    if (!user || user.role !== 'owner') {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    request.user = user;
  });
  done();
}

// Add the isOwnerOrModerator function to fastify instance
function addAuthUtils(fastify, _opts, done) {
  fastify.decorate('isOwnerOrModerator', isOwnerOrModerator);
  done();
}

function authRoutes(fastify, _opts, done) {
  const db = fastify.db;

  fastify.get('/api/auth/me', {
    preHandler: [fastify.requireAuth],
  }, async (request, reply) => {
    const user = fastify.getUser(request.session.userId);
    if (!user) return reply.code(401).send({ error: 'Unauthorized' });
    return {
      id: user.id,
      login: user.login,
      role: user.role,
      verified: Boolean(user.verified),
    };
  });

  fastify.post('/api/auth/login', async (request, reply) => {
    const { login, password } = request.body || {};
    if (!login || !password) {
      return reply.code(400).send({ error: 'Login and password required' });
    }
    const user = db.prepare('SELECT id, login, password_hash, role, verified FROM users WHERE login = ?').get(login.trim());
    if (!user || !verifyPassword(password, user.password_hash)) {
      return reply.code(401).send({ error: 'Invalid login or password' });
    }
    const sessionId = createSessionId();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    
    // Store session in DB
    db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(
      sessionId,
      user.id,
      expiresAt
    );
    
    // Set session cookie
    reply.setCookie(SESSION_COOKIE, sessionId, {
      ...getSessionCookieOptions(request),
      maxAge: Math.floor(SESSION_TTL_MS / 1000), // in seconds
    });
    
    return { user: { id: user.id, login: user.login, role: user.role, verified: Boolean(user.verified) } };
  });

  fastify.post('/api/auth/logout', {
    preHandler: [fastify.requireAuth],
  }, async (request, reply) => {
    if (request.session?.sessionId) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(request.session.sessionId);
    }
    request.session = null;
    reply.clearCookie(SESSION_COOKIE, getSessionCookieOptions(request));
    return { ok: true };
  });

  const SESSION_COOKIE = 'chagourtee_sid';

  done();
}

module.exports = { 
  plugin: fp(requireAuth), 
  authRoutes,
  addAuthUtils,
  getSessionCookieOptions,
  hashPassword,
  verifyPassword,
  createSessionId,
  isOwnerOrModerator,
  SESSION_TTL_MS
};