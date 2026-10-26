'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createChecker,
  createWorkspace,
  removeWorkspace,
  seedUser,
  unique,
  useWorkspace,
} = require('./helpers');

const workspace = createWorkspace('data-cleanup');
useWorkspace(workspace);

const { createDb } = require('../src/db');
const {
  collectMediaForRoom,
  deleteRoomData,
  deleteUserData,
  resolveMediaPath,
} = require('../src/dataCleanup');

test('deleting rooms and users removes their media and dependent rows', () => {
  const { check, verify } = createChecker();
  const db = createDb(workspace.dbPath);
  const logger = { error: () => {} };

  function createRoom(name, ownerId) {
    return Number(
      db.prepare('INSERT INTO rooms (name, created_by) VALUES (?, ?)').run(name, ownerId)
        .lastInsertRowid
    );
  }

  function createMessage(roomId, userId, body) {
    return Number(
      db
        .prepare('INSERT INTO messages (room_id, user_id, body) VALUES (?, ?, ?)')
        .run(roomId, userId, body).lastInsertRowid
    );
  }

  function createMedia(messageId, userId, encryptedName) {
    const filePath = path.join(workspace.mediaDir, encryptedName);
    fs.writeFileSync(filePath, 'test');
    db.prepare(
      `INSERT INTO media_files
         (message_id, original_name, encrypted_filename, mime_type, file_size, uploaded_by)
       VALUES (?, ?, ?, 'image/png', 4, ?)`
    ).run(messageId, encryptedName, encryptedName, userId);
    return filePath;
  }

  try {
    check('foreign keys are enforced', db.pragma('foreign_keys', { simple: true }) === 1);
    check('media path traversal is refused', resolveMediaPath('../chagourtee.db') === null);
    check(
      'media paths stay inside the media directory',
      resolveMediaPath('ok.enc') === path.join(workspace.mediaDir, 'ok.enc')
    );

    // --- Room deletion -----------------------------------------------------
    const roomOwner = seedUser(db, unique('room_owner'));
    const roomId = createRoom(unique('room'), roomOwner);
    const messageId = createMessage(roomId, roomOwner, 'hello');
    const roomMediaName = `${unique('room_file')}.enc`;
    const roomMediaPath = createMedia(messageId, roomOwner, roomMediaName);
    db.prepare('INSERT INTO message_reads (message_id, user_id) VALUES (?, ?)').run(
      messageId,
      roomOwner
    );

    check(
      'collectMediaForRoom finds room media',
      collectMediaForRoom(db, roomId).length === 1
    );

    const deleted = deleteRoomData(db, roomId, logger);
    check('room row is deleted', deleted.changes === 1);
    check(
      'room messages cascade',
      db.prepare('SELECT COUNT(*) c FROM messages WHERE room_id = ?').get(roomId).c === 0
    );
    check(
      'room media rows cascade',
      db.prepare('SELECT COUNT(*) c FROM media_files WHERE message_id = ?').get(messageId).c === 0
    );
    check(
      'room message reads cascade',
      db.prepare('SELECT COUNT(*) c FROM message_reads WHERE message_id = ?').get(messageId).c === 0
    );
    check('room media file is unlinked', !fs.existsSync(roomMediaPath));

    // --- User deletion -----------------------------------------------------
    const user1 = seedUser(db, unique('user1'));
    const user2 = seedUser(db, unique('user2'));

    // user2 authored a message in user1's room.
    const user1Room = createRoom(unique('user1_room'), user1);
    const user2Message = createMessage(user1Room, user2, 'hi from user2');
    const user2MessageMediaName = `${unique('user2_msg_file')}.enc`;
    const user2MessageMediaPath = createMedia(user2Message, user2, user2MessageMediaName);

    // user2 owns a room containing a message by user1 but media uploaded by user2.
    const user2Room = createRoom(unique('user2_room'), user2);
    const user1Message = createMessage(user2Room, user1, 'hi from user1');
    const user2RoomMediaName = `${unique('user2_room_file')}.enc`;
    const user2RoomMediaPath = createMedia(user1Message, user2, user2RoomMediaName);

    // Upload without a message (orphan).
    const orphanName = `${unique('orphan')}.enc`;
    const orphanPath = path.join(workspace.mediaDir, orphanName);
    fs.writeFileSync(orphanPath, 'test');
    db.prepare(
      `INSERT INTO media_files
         (message_id, original_name, encrypted_filename, mime_type, file_size, uploaded_by)
       VALUES (NULL, ?, ?, 'image/png', 4, ?)`
    ).run(orphanName, orphanName, user2);

    db.prepare('INSERT INTO invites (id, created_by) VALUES (?, ?)').run(
      unique('invite'),
      user2
    );
    db.prepare(
      "INSERT INTO verification_codes (code_hash, created_by, expires_at) VALUES ('h', ?, datetime('now', '+1 day'))"
    ).run(user2);
    db.prepare(
      "INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))"
    ).run(unique('session'), user2);

    deleteUserData(db, user2, logger);

    check(
      'user row is deleted',
      db.prepare('SELECT COUNT(*) c FROM users WHERE id = ?').get(user2).c === 0
    );
    check(
      "deleted user's message in another room is removed",
      db.prepare('SELECT COUNT(*) c FROM messages WHERE id = ?').get(user2Message).c === 0
    );
    check(
      "deleted user's room is removed",
      db.prepare('SELECT COUNT(*) c FROM rooms WHERE id = ?').get(user2Room).c === 0
    );
    check(
      'messages inside the deleted room cascade',
      db.prepare('SELECT COUNT(*) c FROM messages WHERE id = ?').get(user1Message).c === 0
    );
    check(
      'invites created by the user are removed',
      db.prepare('SELECT COUNT(*) c FROM invites WHERE created_by = ?').get(user2).c === 0
    );
    check(
      'verification codes created by the user are removed',
      db
        .prepare('SELECT COUNT(*) c FROM verification_codes WHERE created_by = ?')
        .get(user2).c === 0
    );
    check(
      'sessions of the user are removed',
      db.prepare('SELECT COUNT(*) c FROM sessions WHERE user_id = ?').get(user2).c === 0
    );
    check(
      "another user's room is preserved",
      db.prepare('SELECT COUNT(*) c FROM rooms WHERE id = ?').get(user1Room).c === 1
    );
    check(
      'another user account is preserved',
      db.prepare('SELECT COUNT(*) c FROM users WHERE id = ?').get(user1).c === 1
    );
    check('message media file is unlinked', !fs.existsSync(user2MessageMediaPath));
    check('room media file is unlinked', !fs.existsSync(user2RoomMediaPath));
    check('orphan upload is unlinked', !fs.existsSync(orphanPath));

    check(
      'no foreign key violations remain',
      db.prepare('PRAGMA foreign_key_check').all().length === 0
    );
  } finally {
    db.close();
    removeWorkspace(workspace);
  }

  verify();
});
