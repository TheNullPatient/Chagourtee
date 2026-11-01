'use strict';

/**
 * Granular permissions for moderators.
 *
 * Owners always have every permission. Moderators start with none and are
 * granted individual permissions by the owner (or by a moderator who was
 * trusted with `manage_permissions`). Members never have admin permissions.
 */

const PERMISSIONS = Object.freeze([
  'create_rooms',
  'delete_rooms',
  'edit_rooms',
  'manage_users',
  'manage_permissions',
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
  db.transaction(() => {
    remove.run(userId);
    for (const permission of permissions) {
      insert.run(userId, permission, grantedBy ?? null);
    }
  })();
}

function clearUserPermissions(db, userId) {
  db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(userId);
}

module.exports = {
  PERMISSIONS,
  isPermission,
  normalizePermissionList,
  getUserPermissions,
  getEffectivePermissions,
  hasPermission,
  replaceUserPermissions,
  clearUserPermissions,
};
