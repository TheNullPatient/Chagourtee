const fs = require('fs');
const path = require('path');

const MEDIA_DIR = path.resolve(path.join(__dirname, '../data/media'));

/**
 * Resolves a media filename to an absolute path, refusing anything that
 * escapes the media directory (defence in depth against corrupted DB rows).
 */
function resolveMediaPath(filename) {
  if (!filename || typeof filename !== 'string') return null;

  const resolved = path.resolve(MEDIA_DIR, filename);
  if (resolved !== MEDIA_DIR && !resolved.startsWith(`${MEDIA_DIR}${path.sep}`)) {
    return null;
  }

  return resolved;
}

function logError(logger, message, error) {
  if (logger && typeof logger.error === 'function') {
    logger.error(message, error);
  } else {
    console.error(message, error);
  }
}

/**
 * Deletes the given encrypted/transcoded files from disk.
 * Files that are already gone are ignored.
 */
function removeMediaFiles(files, logger) {
  if (!Array.isArray(files)) return;

  for (const file of files) {
    if (!file) continue;

    for (const field of ['encrypted_filename', 'transcoded_filename']) {
      const target = resolveMediaPath(file[field]);
      if (!target) continue;

      try {
        if (fs.existsSync(target)) {
          fs.unlinkSync(target);
        }
      } catch (error) {
        logError(logger, `Failed to delete media file ${target}:`, error);
      }
    }
  }
}

function collectMediaForMessages(db, messageIds) {
  const ids = [...new Set(messageIds.map(Number).filter(Number.isInteger))];
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT encrypted_filename, transcoded_filename
       FROM media_files
       WHERE message_id IN (${placeholders})`
    )
    .all(ids);
}

function collectMediaForRoom(db, roomId) {
  return db
    .prepare(
      `SELECT mf.encrypted_filename, mf.transcoded_filename
       FROM media_files mf
       JOIN messages m ON m.id = mf.message_id
       WHERE m.room_id = ?`
    )
    .all(roomId);
}

function collectMediaForUser(db, userId) {
  return db
    .prepare(
      `SELECT DISTINCT mf.encrypted_filename, mf.transcoded_filename
       FROM media_files mf
       LEFT JOIN messages m ON m.id = mf.message_id
       LEFT JOIN rooms r ON r.id = m.room_id
       WHERE mf.uploaded_by = ? OR m.user_id = ? OR r.created_by = ?`
    )
    .all(userId, userId, userId);
}

/**
 * Deletes a room together with its messages. Foreign keys remove the
 * dependent rows; media files are removed from disk afterwards.
 */
function deleteRoomData(db, roomId, logger) {
  const mediaFiles = collectMediaForRoom(db, roomId);

  const result = db.transaction(() => {
    return db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
  })();

  if (result.changes > 0) {
    removeMediaFiles(mediaFiles, logger);
  }

  return result;
}

/**
 * Deletes all messages in a room and their media files from disk.
 */
function clearRoomMessages(db, roomId, logger) {
  const mediaFiles = collectMediaForRoom(db, roomId);

  const result = db.transaction(() => {
    return db.prepare('DELETE FROM messages WHERE room_id = ?').run(roomId);
  })();

  if (result.changes > 0) {
    removeMediaFiles(mediaFiles, logger);
  }

  return result;
}

/**
 * Fully removes a user and every row that references them.
 * Must be kept in sync with the foreign keys in db.js: rooms.created_by,
 * messages.user_id, invites.created_by, verification_codes.created_by and
 * media_files.uploaded_by have no ON DELETE action.
 */
function deleteUserData(db, userId, logger) {
  const mediaFiles = collectMediaForUser(db, userId);

  db.transaction(() => {
    // messages.user_id has no cascade, delete authored messages first
    db.prepare('DELETE FROM messages WHERE user_id = ?').run(userId);
    // uploads that are not attached to a message (or attached to someone
    // else's message) would otherwise block the final DELETE
    db.prepare('DELETE FROM media_files WHERE uploaded_by = ?').run(userId);
    // cascades to messages, message_reads and media_files
    db.prepare('DELETE FROM rooms WHERE created_by = ?').run(userId);
    db.prepare('DELETE FROM invites WHERE created_by = ?').run(userId);
    db.prepare('DELETE FROM verification_codes WHERE created_by = ?').run(userId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  })();

  removeMediaFiles(mediaFiles, logger);
}

module.exports = {
  MEDIA_DIR,
  clearRoomMessages,
  collectMediaForMessages,
  collectMediaForRoom,
  collectMediaForUser,
  deleteRoomData,
  deleteUserData,
  removeMediaFiles,
  resolveMediaPath,
};
