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

const workspace = createWorkspace('room-access');
useWorkspace(workspace);

const Fastify = require('fastify');
const { getDb } = require('../src/db');
const roomsPlugin = require('../src/rooms');
const messagesPlugin = require('../src/messages');

test('room access levels control visibility, joining and messages', async () => {
  const { check, verify } = createChecker();
  const db = getDb();

  const owner = seedUser(db, unique('ra_owner'), { role: 'owner' });
  const moderator = seedUser(db, unique('ra_mod'), { role: 'moderator' });
  const member = seedUser(db, unique('ra_member'));
  const outsider = seedUser(db, unique('ra_outsider'));

  let roomCounter = 0;
  const roomName = (prefix) => `${prefix}_${Date.now().toString(36)}_${roomCounter++}`;

  const roomEvents = [];
  const globalEvents = [];

  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.decorate('getUser', (id) =>
    db.prepare('SELECT id, login, role, verified FROM users WHERE id = ?').get(id)
  );
  app.decorate('requireAuth', async (request, reply) => {
    const id = Number(request.headers['x-test-user']);
    const user = id ? app.getUser(id) : null;
    if (!user) return reply.code(401).send({ error: 'Unauthorized' });
    request.session = { userId: id };
    request.user = user;
  });
  app.decorate('requireOwner', async (request, reply) => {
    if (request.user?.role !== 'owner') {
      return reply.code(403).send({ error: 'Owner only' });
    }
  });
  app.decorate('requireOwnerOrModerator', async (request, reply) => {
    if (request.user?.role !== 'owner' && request.user?.role !== 'moderator') {
      return reply.code(403).send({ error: 'Owner or moderator only' });
    }
  });
  app.decorate('broadcastRoom', (_roomId, payload) => roomEvents.push(payload));
  app.decorate('broadcastRoomNotification', (_roomId, payload) => globalEvents.push(payload));
  app.decorate('broadcastRoomCreated', (room) => globalEvents.push({ type: 'room_created', room }));
  app.decorate('broadcastRoomUpdated', (room) => globalEvents.push({ type: 'room_updated', room }));
  app.decorate('broadcastRoomsChanged', () => globalEvents.push({ type: 'rooms_changed' }));
  app.decorate('broadcastAll', (payload) => globalEvents.push(payload));

  roomsPlugin(app);
  messagesPlugin(app);

  async function request(method, url, userId, payload) {
    return app.inject({
      method,
      url,
      headers: { 'x-test-user': String(userId), 'content-type': 'application/json' },
      payload,
    });
  }

  async function createRoom(payload) {
    const response = await request('POST', '/api/rooms', owner, payload);
    check(`room ${payload.name} is created`, response.statusCode === 200, response.body);
    return response.json();
  }

  try {
    const publicRoom = await createRoom({
      name: roomName('public_room'),
      accessLevel: 'public',
    });
    const closedRoom = await createRoom({
      name: roomName('closed_room'),
      accessLevel: 'closed',
      password: 'secret-pass',
    });
    const restrictedRoom = await createRoom({
      name: roomName('restricted_room'),
      accessLevel: 'restricted',
      memberIds: [member],
    });
    const privateRoom = await createRoom({
      name: roomName('private_room'),
      accessLevel: 'private',
      memberIds: [member],
    });

    check(
      'closed room response exposes access level but never the password hash',
      closedRoom.access_level === 'closed' &&
        closedRoom.has_password === true &&
        !('password_hash' in closedRoom),
      JSON.stringify(closedRoom)
    );

    const publicList = await request('GET', '/api/rooms', outsider);
    check('room list request succeeds', publicList.statusCode === 200, publicList.body);
    const outsiderRooms = publicList.json().rooms;
    const outsiderRoom = (id) => outsiderRooms.find((room) => room.id === id);

    check(
      'public room is listed and unlocked',
      outsiderRoom(publicRoom.id)?.locked === false,
      publicList.body
    );
    check(
      'closed room is listed as locked and password protected',
      outsiderRoom(closedRoom.id)?.locked === true &&
        outsiderRoom(closedRoom.id)?.password_required === true,
      publicList.body
    );
    check(
      'restricted room is listed but member-only',
      outsiderRoom(restrictedRoom.id)?.locked === true &&
        outsiderRoom(restrictedRoom.id)?.member_only === true,
      publicList.body
    );
    check(
      'private room is hidden from outsiders',
      !outsiderRoom(privateRoom.id),
      publicList.body
    );

    const memberList = await request('GET', '/api/rooms', member);
    const memberRooms = memberList.json().rooms;
    check(
      'whitelisted member sees private and restricted rooms unlocked',
      memberRooms.find((room) => room.id === privateRoom.id)?.locked === false &&
        memberRooms.find((room) => room.id === restrictedRoom.id)?.locked === false,
      memberList.body
    );

    const ownerList = await request('GET', '/api/rooms', owner);
    check(
      'owner sees every room',
      [publicRoom, closedRoom, restrictedRoom, privateRoom].every((room) =>
        ownerList.json().rooms.some((listed) => listed.id === room.id)
      ),
      ownerList.body
    );

    const moderatorList = await request('GET', '/api/rooms', moderator);
    check(
      'moderator bypasses private room visibility',
      moderatorList.json().rooms.some((room) => room.id === privateRoom.id),
      moderatorList.body
    );

    // Message reads follow the same rules.
    const publicMessages = await request(
      'GET',
      `/api/rooms/${publicRoom.id}/messages`,
      outsider
    );
    check('anyone can read a public room', publicMessages.statusCode === 200, publicMessages.body);

    const closedMessages = await request(
      'GET',
      `/api/rooms/${closedRoom.id}/messages`,
      outsider
    );
    check(
      'a closed room rejects reads before unlocking',
      closedMessages.statusCode === 403 &&
        closedMessages.json().code === 'ROOM_LOCKED',
      closedMessages.body
    );

    const restrictedMessages = await request(
      'GET',
      `/api/rooms/${restrictedRoom.id}/messages`,
      outsider
    );
    check(
      'a restricted room rejects non-members',
      restrictedMessages.statusCode === 403 &&
        restrictedMessages.json().code === 'ROOM_FORBIDDEN',
      restrictedMessages.body
    );

    const privateMessages = await request(
      'GET',
      `/api/rooms/${privateRoom.id}/messages`,
      outsider
    );
    check(
      'a private room answers 404 to outsiders instead of revealing it',
      privateMessages.statusCode === 404,
      privateMessages.body
    );

    const memberPrivateMessages = await request(
      'GET',
      `/api/rooms/${privateRoom.id}/messages`,
      member
    );
    check(
      'a whitelisted member can read a private room',
      memberPrivateMessages.statusCode === 200,
      memberPrivateMessages.body
    );

    const modClosedMessages = await request(
      'GET',
      `/api/rooms/${closedRoom.id}/messages`,
      moderator
    );
    check(
      'moderator bypasses closed room passwords',
      modClosedMessages.statusCode === 200,
      modClosedMessages.body
    );

    const lockedSend = await request('POST', `/api/rooms/${closedRoom.id}/messages`, outsider, {
      body: 'Should not pass',
    });
    check(
      'locked closed room rejects message sending',
      lockedSend.statusCode === 403,
      lockedSend.body
    );

    const wrongPassword = await request(
      'POST',
      `/api/rooms/${closedRoom.id}/unlock`,
      outsider,
      { password: 'wrong-pass' }
    );
    check('wrong room password is rejected', wrongPassword.statusCode === 401, wrongPassword.body);

    const unlock = await request(
      'POST',
      `/api/rooms/${closedRoom.id}/unlock`,
      outsider,
      { password: 'secret-pass' }
    );
    check('correct room password unlocks the room', unlock.statusCode === 200, unlock.body);
    check(
      'by default the password is not remembered between visits',
      unlock.json().ephemeral === true &&
        unlock.json().rememberMinutes === 0 &&
        typeof unlock.json().expiresAt === 'string',
      unlock.body
    );

    const afterUnlockList = await request('GET', '/api/rooms', outsider);
    check(
      'unlocked closed room no longer shows as locked',
      afterUnlockList
        .json()
        .rooms.find((room) => room.id === closedRoom.id)?.locked === false,
      afterUnlockList.body
    );

    const unlockedRead = await request(
      'GET',
      `/api/rooms/${closedRoom.id}/messages`,
      outsider
    );
    check('unlocked user can read the closed room', unlockedRead.statusCode === 200, unlockedRead.body);

    const unlockedSend = await request(
      'POST',
      `/api/rooms/${closedRoom.id}/messages`,
      outsider,
      { body: 'Unlocked hello' }
    );
    check('unlocked user can send messages', unlockedSend.statusCode === 200, unlockedSend.body);

    // Remembering the password for a limited time.
    const remembered = await request(
      'POST',
      `/api/rooms/${closedRoom.id}/unlock`,
      outsider,
      { password: 'secret-pass', rememberMinutes: 30 }
    );
    check('unlock accepts a remember duration', remembered.statusCode === 200, remembered.body);
    check(
      'a remembered unlock is persistent and has an expiry',
      remembered.json().ephemeral === false &&
        remembered.json().rememberMinutes === 30 &&
        typeof remembered.json().expiresAt === 'string',
      remembered.body
    );

    const rememberedRow = db
      .prepare(
        'SELECT ephemeral, expires_at FROM room_unlocks WHERE room_id = ? AND user_id = ?'
      )
      .get(closedRoom.id, outsider);
    check(
      'remembered unlock is stored as persistent',
      rememberedRow?.ephemeral === 0 && Boolean(rememberedRow?.expires_at),
      JSON.stringify(rememberedRow)
    );

    // "Never" keeps the room open until the user (or an admin) locks it.
    const neverUnlock = await request(
      'POST',
      `/api/rooms/${closedRoom.id}/unlock`,
      outsider,
      { password: 'secret-pass', rememberMinutes: null }
    );
    check(
      'unlock accepts the "never" option',
      neverUnlock.statusCode === 200 &&
        neverUnlock.json().rememberMinutes === null &&
        neverUnlock.json().expiresAt === null &&
        neverUnlock.json().ephemeral === false,
      neverUnlock.body
    );
    const neverRow = db
      .prepare(
        'SELECT expires_at, ephemeral FROM room_unlocks WHERE room_id = ? AND user_id = ?'
      )
      .get(closedRoom.id, outsider);
    check(
      'the "never" option is stored without an expiry',
      neverRow?.expires_at === null && neverRow?.ephemeral === 0,
      JSON.stringify(neverRow)
    );

    const tooLong = await request(
      'POST',
      `/api/rooms/${closedRoom.id}/unlock`,
      outsider,
      { password: 'secret-pass', rememberMinutes: 10081 }
    );
    check(
      'remember duration cannot exceed seven days',
      tooLong.statusCode === 400,
      tooLong.body
    );

    const wrongType = await request(
      'POST',
      `/api/rooms/${closedRoom.id}/unlock`,
      outsider,
      { password: 'secret-pass', rememberMinutes: '30' }
    );
    check(
      'remember duration must be a number',
      wrongType.statusCode === 400,
      wrongType.body
    );

    // Expired unlocks must lock the room again.
    db.prepare(
      `UPDATE room_unlocks SET expires_at = datetime('now', '-1 minute')
       WHERE room_id = ? AND user_id = ?`
    ).run(closedRoom.id, outsider);
    const expiredRead = await request(
      'GET',
      `/api/rooms/${closedRoom.id}/messages`,
      outsider
    );
    check(
      'an expired unlock locks the room again',
      expiredRead.statusCode === 403 && expiredRead.json().code === 'ROOM_LOCKED',
      expiredRead.body
    );

    // The client can drop an unlock explicitly when it leaves a room.
    const unlockAgain = await request(
      'POST',
      `/api/rooms/${closedRoom.id}/unlock`,
      outsider,
      { password: 'secret-pass' }
    );
    check('room can be unlocked again after expiry', unlockAgain.statusCode === 200, unlockAgain.body);

    const manualLock = await request(
      'DELETE',
      `/api/rooms/${closedRoom.id}/unlock`,
      outsider
    );
    check('user can drop the unlock manually', manualLock.statusCode === 200, manualLock.body);

    const afterManualLockRead = await request(
      'GET',
      `/api/rooms/${closedRoom.id}/messages`,
      outsider
    );
    check(
      'a manual lock revokes access immediately',
      afterManualLockRead.statusCode === 403,
      afterManualLockRead.body
    );

    // Restore the unlock so the admin lock-all checks below have a target.
    await request('POST', `/api/rooms/${closedRoom.id}/unlock`, outsider, {
      password: 'secret-pass',
      rememberMinutes: 120,
    });

    const lockAll = await request('POST', `/api/rooms/${closedRoom.id}/lock`, owner, {});
    check('owner can lock the room for everyone', lockAll.statusCode === 200, lockAll.body);
    check(
      'lock-all reports how many users were locked out',
      lockAll.json().lockedUsers >= 1,
      lockAll.body
    );

    const afterLockAllRead = await request(
      'GET',
      `/api/rooms/${closedRoom.id}/messages`,
      outsider
    );
    check(
      'lock-all drops remembered passwords for everyone',
      afterLockAllRead.statusCode === 403,
      afterLockAllRead.body
    );

    const memberLockAll = await request(
      'POST',
      `/api/rooms/${closedRoom.id}/lock`,
      member,
      {}
    );
    check(
      'regular members cannot lock the room for everyone',
      memberLockAll.statusCode === 403,
      memberLockAll.body
    );

    // Restore the unlock so the password-change checks below stay meaningful.
    await request('POST', `/api/rooms/${closedRoom.id}/unlock`, outsider, {
      password: 'secret-pass',
    });

    const unlockPublic = await request(
      'POST',
      `/api/rooms/${publicRoom.id}/unlock`,
      outsider,
      { password: 'anything' }
    );
    check('public rooms cannot be unlocked', unlockPublic.statusCode === 400, unlockPublic.body);

    const unlockAsOwner = await request(
      'POST',
      `/api/rooms/${closedRoom.id}/unlock`,
      owner,
      { password: 'not-needed' }
    );
    check(
      'owner bypasses room passwords on unlock',
      unlockAsOwner.statusCode === 200,
      unlockAsOwner.body
    );

    // Changing the password must clear existing unlocks.
    const passwordChange = await request('PATCH', `/api/rooms/${closedRoom.id}`, owner, {
      password: 'new-secret-pass',
    });
    check('owner can change the room password', passwordChange.statusCode === 200, passwordChange.body);

    const unlockCount = db
      .prepare('SELECT COUNT(*) AS count FROM room_unlocks WHERE room_id = ?')
      .get(closedRoom.id).count;
    check('password changes revoke existing unlocks', unlockCount === 0, String(unlockCount));

    const readAfterPasswordChange = await request(
      'GET',
      `/api/rooms/${closedRoom.id}/messages`,
      outsider
    );
    check(
      'user has to unlock again after a password change',
      readAfterPasswordChange.statusCode === 403,
      readAfterPasswordChange.body
    );

    const oldPassword = await request(
      'POST',
      `/api/rooms/${closedRoom.id}/unlock`,
      outsider,
      { password: 'secret-pass' }
    );
    check('old password stops working', oldPassword.statusCode === 401, oldPassword.body);

    const newPassword = await request(
      'POST',
      `/api/rooms/${closedRoom.id}/unlock`,
      outsider,
      { password: 'new-secret-pass' }
    );
    check('new password works', newPassword.statusCode === 200, newPassword.body);

    // Whitelist management.
    const membersResponse = await request(
      'GET',
      `/api/rooms/${restrictedRoom.id}/members`,
      owner
    );
    check(
      'owner can list room members',
      membersResponse.statusCode === 200 &&
        membersResponse.json().members.some((roomMember) => roomMember.id === member),
      membersResponse.body
    );

    const membersAsMember = await request(
      'GET',
      `/api/rooms/${restrictedRoom.id}/members`,
      member
    );
    check('regular users cannot manage room members', membersAsMember.statusCode === 403, membersAsMember.body);

    const replaceMembers = await request(
      'PUT',
      `/api/rooms/${restrictedRoom.id}/members`,
      owner,
      { memberIds: [outsider] }
    );
    check('owner can replace the whitelist', replaceMembers.statusCode === 200, replaceMembers.body);

    const removedMemberRead = await request(
      'GET',
      `/api/rooms/${restrictedRoom.id}/messages`,
      member
    );
    check(
      'removing a user from the whitelist revokes access',
      removedMemberRead.statusCode === 403,
      removedMemberRead.body
    );

    const addedMemberRead = await request(
      'GET',
      `/api/rooms/${restrictedRoom.id}/messages`,
      outsider
    );
    check(
      'adding a user to the whitelist grants access',
      addedMemberRead.statusCode === 200,
      addedMemberRead.body
    );

    const switchToPublic = await request('PATCH', `/api/rooms/${restrictedRoom.id}`, owner, {
      accessLevel: 'public',
    });
    check('owner can switch a room to public', switchToPublic.statusCode === 200, switchToPublic.body);
    const publicAgain = await request(
      'GET',
      `/api/rooms/${restrictedRoom.id}/messages`,
      member
    );
    check('a room switched to public is readable by everyone', publicAgain.statusCode === 200, publicAgain.body);

    // Validation and the main-room invariant.
    const missingPassword = await request('POST', '/api/rooms', owner, {
      name: roomName('no_password_room'),
      accessLevel: 'closed',
    });
    check(
      'closed rooms require a password on creation',
      missingPassword.statusCode === 400,
      missingPassword.body
    );

    const shortPassword = await request('POST', '/api/rooms', owner, {
      name: roomName('short_password_room'),
      accessLevel: 'closed',
      password: 'abc',
    });
    check(
      'room passwords have a minimum length',
      shortPassword.statusCode === 400,
      shortPassword.body
    );

    const invalidLevel = await request('POST', '/api/rooms', owner, {
      name: roomName('invalid_level_room'),
      accessLevel: 'secret',
    });
    check('unknown access levels are rejected', invalidLevel.statusCode === 400, invalidLevel.body);

    const memberCreate = await request('POST', '/api/rooms', member, {
      name: roomName('member_room'),
    });
    check('regular members cannot create rooms', memberCreate.statusCode === 403, memberCreate.body);

    const mainRoomId = Number(
      db
        .prepare('INSERT INTO rooms (name, created_by, access_level) VALUES (?, ?, ?)')
        .run('main', owner, 'restricted').lastInsertRowid
    );
    const mainRoomChange = await request('PATCH', `/api/rooms/${mainRoomId}`, owner, {
      accessLevel: 'private',
    });
    check(
      'the main room cannot leave the public level',
      mainRoomChange.statusCode === 400,
      mainRoomChange.body
    );

    const unknownUserWhitelist = await request(
      'PUT',
      `/api/rooms/${privateRoom.id}/members`,
      owner,
      { memberIds: [99999999] }
    );
    check(
      'whitelists reject unknown users',
      unknownUserWhitelist.statusCode === 400,
      unknownUserWhitelist.body
    );

    check(
      'access changes are announced with rooms_changed',
      globalEvents.some((event) => event.type === 'rooms_changed'),
      JSON.stringify(globalEvents.map((event) => event.type))
    );

    const createNotification = globalEvents.find(
      (event) => event.type === 'room_created' && event.room.id === privateRoom.id
    );
    check(
      'created rooms are announced without per-user lock state',
      createNotification &&
        !('locked' in createNotification.room) &&
        !('unread_count' in createNotification.room),
      JSON.stringify(createNotification)
    );

    const messageNotification = globalEvents.find(
      (event) => event.type === 'room_message' && event.roomId === closedRoom.id
    );
    check(
      'new messages produce a room notification',
      Boolean(messageNotification),
      JSON.stringify(globalEvents.map((event) => event.type))
    );
  } finally {
    await app.close();
    db.close();
    removeWorkspace(workspace);
  }

  verify();
});
