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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect(port, sessionId) {
  const headers = sessionId ? { Cookie: `chagourtee_sid=${sessionId}` } : {};
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
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

test('websocket rejects unauthenticated clients and forged events', async () => {
  const { check, verify } = createChecker();
  const workspace = createWorkspace('ws');

  const db = createDb(workspace.dbPath);
  const aliceId = seedUser(db, unique('ws_alice'));
  const bobId = seedUser(db, unique('ws_bob'));

  function createSession(userId) {
    const id = unique('ws_session');
    db.prepare(
      "INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)"
    ).run(id, userId, new Date(Date.now() + 86400000).toISOString());
    return id;
  }

  function createRoom(name, ownerId) {
    return Number(
      db.prepare('INSERT INTO rooms (name, created_by) VALUES (?, ?)').run(name, ownerId)
        .lastInsertRowid
    );
  }

  const aliceSession = createSession(aliceId);
  const bobSession = createSession(bobId);
  const roomA = createRoom(unique('ws_room_a'), aliceId);
  const roomB = createRoom(unique('ws_room_b'), aliceId);
  db.close();

  const server = await startServerOrCleanup(workspace);
  let serverOutput = '';

  try {
    const unauthorized = connect(server.port, null);
    const unauthorizedCode = await new Promise((resolve) => {
      unauthorized.ws.on('close', (code) => resolve(code));
      setTimeout(() => resolve(null), 3000);
    });
    check('unauthenticated websocket is rejected', unauthorizedCode === 4001, String(unauthorizedCode));

    const alice = connect(server.port, aliceSession);
    const bob = connect(server.port, bobSession);
    await Promise.all([
      new Promise((resolve) => alice.ws.on('open', resolve)),
      new Promise((resolve) => bob.ws.on('open', resolve)),
    ]);
    await delay(200);

    alice.ws.send(JSON.stringify({ type: 'join', roomId: 99999999 }));
    const roomError = await waitFor(
      alice.messages,
      (message) => message.type === 'error' && message.code === 'ROOM_NOT_FOUND'
    );
    check('joining a non-existent room is rejected', roomError !== null);

    alice.ws.send(JSON.stringify({ type: 'join', roomId: roomA }));
    bob.ws.send(JSON.stringify({ type: 'join', roomId: roomA }));
    await delay(200);

    alice.ws.send(JSON.stringify({ type: 'typing', roomId: roomA }));
    const typing = await waitFor(
      bob.messages,
      (message) => message.type === 'typing' && message.userId === aliceId
    );
    check('typing is delivered to room members', typing !== null);

    bob.messages.length = 0;
    alice.ws.send(JSON.stringify({ type: 'typing', roomId: roomB }));
    await delay(500);
    check(
      'typing for a room the sender has not joined is dropped',
      !bob.messages.some((message) => message.type === 'typing')
    );

    bob.messages.length = 0;
    alice.ws.send(
      JSON.stringify({ type: 'update_message', roomId: roomA, messageId: 1, content: 'forged' })
    );
    alice.ws.send(JSON.stringify({ type: 'delete_message', roomId: roomA, messageId: 1 }));
    alice.ws.send(
      JSON.stringify({ type: 'upload_media', roomId: roomA, file: { id: 1, name: 'x' } })
    );
    alice.ws.send(
      JSON.stringify({ type: 'share_media', roomId: roomA, file: { id: 1, name: 'x' } })
    );
    await delay(500);
    check(
      'content-mutating websocket events are ignored',
      !bob.messages.some((message) =>
        ['message_updated', 'message_deleted', 'media_uploaded', 'media_shared'].includes(
          message.type
        )
      ),
      JSON.stringify(bob.messages)
    );

    alice.ws.send(JSON.stringify({ type: 'ping' }));
    const pong = await waitFor(alice.messages, (message) => message.type === 'pong');
    check('ping is answered with pong', pong !== null);

    alice.ws.send(
      JSON.stringify({
        type: 'check_media_availability',
        requestId: 'test-request',
        files: [{ id: 99999999, encrypted_filename: 'missing.enc' }],
      })
    );
    const availability = await waitFor(
      alice.messages,
      (message) =>
        message.type === 'media_availability_result' && message.requestId === 'test-request'
    );
    check(
      'media availability check works',
      availability !== null && availability.unavailableIds.includes(99999999)
    );

    alice.ws.send(JSON.stringify({ type: 'leave', roomId: roomA }));
    await delay(100);
    bob.messages.length = 0;
    alice.ws.send(JSON.stringify({ type: 'typing', roomId: roomA }));
    await delay(500);
    check(
      'typing after leaving the room is dropped',
      !bob.messages.some((message) => message.type === 'typing')
    );

    alice.ws.close();
    bob.ws.close();
  } finally {
    serverOutput = await server.stop();
    removeWorkspace(workspace);
  }

  if (serverOutput && /error/i.test(serverOutput)) {
    process.stderr.write(`\nServer output:\n${serverOutput}\n`);
  }

  verify();
});
