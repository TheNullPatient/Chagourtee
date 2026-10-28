'use strict';

const test = require('node:test');
const WebSocket = require('ws');

const {
  createChecker,
  createWorkspace,
  removeWorkspace,
  seedUser,
  startServerOrCleanup,
  unique,
} = require('./helpers');

const { createDb } = require('../src/db');
const { hashRoomPassword } = require('../src/roomAccess');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect(port, sessionId) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { Cookie: `chagourtee_sid=${sessionId}` },
  });
  const messages = [];
  ws.on('message', (raw) => {
    try {
      messages.push(JSON.parse(raw.toString()));
    } catch {
      // ignore malformed frames
    }
  });
  return { ws, messages };
}

function waitFor(messages, predicate, timeout = 2000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const index = messages.findIndex(predicate);
      if (index !== -1) {
        clearInterval(timer);
        resolve(messages.splice(index, 1)[0]);
        return;
      }
      if (Date.now() - started >= timeout) {
        clearInterval(timer);
        resolve(null);
      }
    }, 20);
  });
}

test('websocket joins and message notifications respect room access', async () => {
  const { check, verify } = createChecker();
  const workspace = createWorkspace('room-access-ws');

  const db = createDb(workspace.dbPath);
  const ownerId = seedUser(db, unique('wsa_owner'), { role: 'owner' });
  const memberId = seedUser(db, unique('wsa_member'));
  const outsiderId = seedUser(db, unique('wsa_outsider'));

  function createSession(userId) {
    const id = unique('wsa_session');
    db.prepare(
      'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
    ).run(id, userId, new Date(Date.now() + 86400000).toISOString());
    return id;
  }

  function createRoom(name, accessLevel, passwordHash = null) {
    return Number(
      db
        .prepare(
          'INSERT INTO rooms (name, created_by, access_level, password_hash) VALUES (?, ?, ?, ?)'
        )
        .run(name, ownerId, accessLevel, passwordHash).lastInsertRowid
    );
  }

  const privateRoom = createRoom(unique('wsa_private'), 'private');
  const closedRoom = createRoom(unique('wsa_closed'), 'closed', hashRoomPassword('join-pass'));
  const restrictedRoom = createRoom(unique('wsa_restricted'), 'restricted');
  db.prepare('INSERT INTO room_members (room_id, user_id) VALUES (?, ?)').run(
    privateRoom,
    memberId
  );
  db.prepare('INSERT INTO room_members (room_id, user_id) VALUES (?, ?)').run(
    restrictedRoom,
    memberId
  );

  const ownerSession = createSession(ownerId);
  const memberSession = createSession(memberId);
  const outsiderSession = createSession(outsiderId);
  db.close();

  const server = await startServerOrCleanup(workspace);
  let serverOutput = '';

  try {
    const owner = connect(server.port, ownerSession);
    const member = connect(server.port, memberSession);
    const outsider = connect(server.port, outsiderSession);
    await Promise.all([
      new Promise((resolve) => owner.ws.on('open', resolve)),
      new Promise((resolve) => member.ws.on('open', resolve)),
      new Promise((resolve) => outsider.ws.on('open', resolve)),
    ]);
    await delay(200);

    outsider.messages.length = 0;
    outsider.ws.send(JSON.stringify({ type: 'join', roomId: privateRoom }));
    const privateError = await waitFor(
      outsider.messages,
      (message) => message.type === 'error' && message.code === 'ROOM_FORBIDDEN'
    );
    check('outsiders cannot join a private room', privateError !== null);

    outsider.messages.length = 0;
    outsider.ws.send(JSON.stringify({ type: 'join', roomId: restrictedRoom }));
    const restrictedError = await waitFor(
      outsider.messages,
      (message) => message.type === 'error' && message.code === 'ROOM_FORBIDDEN'
    );
    check('outsiders cannot join a restricted room', restrictedError !== null);

    outsider.messages.length = 0;
    outsider.ws.send(JSON.stringify({ type: 'join', roomId: closedRoom }));
    const closedError = await waitFor(
      outsider.messages,
      (message) => message.type === 'error' && message.code === 'ROOM_LOCKED'
    );
    check('closed rooms reject joins until unlocked', closedError !== null);

    const ownerClosed = connect(server.port, ownerSession);
    await new Promise((resolve) => ownerClosed.ws.on('open', resolve));
    await delay(100);
    ownerClosed.messages.length = 0;
    ownerClosed.ws.send(JSON.stringify({ type: 'join', roomId: closedRoom }));
    await delay(300);
    check(
      'owner joins a closed room without a password',
      !ownerClosed.messages.some(
        (message) => message.type === 'error' && message.code === 'ROOM_LOCKED'
      ),
      JSON.stringify(ownerClosed.messages)
    );

    // Notifications for a private room must only reach users with access.
    member.messages.length = 0;
    outsider.messages.length = 0;
    const send = await fetch(
      `${server.baseUrl}/api/rooms/${privateRoom}/messages`,
      {
        method: 'POST',
        headers: {
          Cookie: `chagourtee_sid=${ownerSession}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: 'Private hello' }),
      }
    );
    check('owner can post to the private room', send.status === 200, await send.text());

    const memberNotification = await waitFor(
      member.messages,
      (message) => message.type === 'room_message' && message.roomId === privateRoom
    );
    check('whitelisted member receives the private room notification', memberNotification !== null);

    await delay(400);
    check(
      'outsiders do not receive private room notifications',
      !outsider.messages.some(
        (message) => message.type === 'room_message' && message.roomId === privateRoom
      ),
      JSON.stringify(outsider.messages)
    );

    // The member also joins the private room and relays typing to the owner.
    member.ws.send(JSON.stringify({ type: 'join', roomId: privateRoom }));
    owner.ws.send(JSON.stringify({ type: 'join', roomId: privateRoom }));
    await delay(200);
    member.ws.send(JSON.stringify({ type: 'typing', roomId: privateRoom }));
    const typing = await waitFor(
      owner.messages,
      (message) => message.type === 'typing' && message.userId === memberId
    );
    check('private room members can exchange room events', typing !== null);

    // Unlocking through the REST API must also allow the socket to join.
    const unlock = await fetch(`${server.baseUrl}/api/rooms/${closedRoom}/unlock`, {
      method: 'POST',
      headers: {
        Cookie: `chagourtee_sid=${outsiderSession}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password: 'join-pass' }),
    });
    check('outsider unlocks the closed room over HTTP', unlock.status === 200, await unlock.text());

    outsider.messages.length = 0;
    outsider.ws.send(JSON.stringify({ type: 'join', roomId: closedRoom }));
    await delay(300);
    check(
      'unlocked user can join the closed room',
      !outsider.messages.some(
        (message) => message.type === 'error' && message.code === 'ROOM_LOCKED'
      ),
      JSON.stringify(outsider.messages)
    );

    owner.ws.close();
    member.ws.close();
    outsider.ws.close();
    ownerClosed.ws.close();
  } catch (error) {
    serverOutput = server.getOutput();
    throw new Error(`${error.message}\n--- server output ---\n${serverOutput}`);
  } finally {
    const output = await server.stop();
    if (output.includes('Fatal') || output.includes('Unhandled')) {
      serverOutput = output;
    }
    removeWorkspace(workspace);
  }

  if (serverOutput) {
    check('server logs contain no fatal errors', !/Fatal|Unhandled/.test(serverOutput), serverOutput);
  }

  verify();
});
