'use strict';

const crypto = require('crypto');

/**
 * Returns a stable per-installation secret.
 *
 * Secrets used to have hard-coded fallbacks. Those values are public in the
 * source tree, so anyone could forge signed cookies or precompute verification
 * code hashes. If an environment variable is not provided, a random secret is
 * generated once and stored in the database, so it survives restarts without
 * requiring any manual configuration.
 */
function getOrCreateSecret(db, key) {
  if (!db) throw new Error('Database is required to read server secrets');

  const existing = db
    .prepare('SELECT value FROM server_secrets WHERE key = ?')
    .get(key);
  if (existing && typeof existing.value === 'string' && existing.value.length > 0) {
    return existing.value;
  }

  const value = crypto.randomBytes(32).toString('hex');
  db.prepare(
    'INSERT OR IGNORE INTO server_secrets (key, value) VALUES (?, ?)'
  ).run(key, value);

  return db.prepare('SELECT value FROM server_secrets WHERE key = ?').get(key).value;
}

/**
 * Secret for signing cookies and other session-adjacent values.
 * CHAGOURTEE_SESSION_SECRET always wins, so existing deployments keep working.
 */
function getSessionSecret(db) {
  const configured = String(process.env.CHAGOURTEE_SESSION_SECRET || '').trim();
  if (configured) return configured;
  return getOrCreateSecret(db, 'session');
}

/**
 * Secret used to hash one-time verification codes. The raw code is never
 * stored, so this secret only needs to stay stable across restarts.
 */
function getVerificationCodeSecret(db) {
  const configured = String(process.env.CHAGOURTEE_SESSION_SECRET || '').trim();
  if (configured) return configured;
  return getOrCreateSecret(db, 'verification-code');
}

module.exports = {
  getOrCreateSecret,
  getSessionSecret,
  getVerificationCodeSecret,
};
