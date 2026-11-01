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

const workspace = createWorkspace('reactions');
useWorkspace(workspace);

const Fastify = require('fastify');
const { getDb } = require('../src/db');
const messagesPlugin = require('../src/messages');
const roomsPlugin = require('../src/rooms');
const { DEFAULT_REACTION_EMOJIS, serializeReactionEmojis } = require('../src/reactions');
const { hasPermission } = require('../src/permissions');

test('message reactions are grouped, toggled and scoped to a room palette', async () => {
  const { check, verify } = createChecker();
  const db = getDb();

  const owner = seedUser(db, unique('rx_owner'), { role: 'owner' });
  const member = seedUser(db, unique('rx_member'));
  const second = seedUser(db, unique('rx_second'));
  const outsider = seedUser(db, unique('rx_outsider'));

  function createRoom(name, ownerId, { accessLevel = 'public', emojis = null } = {}) {
    const palette = emojis ? serializeReactionEmojis(emojis) : null;
    if (palette) {
      return Number(
        db
          .prepare(
            'INSERT INTO rooms (name, created_by, access_level, reaction_emojis) VALUES (?, ?, ?, ?)'
          )
          .run(name, ownerId, accessLevel, palette).lastInsertRowid
      );
    }
    return Number(
      db
        .prepare('INSERT INTO rooms (name, created_by, access_level) VALUES (?, ?, ?)')
        .run(name, ownerId, accessLevel).lastInsertRowid
    );
  }

  const roomA = createRoom(unique('rx_room_a'), owner);
  const roomB = createRoom(unique('rx_room_b'), owner);
  const privateRoom = createRoom(unique('rx_room_private'), owner, {
    accessLevel: 'private',
  });

  const roomBroadcasts = [];

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
  app.decorate('broadcastRoom', (roomId, payload) =>
    roomBroadcasts.push({ roomId, payload })
  );
  app.decorate('broadcastRoomNotification', () => {});
  app.decorate('broadcastAll', () => {});
  app.decorate('requirePermission', (permission) => async (request, reply) => {
    const id = Number(request.headers['x-test-user']);
    const user = id ? app.getUser(id) : null;
    if (!user) return reply.code(401).send({ error: 'Unauthorized' });
    if (!hasPermission(db, user, permission)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    request.session = { userId: id };
    request.user = user;
  });
  app.decorate('requireOwner', async (request, reply) => {
    const user = app.getUser(request.session?.userId);
    if (!user) return reply.code(401).send({ error: 'Unauthorized' });
    if (user.role !== 'owner') return reply.code(403).send({ error: 'Forbidden' });
    request.user = user;
  });
  app.decorate('requireOwnerOrModerator', async (request, reply) => {
    const user = app.getUser(request.session?.userId);
    if (!user) return reply.code(401).send({ error: 'Unauthorized' });
    if (user.role !== 'owner' && user.role !== 'moderator') {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    request.user = user;
  });

  messagesPlugin(app);
  roomsPlugin(app);

  async function request(method, url, userId, payload) {
    return app.inject({
      method,
      url,
      headers: { 'x-test-user': String(userId), 'content-type': 'application/json' },
      payload,
    });
  }

  function react(roomId, messageId, userId, emoji) {
    return request(
      'POST',
      `/api/rooms/${roomId}/messages/${messageId}/reactions`,
      userId,
      { emoji }
    );
  }

  try {
    const created = await request('POST', `/api/rooms/${roomA}/messages`, member, {
      body: 'React to me',
    });
    check('message is created', created.statusCode === 200, created.body);
    const messageId = created.json().id;
    check(
      'new message starts with an empty reactions array',
      Array.isArray(created.json().reactions) && created.json().reactions.length === 0,
      created.body
    );

    const first = await react(roomA, messageId, member, DEFAULT_REACTION_EMOJIS[0]);
    check('a reaction can be added', first.statusCode === 200, first.body);
    const firstJson = first.json();
    check('adding a reaction reports added=true', firstJson.added === true, first.body);
    check(
      'the reaction is grouped with a count and user list',
      firstJson.reactions.length === 1 &&
        firstJson.reactions[0].emoji === DEFAULT_REACTION_EMOJIS[0] &&
        firstJson.reactions[0].count === 1 &&
        firstJson.reactions[0].users.length === 1 &&
        firstJson.reactions[0].users[0].id === member,
      first.body
    );

    const broadcast = roomBroadcasts.find(
      (event) => event.payload.type === 'reaction_updated'
    );
    check(
      'reaction updates are broadcast to the room',
      broadcast &&
        broadcast.roomId === roomA &&
        broadcast.payload.messageId === messageId &&
        broadcast.payload.userId === member &&
        broadcast.payload.added === true &&
        broadcast.payload.reactions.length === 1,
      JSON.stringify(broadcast)
    );

    const secondUser = await react(roomA, messageId, second, DEFAULT_REACTION_EMOJIS[0]);
    check('another user can add the same emoji', secondUser.statusCode === 200, secondUser.body);
    const grouped = secondUser.json().reactions.find(
      (group) => group.emoji === DEFAULT_REACTION_EMOJIS[0]
    );
    check(
      'identical reactions are grouped into one entry',
      secondUser.json().reactions.length === 1 &&
        grouped.count === 2 &&
        grouped.users.map((user) => user.id).sort().join(',') ===
          [member, second].sort().join(','),
      secondUser.body
    );

    const otherEmoji = await react(roomA, messageId, second, DEFAULT_REACTION_EMOJIS[1]);
    check('a different emoji starts a new group', otherEmoji.statusCode === 200, otherEmoji.body);
    check(
      'groups keep one entry per emoji',
      otherEmoji.json().reactions.length === 2,
      otherEmoji.body
    );

    const removed = await react(roomA, messageId, member, DEFAULT_REACTION_EMOJIS[0]);
    check('posting the same emoji removes it', removed.statusCode === 200, removed.body);
    const removedJson = removed.json();
    check('removing a reaction reports added=false', removedJson.added === false, removed.body);
    const remainingGroup = removedJson.reactions.find(
      (group) => group.emoji === DEFAULT_REACTION_EMOJIS[0]
    );
    check(
      'the group keeps the other user after a removal',
      remainingGroup && remainingGroup.count === 1 && remainingGroup.users[0].id === second,
      removed.body
    );

    const list = await request('GET', `/api/rooms/${roomA}/messages`, member);
    const listed = list.json().messages.find((message) => message.id === messageId);
    check(
      'message history carries the grouped reactions',
      listed &&
        listed.reactions.length === 2 &&
        listed.reactions.some((group) => group.emoji === DEFAULT_REACTION_EMOJIS[1]),
      list.body
    );

    const notInPalette = await react(roomA, messageId, member, '🧋');
    check(
      'emojis outside the room palette are rejected',
      notInPalette.statusCode === 400 && /not available/i.test(notInPalette.json().error),
      notInPalette.body
    );

    const invalid = await react(roomA, messageId, member, 'not an emoji');
    check('whitespace inside an emoji is rejected', invalid.statusCode === 400, invalid.body);

    const missingEmoji = await request(
      'POST',
      `/api/rooms/${roomA}/messages/${messageId}/reactions`,
      member,
      {}
    );
    check('a missing emoji is rejected', missingEmoji.statusCode === 400, missingEmoji.body);

    const foreignMessage = await request('POST', `/api/rooms/${roomB}/messages`, member, {
      body: 'Elsewhere',
    });
    const foreignId = foreignMessage.json().id;
    const crossRoom = await react(roomA, foreignId, member, DEFAULT_REACTION_EMOJIS[0]);
    check('reacting to a message in another room is rejected', crossRoom.statusCode === 400, crossRoom.body);

    const missingMessage = await react(roomA, 99999999, member, DEFAULT_REACTION_EMOJIS[0]);
    check('reacting to a missing message returns 404', missingMessage.statusCode === 404, missingMessage.body);

    const privateDenied = await request(
      'POST',
      `/api/rooms/${privateRoom}/messages`,
      owner,
      { body: 'Secret' }
    );
    const privateMessageId = privateDenied.json().id;
    const outsiderReact = await react(
      privateRoom,
      privateMessageId,
      outsider,
      DEFAULT_REACTION_EMOJIS[0]
    );
    check(
      'outsiders cannot react in a private room',
      outsiderReact.statusCode === 404,
      outsiderReact.body
    );

    // A custom palette restricts new reactions, but users can still clear
    // reactions that were added before the palette changed.
    const oldReaction = await react(roomA, messageId, member, DEFAULT_REACTION_EMOJIS[2]);
    check('a palette emoji can be added before the palette changes', oldReaction.statusCode === 200, oldReaction.body);

    const emptyPalette = await request('PATCH', `/api/rooms/${roomA}`, owner, {
      reactionEmojis: [],
    });
    check('an empty palette is rejected', emptyPalette.statusCode === 400, emptyPalette.body);

    const tooMany = await request('PATCH', `/api/rooms/${roomA}`, owner, {
      reactionEmojis: Array.from({ length: 25 }, (_, index) => `!${index}`),
    });
    check('a palette above the limit is rejected', tooMany.statusCode === 400, tooMany.body);

    const invalidPalette = await request('PATCH', `/api/rooms/${roomA}`, owner, {
      reactionEmojis: ['not an emoji'],
    });
    check(
      'a palette with whitespace inside an emoji is rejected',
      invalidPalette.statusCode === 400,
      invalidPalette.body
    );

    const paletteUpdate = await request('PATCH', `/api/rooms/${roomA}`, owner, {
      reactionEmojis: ['✅'],
    });
    check('the owner can change the room palette', paletteUpdate.statusCode === 200, paletteUpdate.body);
    check(
      'the updated room exposes the parsed palette',
      Array.isArray(paletteUpdate.json().reaction_emojis) &&
        paletteUpdate.json().reaction_emojis.length === 1 &&
        paletteUpdate.json().reaction_emojis[0] === '✅',
      paletteUpdate.body
    );

    const cleared = await react(roomA, messageId, member, DEFAULT_REACTION_EMOJIS[2]);
    check(
      'an old reaction can still be removed after the palette shrinks',
      cleared.statusCode === 200 && cleared.json().added === false,
      cleared.body
    );

    const custom = await react(roomA, messageId, member, '✅');
    check('the new palette emoji is accepted', custom.statusCode === 200, custom.body);

    const removedFromPalette = await react(roomA, messageId, member, DEFAULT_REACTION_EMOJIS[1]);
    check(
      'a removed palette emoji cannot be added again',
      removedFromPalette.statusCode === 400,
      removedFromPalette.body
    );

    const beforeDelete = db
      .prepare('SELECT COUNT(*) AS count FROM message_reactions WHERE message_id = ?')
      .get(messageId).count;
    check('reactions exist before the message is deleted', beforeDelete > 0);

    const deletion = await request(
      'DELETE',
      `/api/rooms/${roomA}/messages/${messageId}`,
      member
    );
    check('the message can be deleted', deletion.statusCode === 200, deletion.body);
    const afterDelete = db
      .prepare('SELECT COUNT(*) AS count FROM message_reactions WHERE message_id = ?')
      .get(messageId).count;
    check('deleting a message cascades to its reactions', afterDelete === 0, String(afterDelete));
  } finally {
    await app.close();
    db.close();
    removeWorkspace(workspace);
  }

  verify();
});
