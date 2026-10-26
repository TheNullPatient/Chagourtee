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

const workspace = createWorkspace('messages');
useWorkspace(workspace);

const Fastify = require('fastify');
const { getDb } = require('../src/db');
const messagesPlugin = require('../src/messages');

test('batch delete validates the room and removes media files', async () => {
  const { check, verify } = createChecker();
  const db = getDb();

  const owner = seedUser(db, unique('b_owner'), { role: 'owner' });
  const member = seedUser(db, unique('b_member'));
  const other = seedUser(db, unique('b_other'));

  function createRoom(name, ownerId) {
    return Number(
      db.prepare('INSERT INTO rooms (name, created_by) VALUES (?, ?)').run(name, ownerId)
        .lastInsertRowid
    );
  }

  function createMessage(roomId, userId) {
    return Number(
      db
        .prepare('INSERT INTO messages (room_id, user_id, body) VALUES (?, ?, ?)')
        .run(roomId, userId, 'x').lastInsertRowid
    );
  }

  function createMedia(messageId, userId) {
    const name = `${unique('batch_file')}.enc`;
    const filePath = path.join(workspace.mediaDir, name);
    fs.writeFileSync(filePath, 'test');
    db.prepare(
      `INSERT INTO media_files
         (message_id, original_name, encrypted_filename, mime_type, file_size, uploaded_by)
       VALUES (?, ?, ?, 'image/png', 4, ?)`
    ).run(messageId, name, name, userId);
    return filePath;
  }

  const roomA = createRoom(unique('b_room_a'), owner);
  const roomB = createRoom(unique('b_room_b'), owner);
  const messageA = createMessage(roomA, member);
  const messageB = createMessage(roomB, member);
  const fileA = createMedia(messageA, member);
  const fileB = createMedia(messageB, member);

  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.decorate('getUser', (id) =>
    db.prepare('SELECT id, login, role FROM users WHERE id = ?').get(id)
  );
  app.decorate('requireAuth', async (request, reply) => {
    const id = Number(request.headers['x-test-user']);
    const user = id ? app.getUser(id) : null;
    if (!user) return reply.code(401).send({ error: 'Unauthorized' });
    request.session = { userId: id };
    request.user = user;
  });
  app.decorate('broadcastRoom', () => {});

  messagesPlugin(app);

  async function batchDelete(userId, roomId, messageIds) {
    return app.inject({
      method: 'DELETE',
      url: `/api/rooms/${roomId}/messages/batch-delete`,
      headers: { 'x-test-user': String(userId), 'content-type': 'application/json' },
      payload: { messageIds },
    });
  }

  try {
    const crossRoom = await batchDelete(member, roomA, [messageA, messageB]);
    check('cross-room batch delete is rejected', crossRoom.statusCode === 404, crossRoom.body);
    check(
      'cross-room request deletes nothing',
      db
        .prepare('SELECT COUNT(*) c FROM messages WHERE id IN (?, ?)')
        .get(messageA, messageB).c === 2
    );
    check('cross-room request keeps the files', fs.existsSync(fileA) && fs.existsSync(fileB));

    const notOwned = await batchDelete(other, roomA, [messageA]);
    check("another user's message is not deletable", notOwned.statusCode === 403, notOwned.body);

    const missing = await batchDelete(member, roomA, [messageA, 99999999]);
    check('unknown message id is rejected', missing.statusCode === 404, missing.body);

    const ok = await batchDelete(member, roomA, [messageA, messageA]);
    check('own message batch delete succeeds', ok.statusCode === 200, ok.body);
    check(
      'own message is deleted',
      db.prepare('SELECT COUNT(*) c FROM messages WHERE id = ?').get(messageA).c === 0
    );
    check(
      'own message media row is deleted',
      db.prepare('SELECT COUNT(*) c FROM media_files WHERE message_id = ?').get(messageA).c === 0
    );
    check('own message media file is unlinked', !fs.existsSync(fileA));
    check(
      'message in another room is preserved',
      db.prepare('SELECT COUNT(*) c FROM messages WHERE id = ?').get(messageB).c === 1
    );
    check('media file in another room is preserved', fs.existsSync(fileB));
  } finally {
    await app.close();
    db.close();
    removeWorkspace(workspace);
  }

  verify();
});
