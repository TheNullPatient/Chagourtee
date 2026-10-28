'use strict';

/**
 * Shared room access rules.
 *
 * Levels:
 *  - public     — everyone can read and write
 *  - closed     — visible to everyone, but a password is required to enter
 *  - private    — hidden from everyone except whitelisted users
 *  - restricted — visible in the list, but only whitelisted users can enter
 *
 * Owners and moderators bypass every restriction so they can manage rooms.
 */

const { hashPassword, verifyPassword, isOwnerOrModerator } = require('./auth');

const ACCESS_LEVELS = Object.freeze(['public', 'closed', 'private', 'restricted']);
const DEFAULT_ACCESS_LEVEL = 'public';
const ROOM_PASSWORD_MIN_LENGTH = 4;
const ROOM_PASSWORD_MAX_LENGTH = 128;
// How long a user may postpone re-entering a room password (0 = ask on every visit).
const ROOM_UNLOCK_MAX_MINUTES = 60;
// A "do not remember" unlock is revoked as soon as the user leaves the room.
// This fallback only matters if the socket never reports the leave (crash,
// killed tab, network loss), so it is deliberately generous.
const EPHEMERAL_UNLOCK_FALLBACK_MINUTES = 12 * 60;

function isValidAccessLevel(value) {
  return ACCESS_LEVELS.includes(String(value || '').trim().toLowerCase());
}

function normalizeAccessLevel(value, fallback = DEFAULT_ACCESS_LEVEL) {
  const normalized = String(value || '').trim().toLowerCase();
  return ACCESS_LEVELS.includes(normalized) ? normalized : fallback;
}

function isPrivileged(user) {
  return isOwnerOrModerator(user?.role);
}

function getRoom(db, roomId) {
  return db
    .prepare(
      `SELECT id, name, created_by, access_level, password_hash, created_at
       FROM rooms WHERE id = ?`
    )
    .get(roomId);
}

function isRoomMember(db, roomId, userId) {
  if (!userId) return false;
  return Boolean(
    db
      .prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?')
      .get(roomId, userId)
  );
}

function hasRoomUnlock(db, roomId, userId) {
  if (!userId) return false;
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM room_unlocks
         WHERE room_id = ? AND user_id = ?
           AND (expires_at IS NULL OR expires_at > datetime('now'))`
      )
      .get(roomId, userId)
  );
}

/**
 * Whether the room should appear in the user's room list at all.
 * Private rooms are hidden from non-members to avoid leaking their existence.
 */
function canViewRoom(db, room, user) {
  if (!room || !user?.id) return false;
  if (isPrivileged(user)) return true;
  if (normalizeAccessLevel(room.access_level) === 'private') {
    return isRoomMember(db, room.id, user.id);
  }
  return true;
}

/** Whether the user may read and send messages in the room. */
function canAccessRoom(db, room, user) {
  if (!room || !user?.id) return false;
  if (isPrivileged(user)) return true;

  switch (normalizeAccessLevel(room.access_level)) {
    case 'private':
    case 'restricted':
      return isRoomMember(db, room.id, user.id);
    case 'closed':
      return hasRoomUnlock(db, room.id, user.id);
    case 'public':
    default:
      return true;
  }
}

/**
 * Per-user access details for a visible room. `locked` means the room is
 * visible in the list, but the user still has to unlock it or be whitelisted.
 */
function getRoomAccess(db, room, user) {
  const allowed = canAccessRoom(db, room, user);
  const level = normalizeAccessLevel(room?.access_level);
  const privileged = isPrivileged(user);
  const member =
    room && user?.id && (level === 'private' || level === 'restricted')
      ? isRoomMember(db, room.id, user.id)
      : false;
  const unlocked =
    room && user?.id && level === 'closed'
      ? hasRoomUnlock(db, room.id, user.id)
      : false;

  return {
    allowed,
    locked: !allowed,
    accessLevel: level,
    passwordRequired: !allowed && !privileged && level === 'closed',
    memberOnly: !allowed && !privileged && level === 'restricted',
    member,
    unlocked,
  };
}

function validateRoomPassword(password) {
  if (typeof password !== 'string') {
    return { ok: false, error: 'Room password must be a string' };
  }
  if (password.length < ROOM_PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      error: `Room password must be at least ${ROOM_PASSWORD_MIN_LENGTH} characters`,
    };
  }
  if (password.length > ROOM_PASSWORD_MAX_LENGTH) {
    return {
      ok: false,
      error: `Room password cannot exceed ${ROOM_PASSWORD_MAX_LENGTH} characters`,
    };
  }
  return { ok: true };
}

function checkRoomPassword(password, passwordHash) {
  if (!passwordHash || typeof password !== 'string') return false;
  return verifyPassword(password, passwordHash);
}

function hashRoomPassword(password) {
  return hashPassword(password);
}

/**
 * Validates and normalizes a whitelist. Returns `{ ok, ids }` or
 * `{ ok: false, error, missingIds }`.
 */
function normalizeMemberIds(db, memberIds) {
  if (!Array.isArray(memberIds)) {
    return { ok: false, error: 'memberIds must be an array' };
  }

  const ids = [...new Set(memberIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length !== new Set(memberIds.map(Number)).size) {
    return { ok: false, error: 'memberIds contains invalid user ids' };
  }
  if (ids.length === 0) return { ok: true, ids: [] };

  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id FROM users WHERE id IN (${placeholders})`)
    .all(...ids);
  const found = new Set(rows.map((row) => Number(row.id)));
  const missingIds = ids.filter((id) => !found.has(id));
  if (missingIds.length > 0) {
    return { ok: false, error: 'Some users were not found', missingIds };
  }

  return { ok: true, ids };
}

function listRoomMembers(db, roomId) {
  return db
    .prepare(
      `SELECT u.id, u.login, u.role, u.verified, rm.created_at
       FROM room_members rm
       JOIN users u ON u.id = rm.user_id
       WHERE rm.room_id = ?
       ORDER BY u.login COLLATE NOCASE ASC`
    )
    .all(roomId);
}

function replaceRoomMembers(db, roomId, memberIds, addedBy) {
  const normalized = normalizeMemberIds(db, memberIds);
  if (!normalized.ok) return normalized;

  const replace = db.transaction((ids) => {
    db.prepare('DELETE FROM room_members WHERE room_id = ?').run(roomId);
    const insert = db.prepare(
      'INSERT INTO room_members (room_id, user_id, added_by) VALUES (?, ?, ?)'
    );
    for (const userId of ids) {
      insert.run(roomId, userId, addedBy ?? null);
    }
  });
  replace(normalized.ids);

  return { ok: true, ids: normalized.ids };
}

function clearRoomUnlocks(db, roomId) {
  db.prepare('DELETE FROM room_unlocks WHERE room_id = ?').run(roomId);
}

function getRoomUnlock(db, roomId, userId) {
  return db
    .prepare(
      `SELECT room_id, user_id, created_at, expires_at, ephemeral
       FROM room_unlocks WHERE room_id = ? AND user_id = ?`
    )
    .get(roomId, userId);
}

/**
 * Stores an unlock for the user. `rememberMinutes` 0 means "ask again on the
 * next visit": such unlock is marked ephemeral and revoked when the user
 * leaves the room. Positive values keep the room open for that many minutes.
 */
function grantRoomUnlock(db, roomId, userId, { rememberMinutes = 0 } = {}) {
  const requested = Number(rememberMinutes);
  const minutes =
    Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), ROOM_UNLOCK_MAX_MINUTES)
      : 0;
  const ephemeral = minutes === 0 ? 1 : 0;
  const lifetimeMinutes = ephemeral ? EPHEMERAL_UNLOCK_FALLBACK_MINUTES : minutes;

  db.prepare(
    `INSERT INTO room_unlocks (room_id, user_id, created_at, expires_at, ephemeral)
     VALUES (?, ?, datetime('now'), datetime('now', ?), ?)
     ON CONFLICT(room_id, user_id) DO UPDATE SET
       created_at = datetime('now'),
       expires_at = excluded.expires_at,
       ephemeral = excluded.ephemeral`
  ).run(roomId, userId, `+${lifetimeMinutes} minutes`, ephemeral);

  return getRoomUnlock(db, roomId, userId);
}

function revokeRoomUnlock(db, roomId, userId) {
  db.prepare('DELETE FROM room_unlocks WHERE room_id = ? AND user_id = ?').run(roomId, userId);
}

/** Removes the unlock only if it was issued for a single visit. */
function revokeEphemeralUnlock(db, roomId, userId) {
  db.prepare(
    'DELETE FROM room_unlocks WHERE room_id = ? AND user_id = ? AND ephemeral = 1'
  ).run(roomId, userId);
}

/** Adds access metadata (locked state, password requirement) to a room row. */
function decorateRoom(db, room, user) {
  if (!room) return room;
  const access = getRoomAccess(db, room, user);
  const { password_hash: passwordHash, ...rest } = room;
  return {
    ...rest,
    access_level: normalizeAccessLevel(room.access_level),
    has_password: Boolean(passwordHash),
    locked: access.locked,
    password_required: access.passwordRequired,
    member_only: access.memberOnly,
  };
}

module.exports = {
  ACCESS_LEVELS,
  DEFAULT_ACCESS_LEVEL,
  ROOM_PASSWORD_MIN_LENGTH,
  ROOM_PASSWORD_MAX_LENGTH,
  ROOM_UNLOCK_MAX_MINUTES,
  isValidAccessLevel,
  normalizeAccessLevel,
  isPrivileged,
  getRoom,
  isRoomMember,
  hasRoomUnlock,
  canViewRoom,
  canAccessRoom,
  getRoomAccess,
  validateRoomPassword,
  checkRoomPassword,
  hashRoomPassword,
  normalizeMemberIds,
  listRoomMembers,
  replaceRoomMembers,
  clearRoomUnlocks,
  getRoomUnlock,
  grantRoomUnlock,
  revokeRoomUnlock,
  revokeEphemeralUnlock,
  decorateRoom,
};
