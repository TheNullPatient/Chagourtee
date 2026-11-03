'use strict';

/**
 * Granular permissions for moderators.
 *
 * Every permission maps to one section of the admin panel (except
 * `manage_permissions`, which controls who may edit other moderators).
 * Owners always have every permission. Moderators receive a sensible default
 * set when promoted and can be tuned by the owner afterwards. Members never
 * have admin permissions.
 */

const PERMISSIONS = Object.freeze([
  'manage_invites',
  'manage_server',
  'manage_media',
  'manage_rooms',
  'manage_verification',
  'manage_users',
  'manage_permissions',
]);

// Moderators keep the basic capabilities they had before granular permissions:
// working with invites, rooms and the verification queue.
const DEFAULT_PERMISSIONS = Object.freeze([
  'manage_invites',
  'manage_rooms',
  'manage_verification',
]);

const PERMISSION_SET = new Set(PERMISSIONS);

function isPermission(value) {
  return PERMISSION_SET.has(value);
}

/**
 * Validates and de-duplicates a permission list. Returns `{ ok, permissions }`
 * or `{ ok: false, error }`.
 */
function normalizePermissionList(value) {
  if (!Array.isArray(value)) {
    return { ok: false, error: 'permissions must be an array' };
  }

  const permissions = [];
  for (const item of value) {
    if (typeof item !== 'string' || !isPermission(item)) {
      return { ok: false, error: `Unknown permission: ${String(item)}` };
    }
    if (!permissions.includes(item)) permissions.push(item);
  }

  return { ok: true, permissions };
}

function getUserPermissions(db, userId) {
  if (!userId) return [];
  return db
    .prepare(
      `SELECT permission FROM user_permissions
       WHERE user_id = ?
       ORDER BY permission ASC`
    )
    .all(userId)
    .map((row) => row.permission);
}

/**
 * Every permission the user effectively has. Owners are implicit.
 */
function getEffectivePermissions(db, user) {
  if (!user) return [];
  if (user.role === 'owner') return [...PERMISSIONS];
  if (user.role !== 'moderator') return [];
  return getUserPermissions(db, user.id);
}

function hasPermission(db, user, permission) {
  if (!user || !isPermission(permission)) return false;
  if (user.role === 'owner') return true;
  if (user.role !== 'moderator') return false;
  return Boolean(
    db
      .prepare('SELECT 1 FROM user_permissions WHERE user_id = ? AND permission = ?')
      .get(user.id, permission)
  );
}

function replaceUserPermissions(db, userId, permissions, grantedBy) {
  const insert = db.prepare(
    'INSERT INTO user_permissions (user_id, permission, granted_by) VALUES (?, ?, ?)'
  );
  const remove = db.prepare('DELETE FROM user_permissions WHERE user_id = ?');
  const markInitialized = db.prepare(
    'UPDATE users SET permissions_initialized = 1 WHERE id = ?'
  );
  db.transaction(() => {
    remove.run(userId);
    for (const permission of permissions) {
      insert.run(userId, permission, grantedBy ?? null);
    }
    markInitialized.run(userId);
  })();
}

function clearUserPermissions(db, userId) {
  const markUninitialized = db.prepare(
    'UPDATE users SET permissions_initialized = 0 WHERE id = ?'
  );
  db.transaction(() => {
    db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(userId);
    markUninitialized.run(userId);
  })();
}

/**
 * Gives moderators that predate granular permissions their default set once.
 * The `permissions_initialized` flag makes sure explicitly cleared grants are
 * not re-added on every restart.
 */
function initializeDefaultPermissionsForModerators(db) {
  const pending = db
    .prepare("SELECT id FROM users WHERE role = 'moderator' AND permissions_initialized = 0")
    .all();
  if (pending.length === 0) return;

  const insert = db.prepare(
    'INSERT OR IGNORE INTO user_permissions (user_id, permission, granted_by) VALUES (?, ?, NULL)'
  );
  const markInitialized = db.prepare(
    'UPDATE users SET permissions_initialized = 1 WHERE id = ?'
  );

  db.transaction(() => {
    for (const user of pending) {
      for (const permission of DEFAULT_PERMISSIONS) {
        insert.run(user.id, permission);
      }
      markInitialized.run(user.id);
    }
  })();
}

module.exports = {
  PERMISSIONS,
  DEFAULT_PERMISSIONS,
  isPermission,
  normalizePermissionList,
  getUserPermissions,
  getEffectivePermissions,
  hasPermission,
  replaceUserPermissions,
  clearUserPermissions,
  initializeDefaultPermissionsForModerators,
};
