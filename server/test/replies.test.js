'use strict';

const test = require('node:test');

const {
  createChecker,
  createWorkspace,
  removeWorkspace,
  seedUser,
  unique,
  useWorkspace,
} = require('./helpers');

const workspace = createWorkspace('replies');
useWorkspace(workspace);

const Fastify = require('fastify');
const { getDb } = require('../src/db');
const messagesPlugin = require('../src/messages');

test('message replies are persisted, quoted and survive deletion', async () => {
  const { check, verify } = createChecker();
  const db = getDb();

  const owner = seedUser(db, unique('r_owner'), { role: 'owner' });
  const member = seedUser(db, unique('r_member'));
  const other = seedUser(db, unique('r_other'));

  function createRoom(name, ownerId) {
    return Number(
      db.prepare('INSERT INTO rooms (name, created_by) VALUES (?, ?)').run(name, ownerId)
        .lastInsertRowid
    );
  }

  const roomA = createRoom(unique('r_room_a'), owner);
  const roomB = createRoom(unique('r_room_b'), owner);

  const roomBroadcasts = [];
  const allBroadcasts = [];

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
  app.decorate('broadcastRoom', (_roomId, payload) => roomBroadcasts.push(payload));
  app.decorate('broadcastRoomNotification', (_roomId, payload) => allBroadcasts.push(payload));
  app.decorate('broadcastAll', (payload) => allBroadcasts.push(payload));

  messagesPlugin(app);

  async function request(method, url, userId, payload) {
    return app.inject({
      method,
      url,
      headers: { 'x-test-user': String(userId), 'content-type': 'application/json' },
      payload,
    });
  }

  try {
    const original = await request('POST', `/api/rooms/${roomA}/messages`, member, {
      body: 'Original text',
    });
    check('original message is created', original.statusCode === 200, original.body);
    const originalJson = original.json();
    check('message without a reply has replyTo null', originalJson.replyTo === null, original.body);

    const reply = await request('POST', `/api/rooms/${roomA}/messages`, other, {
      body: 'This is a reply',
      replyToMessageId: originalJson.id,
    });
    check('reply is created', reply.statusCode === 200, reply.body);
    const replyJson = reply.json();
    check(
      'reply carries the quoted message',
      replyJson.replyTo &&
        replyJson.replyTo.id === originalJson.id &&
        replyJson.replyTo.userId === member &&
        replyJson.replyTo.login === originalJson.login &&
        replyJson.replyTo.body === 'Original text' &&
        replyJson.replyTo.deleted === false,
      reply.body
    );
    check(
      'new message broadcast includes the reply target user',
      roomBroadcasts.some(
        (event) =>
          event.type === 'message' &&
          event.message.id === replyJson.id &&
          event.message.replyTo?.userId === member
      )
    );
    check(
      'room notification includes the reply target user',
      allBroadcasts.some(
        (event) =>
          event.type === 'room_message' &&
          event.messageId === replyJson.id &&
          event.replyToUserId === member
      )
    );

    const list = await request('GET', `/api/rooms/${roomA}/messages`, member);
    check('message list is returned', list.statusCode === 200, list.body);
    const listReply = list.json().messages.find((message) => message.id === replyJson.id);
    check(
      'reply survives a reload with full quote data',
      listReply?.replyTo?.id === originalJson.id &&
        listReply?.replyTo?.body === 'Original text' &&
        !('reply_to_message_id' in listReply),
      list.body
    );

    const foreignTarget = await request(
      'POST',
      `/api/rooms/${roomB}/messages`,
      other,
      { body: 'Elsewhere' }
    );
    const foreignId = foreignTarget.json().id;
    const crossRoom = await request('POST', `/api/rooms/${roomA}/messages`, other, {
      body: 'Wrong room',
      replyToMessageId: foreignId,
    });
    check('replying across rooms is rejected', crossRoom.statusCode === 400, crossRoom.body);

    const missingTarget = await request('POST', `/api/rooms/${roomA}/messages`, other, {
      body: 'Missing',
      replyToMessageId: 99999999,
    });
    check('replying to a missing message is rejected', missingTarget.statusCode === 400, missingTarget.body);

    const invalidTarget = await request('POST', `/api/rooms/${roomA}/messages`, other, {
      body: 'Invalid',
      replyToMessageId: 'abc',
    });
    check('non-numeric reply ids are rejected', invalidTarget.statusCode === 400, invalidTarget.body);

    const edited = await request(
      'PATCH',
      `/api/rooms/${roomA}/messages/${originalJson.id}`,
      member,
      { body: 'Edited original' }
    );
    check('original message can be edited', edited.statusCode === 200, edited.body);

    const afterEdit = await request('GET', `/api/rooms/${roomA}/messages`, member);
    const editedQuote = afterEdit
      .json()
      .messages.find((message) => message.id === replyJson.id);
    check(
      'quotes show the current text of the original',
      editedQuote?.replyTo?.body === 'Edited original',
      afterEdit.body
    );

    const deleted = await request(
      'DELETE',
      `/api/rooms/${roomA}/messages/${originalJson.id}`,
      member
    );
    check('original message can be deleted', deleted.statusCode === 200, deleted.body);

    const storedReply = db
      .prepare('SELECT reply_to_message_id, reply_to_body FROM messages WHERE id = ?')
      .get(replyJson.id);
    check(
      'deleting the original clears the live reference',
      storedReply.reply_to_message_id === null,
      JSON.stringify(storedReply)
    );
    check(
      'deleting the original keeps a readable snapshot',
      storedReply.reply_to_body === 'Edited original',
      JSON.stringify(storedReply)
    );

    const afterDelete = await request('GET', `/api/rooms/${roomA}/messages`, member);
    const deletedQuote = afterDelete
      .json()
      .messages.find((message) => message.id === replyJson.id);
    check(
      'a reply to a deleted message is marked as deleted',
      deletedQuote?.replyTo?.deleted === true &&
        deletedQuote?.replyTo?.id === null &&
        deletedQuote?.replyTo?.body === 'Edited original',
      afterDelete.body
    );
  } finally {
    await app.close();
    db.close();
    removeWorkspace(workspace);
  }

  verify();
});
