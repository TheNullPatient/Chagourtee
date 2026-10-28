'use strict';

const test = require('node:test');
const Database = require('better-sqlite3');
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

function waitForClose(ws) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: null, reason: 'timeout' }), 3000);
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
    ws.on('error', () => {});
  });
}

test('unverified accounts are gated over HTTP and WebSocket', async () => {
  const { check, verify } = createChecker();
  const workspace = createWorkspace('verification-gate');

  const seed = createDb(workspace.dbPath);
  const ownerId = seedUser(seed, unique('gate_owner'), {
    role: 'owner',
    passwordHash: require('../src/auth').hashPassword('ownerpass'),
  });
  seed.prepare('DELETE FROM verification_settings').run();
  seed.prepare('INSERT INTO verification_settings (enabled) VALUES (1)').run();
  const inviteId = unique('gate_invite');
  seed.prepare('INSERT INTO invites (id, created_by) VALUES (?, ?)').run(inviteId, ownerId);
  const roomId = Number(
    seed
      .prepare('INSERT INTO rooms (name, created_by) VALUES (?, ?)')
      .run(unique('gate_room'), ownerId).lastInsertRowid
  );
  seed.close();

  const server = await startServerOrCleanup(workspace);
  const db = new Database(workspace.dbPath);

  async function request(method, url, cookie, body) {
    const response = await fetch(`${server.baseUrl}${url}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  try {
    const ownerLogin = db.prepare('SELECT login FROM users WHERE id = ?').get(ownerId).login;
    const loginResponse = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: ownerLogin, password: 'ownerpass' }),
    });
    check('owner login works', loginResponse.status === 200, await loginResponse.clone().text());
    const ownerSession = loginResponse.headers.get('set-cookie').split(';')[0];

    const memberLogin = `gate${String(Date.now()).slice(-8)}`;
    const registerResponse = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        inviteId,
        login: memberLogin,
        password: 'secret123',
        comment: 'Invited by the owner',
      }),
    });
    const registerBody = await registerResponse.json();
    check('pending registration succeeds', registerResponse.status === 200, JSON.stringify(registerBody));
    const memberSession = registerResponse.headers.get('set-cookie').split(';')[0];
    const memberId = registerBody.user.id;

    const blocked = [
      ['GET', '/api/rooms'],
      ['GET', '/api/media/settings'],
      ['GET', '/api/users'],
      ['GET', '/api/users/online'],
      ['GET', '/api/invites'],
      ['GET', `/api/rooms/${roomId}/messages`],
    ];
    for (const [method, url] of blocked) {
      const result = await request(method, url, memberSession);
      check(
        `unverified account is blocked from ${method} ${url}`,
        result.status === 403 && result.body?.code === 'ACCOUNT_NOT_VERIFIED',
        JSON.stringify(result)
      );
    }

    const uploadForm = new FormData();
    uploadForm.append('file', new Blob([Buffer.from('blocked')]), 'probe.txt');
    const uploadResponse = await fetch(`${server.baseUrl}/api/upload`, {
      method: 'POST',
      headers: { cookie: memberSession },
      body: uploadForm,
    });
    const uploadBody = await uploadResponse.json().catch(() => null);
    check(
      'unverified account is blocked from POST /api/upload',
      uploadResponse.status === 403 && uploadBody?.code === 'ACCOUNT_NOT_VERIFIED',
      JSON.stringify({ status: uploadResponse.status, body: uploadBody })
    );

    const allowed = [
      ['GET', '/api/auth/me'],
      ['GET', '/api/verification/status'],
      ['GET', '/api/server/settings'],
      ['GET', '/api/version'],
    ];
    for (const [method, url] of allowed) {
      const result = await request(method, url, memberSession);
      check(
        `unverified account can still use ${method} ${url}`,
        result.status === 200,
        JSON.stringify(result)
      );
    }

    const blockedSocket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { Cookie: memberSession },
    });
    const closed = await waitForClose(blockedSocket);
    check(
      'unverified WebSocket connection is rejected',
      closed.code === 4003 && closed.reason === 'Verification required',
      JSON.stringify(closed)
    );

    // Disabling verification must approve everyone who was waiting.
    const disable = await request('POST', '/api/verification/settings', ownerSession, {
      enabled: false,
    });
    check('owner can disable verification', disable.status === 200, JSON.stringify(disable.body));

    const memberRow = db
      .prepare('SELECT verified, registration_comment FROM users WHERE id = ?')
      .get(memberId);
    check(
      'disabling verification approves pending members',
      memberRow.verified === 1,
      JSON.stringify(memberRow)
    );
    check(
      'disabling verification keeps the comment by default',
      memberRow.registration_comment === 'Invited by the owner',
      JSON.stringify(memberRow)
    );

    const meAfterDisable = await request('GET', '/api/auth/me', memberSession);
    check(
      'the member sees a verified account after disabling verification',
      meAfterDisable.status === 200 && meAfterDisable.body?.verified === true,
      JSON.stringify(meAfterDisable)
    );
    const roomsAfterDisable = await request('GET', '/api/rooms', memberSession);
    check(
      'the member regains access after disabling verification',
      roomsAfterDisable.status === 200,
      JSON.stringify(roomsAfterDisable)
    );

    const verifiedSocket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { Cookie: memberSession },
    });
    const socketEvents = [];
    verifiedSocket.on('message', (raw) => {
      try {
        socketEvents.push(JSON.parse(raw.toString()));
      } catch {
        // ignore
      }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket did not open')), 3000);
      verifiedSocket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      verifiedSocket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    await delay(300);
    check(
      'verified WebSocket receives the presence snapshot',
      socketEvents.some((event) => event.type === 'presence_snapshot'),
      JSON.stringify(socketEvents)
    );
    verifiedSocket.close();

    // Pulse check: the owner session captured above is valid.
    const ownerMe = await request('GET', '/api/auth/me', ownerSession);
    check('owner session is valid', ownerMe.status === 200, JSON.stringify(ownerMe));
  } finally {
    db.close();
    await server.stop();
    removeWorkspace(workspace);
  }

  verify();
});
