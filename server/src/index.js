const path = require('path');
// Загружаем .env из корня проекта или из server/
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const fastify = require('fastify');
const cookie = require('@fastify/cookie');
const { getDb } = require('./db');
const { hashPassword, verifyPassword, SESSION_TTL_MS, createSessionId } = require('./auth');
const authPlugin = require('./auth').plugin;
const { authRoutes, addAuthUtils, getSessionCookieOptions } = require('./auth');
const { logger } = require('../logger');
const {
  createHttpRedirectServer,
  getSecureConnectionConfig,
} = require('./secureConnection');

const SESSION_COOKIE = 'chagourtee_sid';

// Import version information from the dedicated version module
const { getVersionInfo } = require('./version');

// Import media plugin
const mediaPlugin = require('./media');

let secureConnection;
try {
  secureConnection = getSecureConnectionConfig();
} catch (error) {
  logger.error(`Secure connection configuration error: ${error.message}`);
  process.exit(1);
}

// Initialize Fastify server with request logging via custom hook
const server = fastify({
  logger: false,
  ...(secureConnection.enabled ? { https: secureConnection.tls } : {}),
});

// Track request start time for duration logging
server.addHook('onRequest', async (request, reply) => {
  request._startTime = Date.now();
});

// Log requests and responses through our custom logger
server.addHook('onResponse', async (request, reply) => {
  const duration = Date.now() - (request._startTime || Date.now());
  const method = request.method;
  const url = request.url;
  const status = reply.statusCode;
  const logLevel = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'debug';
  logger[logLevel](`${method} ${url} — ${status} (${duration}ms)`);
});

async function run() {
  const db = getDb();
  server.decorate('db', db);

  // START: Corrected bootstrap validation
  try {
    const userCount = db.prepare('SELECT COUNT(*) as n FROM users').get();
    
    // Only validate if there are users
    if (userCount.n > 0) {
      const firstUser = db.prepare('SELECT id, login, password_hash FROM users ORDER BY id ASC LIMIT 1').get();
      if (!firstUser.password_hash || firstUser.password_hash.trim() === '') {
        throw new Error(`Missing password_hash for bootstrap user (ID: ${firstUser.id}, login: ${firstUser.login})`);
      }
    }
  } catch (err) {
    server.log.error('Bootstrap validation failed:', err);
    process.exit(1);
  }
  // END: Corrected bootstrap validation

  server.decorate('getUser', function (userId) {
    const row = db.prepare('SELECT id, login, role, verified FROM users WHERE id = ?').get(userId);
    return row ? { ...row, verified: Boolean(row.verified) } : null;
  });

  await server.register(cookie, {
    secret: process.env.CHAGOURTEE_SESSION_SECRET || 'change-me-in-production',
  });
  await server.register(authPlugin);
  await server.register(addAuthUtils); // Register the auth utility functions

  server.addHook('preHandler', async function (request, reply) {
    const sessionId = request.cookies[SESSION_COOKIE];
    if (!sessionId) return;
    const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE id = ?').get(sessionId);
    if (!row || new Date(row.expires_at) < new Date()) {
      if (row) db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
      return;
    }
    request.session = { userId: row.user_id, sessionId };
    request.user = server.getUser(row.user_id);
  });

  // Single verification gate: while verification is enabled, unverified
  // accounts may only use the endpoints needed to finish verification or to
  // manage their own credentials. Everything else under /api is blocked.
  const VERIFICATION_ALLOWED_EXACT = new Set([
    '/api/verification/status',
    '/api/verification/codes/use',
    '/api/profile/change-password',
    '/api/profile/change-login',
    '/api/profile/registration-comment',
    '/api/version',
    '/api/server/settings',
  ]);

  server.addHook('preHandler', async function (request, reply) {
    if (!request.session || !request.user) return;

    const routeUrl = request.routeOptions?.url || request.url.split('?')[0];
    if (!routeUrl || !routeUrl.startsWith('/api/')) return;
    if (routeUrl.startsWith('/api/auth/')) return;
    if (VERIFICATION_ALLOWED_EXACT.has(routeUrl)) return;
    if (request.user.verified) return;

    const setting = db.prepare('SELECT enabled FROM verification_settings LIMIT 1').get();
    if (!setting || !setting.enabled) return;

    return reply.code(403).send({
      error: 'Account verification required',
      code: 'ACCOUNT_NOT_VERIFIED',
    });
  });

  // An account left unverified while verification is off would be locked out
  // by the client route guard even though the server already allows access.
  const initialVerificationSetting = db
    .prepare('SELECT enabled FROM verification_settings LIMIT 1')
    .get();
  if (!initialVerificationSetting || !initialVerificationSetting.enabled) {
    db.prepare("UPDATE users SET verified = 1 WHERE verified = 0 AND role = 'member'").run();
  }

  await server.register(authRoutes);

  require('./rooms')(server);
  require('./messages')(server);
  require('./invites')(server);
  require('./profile')(server);
  require('./verification')(server);
  require('./users')(server);
  require('./settings')(server);
  
  // Register media plugin
  await server.register(mediaPlugin);
  
  // Initialize WebSocket server
  require('./ws')(server);

  // Create the 'main' room if it doesn't exist and there is at least one user
  const existingMainRoom = db.prepare('SELECT id FROM rooms WHERE name = ?').get('main');
  if (!existingMainRoom) {
    // Check if there is at least one user in the database
    const firstUser = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
    
    if (firstUser) {
      // If a user exists, create the main room with that user as creator
      db.prepare('INSERT INTO rooms (name, created_by) VALUES (?, ?)').run('main', firstUser.id);
      if (process.env.DEBUG_MODE === 'true') {
        server.log.info("Created 'main' room on first startup with user ID:", firstUser.id);
      }
    } else {
      // If no users exist yet, we defer creating the main room until the first user registers
      if (process.env.DEBUG_MODE === 'true') {
        server.log.info("No users exist yet, deferring main room creation until first user registers.");
      }
    }
  } else {
    if (process.env.DEBUG_MODE === 'true') {
      server.log.info("Main room already exists, skipping creation.");
    }
  }

  server.post('/api/auth/register', async (request, reply) => {
    const { inviteId, login, password, comment, bootstrap } = request.body || {};
    if (!login || !password) {
      return reply.code(400).send({ error: 'Login and password required' });
    }
    
    // Additional validation for password_hash integrity
    if (typeof password !== 'string' || password.trim().length === 0) {
      return reply.code(400).send({ error: 'Password must be a non-empty string' });
    }
    
    const loginTrim = login.trim();
    
    // Validate login format: only alphanumeric characters, length between 2 and 32
    if (!/^[a-zA-Z0-9]{2,32}$/.test(loginTrim)) {
      return reply.code(400).send({ error: 'Login must be 2-32 characters long and contain only letters and numbers' });
    }
    
    const existing = server.db.prepare('SELECT id FROM users WHERE login = ?').get(loginTrim);
    if (existing) return reply.code(400).send({ error: 'Login already taken' });

    const userCount = server.db.prepare('SELECT COUNT(*) as n FROM users').get();
    const isFirstUser = userCount.n === 0;
    const bootstrapOk = isFirstUser && bootstrap && bootstrap === process.env.CHAGOURTEE_BOOTSTRAP_SECRET;

    if (bootstrapOk) {
      server.db.prepare(
        'INSERT INTO users (login, password_hash, role, verified) VALUES (?, ?, ?, 1)'
      ).run(loginTrim, hashPassword(password), 'owner');
    } else {
      if (!inviteId) return reply.code(400).send({ error: 'Invite required' });
      const invite = server.db.prepare(
        'SELECT id, created_by, max_uses, uses_count, expires_at FROM invites WHERE id = ?'
      ).get(inviteId);
      if (!invite) return reply.code(400).send({ error: 'Invalid invite' });
      if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
        return reply.code(400).send({ error: 'Invite expired' });
      }
      if (invite.max_uses != null && invite.uses_count >= invite.max_uses) {
        return reply.code(400).send({ error: 'Invite limit reached' });
      }
      // Check if verification is enabled globally
      const verificationSetting = server.db.prepare('SELECT enabled FROM verification_settings LIMIT 1').get();
      const isVerificationEnabled = verificationSetting ? !!verificationSetting.enabled : false;

      let registrationComment = null;
      if (isVerificationEnabled && comment !== undefined && comment !== null) {
        if (typeof comment !== 'string') {
          return reply.code(400).send({ error: 'Comment must be a string' });
        }
        const trimmedComment = comment.trim();
        if (trimmedComment.length > 500) {
          return reply.code(400).send({ error: 'Comment must not exceed 500 characters' });
        }
        registrationComment = trimmedComment.length > 0 ? trimmedComment : null;
      }

      // Only the verification system may leave a new account unverified.
      // Otherwise a stray comment must not lock the user out.
      const shouldBeVerified = isVerificationEnabled ? 0 : 1;

      server.db.prepare(
        'INSERT INTO users (login, password_hash, role, verified, registration_comment) VALUES (?, ?, ?, ?, ?)'
      ).run(loginTrim, hashPassword(password), 'member', shouldBeVerified, registrationComment);
      server.db.prepare('UPDATE invites SET uses_count = uses_count + 1 WHERE id = ?').run(inviteId);
    }

    const userId = server.db.prepare('SELECT id FROM users WHERE login = ?').get(loginTrim).id;

    // New accounts waiting for review must appear in the admin queue without
    // a page reload.
    const registeredUser = server.db
      .prepare('SELECT verified FROM users WHERE id = ?')
      .get(userId);
    if (registeredUser && !registeredUser.verified && server.broadcastVerificationPendingChanged) {
      server.broadcastVerificationPendingChanged();
    }
    
    // After registering the first user, check if main room exists, if not create it
    if (isFirstUser) {
      const existingMainRoom = server.db.prepare('SELECT id FROM rooms WHERE name = ?').get('main');
      if (!existingMainRoom) {
        server.db.prepare('INSERT INTO rooms (name, created_by) VALUES (?, ?)').run('main', userId);
        if (process.env.DEBUG_MODE === 'true') {
          server.log.info("Created 'main' room for first user with ID:", userId);
        }
      }
    }

    const sessionId = createSessionId();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    
    // Store session in DB
    server.db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(
      sessionId,
      userId,
      expiresAt
    );
    
    // Set session cookie
    reply.setCookie(SESSION_COOKIE, sessionId, {
      ...getSessionCookieOptions(request),
      maxAge: Math.floor(SESSION_TTL_MS / 1000), // in seconds
    });

    const user = server.getUser(userId);
    return { user };
  });

  // Add version endpoint
  server.get('/api/version', async (request, reply) => {
    const versionInfo = getVersionInfo();
    return versionInfo;
  });

  // Run the server
  let httpRedirectServer = null;
  try {
    await server.listen({ port: process.env.PORT || 3000, host: process.env.HOST || '0.0.0.0' });
    const actualPort = server.server.address().port;
    const protocol = secureConnection.enabled ? 'https' : 'http';
    logger.info(`Server listening on ${protocol} port ${actualPort}`);

    if (secureConnection.enabled) {
      const redirectPort = secureConnection.redirectPort ?? actualPort + 1;
      if (redirectPort > 65535) {
        logger.warn(
          `HTTP-to-HTTPS redirect is disabled: redirect port ${redirectPort} is out of range. Set HTTP_REDIRECT_PORT explicitly.`
        );
      } else {
        httpRedirectServer = createHttpRedirectServer({ httpsPort: actualPort });
        httpRedirectServer.on('error', (error) => {
          logger.warn(
            `HTTP-to-HTTPS redirect server on port ${redirectPort} failed: ${error.message}`
          );
        });
        httpRedirectServer.listen(redirectPort, secureConnection.redirectHost, () => {
          logger.info(
            `HTTP redirect listening on port ${redirectPort} -> ${protocol}://<host>:${actualPort}`
          );
        });
      }
      logger.info(`TLS certificate: ${secureConnection.certificates.cert}`);
    }

    logger.info(`Log level: ${logger.getLogLevel()}`);
    if (process.env.CHAGOURTEE_LOG_TO_FILE === 'true') {
      logger.info(`Logging to file: ${logger.getLogFile()}`);
    }
  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }

  let isShuttingDown = false;
  async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`Received ${signal}, starting graceful shutdown...`);
    try {
      if (typeof server.notifyServerShutdown === 'function') {
        server.notifyServerShutdown('Сервер останавливается');
      }
    } catch (e) {
      logger.error('Error during shutdown notification:', e);
    }
    try {
      await server.close();
      logger.info('Server closed successfully');
    } catch (e) {
      logger.error('Error closing server:', e);
    }
    if (httpRedirectServer?.listening) {
      await new Promise((resolve) => httpRedirectServer.close(() => resolve()));
    }
    logger.close();
    process.exit(0);
  }

  process.on('SIGINT', () => {
    void gracefulShutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void gracefulShutdown('SIGTERM');
  });
}

run();