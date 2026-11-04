'use strict';

const test = require('node:test');
const Database = require('better-sqlite3');

const {
  createChecker,
  createWorkspace,
  removeWorkspace,
  seedUser,
  startServerOrCleanup,
  unique,
} = require('./helpers');

const { createDb } = require('../src/db');
const { hashPassword } = require('../src/auth');

test('security hardening covers headers, throttling, passwords and input caps', async () => {
  const { check, verify } = createChecker();
  const workspace = createWorkspace('security');

  const ownerLogin = unique('sec_owner');
  const memberLogin = unique('sec_member');
  const inviteId = unique('sec_invite');

  const seed = createDb(workspace.dbPath);
  const ownerId = seedUser(seed, ownerLogin, {
    role: 'owner',
    passwordHash: hashPassword('ownerpass'),
  });
  seedUser(seed, memberLogin, {
    role: 'member',
    passwordHash: hashPassword('memberpass'),
  });
  seed.prepare('INSERT INTO invites (id, created_by) VALUES (?, ?)').run(inviteId, ownerId);
  seed.prepare('DELETE FROM verification_settings').run();
  seed.close();

  const server = await startServerOrCleanup(workspace, {
    extraEnv: { NODE_ENV: 'development', DEBUG_MODE: 'true' },
  });
  const db = new Database(workspace.dbPath);

  async function api(path, { method = 'GET', body, session } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (session) headers.cookie = `chagourtee_sid=${session}`;

    const response = await fetch(`${server.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    let parsed = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }

    return {
      status: response.status,
      headers: response.headers,
      body: parsed,
      setCookie: response.headers.get('set-cookie') || '',
    };
  }

  function sessionOf(response) {
    const match = /chagourtee_sid=([^;]+)/.exec(response.setCookie);
    return match ? match[1] : null;
  }

  try {
    // --- Removed destructive debug surface --------------------------------
    const debugDrop = await api('/debug/drop-table/users', { method: 'DELETE' });
    check(
      'debug drop-table route is not registered even in development',
      debugDrop.status === 404,
      `${debugDrop.status}`
    );

    // --- Baseline security headers ----------------------------------------
    const version = await api('/api/version');
    check('API responds with security headers', version.status === 200);
    check(
      'clickjacking is denied',
      version.headers.get('x-frame-options') === 'DENY',
      version.headers.get('x-frame-options')
    );
    check(
      'MIME sniffing is disabled',
      version.headers.get('x-content-type-options') === 'nosniff',
      version.headers.get('x-content-type-options')
    );
    check(
      'referrer leaks are limited',
      version.headers.get('referrer-policy') === 'no-referrer',
      version.headers.get('referrer-policy')
    );
    check(
      'browser features are restricted',
      (version.headers.get('permissions-policy') || '').includes('camera=()'),
      version.headers.get('permissions-policy')
    );

    // --- Password change revokes other sessions ---------------------------
    const loginA = await api('/api/auth/login', {
      method: 'POST',
      body: { login: memberLogin, password: 'memberpass' },
    });
    const loginB = await api('/api/auth/login', {
      method: 'POST',
      body: { login: memberLogin, password: 'memberpass' },
    });
    const sessionA = sessionOf(loginA);
    const sessionB = sessionOf(loginB);
    check('first session is created', loginA.status === 200 && Boolean(sessionA));
    check('second session is created', loginB.status === 200 && Boolean(sessionB));

    const changePassword = await api('/api/profile/change-password', {
      method: 'POST',
      session: sessionA,
      body: { currentPassword: 'memberpass', newPassword: 'new-member-pass' },
    });
    check(
      'password change accepts a valid new password',
      changePassword.status === 200,
      JSON.stringify(changePassword.body)
    );

    const currentSession = await api('/api/auth/me', { session: sessionA });
    check(
      'the session that changed the password stays valid',
      currentSession.status === 200,
      `${currentSession.status}`
    );

    const otherSession = await api('/api/auth/me', { session: sessionB });
    check(
      'other sessions are revoked after a password change',
      otherSession.status === 401,
      `${otherSession.status}`
    );

    const oldPasswordLogin = await api('/api/auth/login', {
      method: 'POST',
      body: { login: memberLogin, password: 'memberpass' },
    });
    check(
      'the old password no longer works',
      oldPasswordLogin.status === 401,
      `${oldPasswordLogin.status}`
    );

    const newPasswordLogin = await api('/api/auth/login', {
      method: 'POST',
      body: { login: memberLogin, password: 'new-member-pass' },
    });
    check(
      'the new password works',
      newPasswordLogin.status === 200,
      `${newPasswordLogin.status}`
    );

    // --- Registration password policy -------------------------------------
    const shortPassword = await api('/api/auth/register', {
      method: 'POST',
      body: { inviteId, login: unique('shortpw'), password: 'short' },
    });
    check(
      'short passwords are rejected at registration',
      shortPassword.status === 400 && /at least 8/.test(shortPassword.body?.error || ''),
      JSON.stringify(shortPassword.body)
    );

    const longPassword = await api('/api/auth/register', {
      method: 'POST',
      body: { inviteId, login: unique('longpw'), password: 'a'.repeat(73) },
    });
    check(
      'passwords longer than bcrypt can use are rejected',
      longPassword.status === 400 && /72 bytes/.test(longPassword.body?.error || ''),
      JSON.stringify(longPassword.body)
    );

    // --- Input caps -------------------------------------------------------
    const ownerLoginResponse = await api('/api/auth/login', {
      method: 'POST',
      body: { login: ownerLogin, password: 'ownerpass' },
    });
    const ownerSession = sessionOf(ownerLoginResponse);
    check('owner can log in for admin checks', ownerLoginResponse.status === 200);

    const invalidInvite = await api('/api/invites', {
      method: 'POST',
      session: ownerSession,
      body: { maxUses: 0 },
    });
    check(
      'invite maxUses is bounded',
      invalidInvite.status === 400,
      JSON.stringify(invalidInvite.body)
    );

    const invalidExpiry = await api('/api/invites', {
      method: 'POST',
      session: ownerSession,
      body: { expiresInHours: 24 * 366 },
    });
    check(
      'invite expiry is bounded',
      invalidExpiry.status === 400,
      JSON.stringify(invalidExpiry.body)
    );

    const roomsResponse = await api('/api/rooms', { session: ownerSession });
    const mainRoom = (roomsResponse.body?.rooms || []).find((room) => room.name === 'main');
    check('main room is available for message checks', Boolean(mainRoom));

    const tooLongMessage = await api(`/api/rooms/${mainRoom.id}/messages`, {
      method: 'POST',
      session: ownerSession,
      body: { body: 'x'.repeat(10001) },
    });
    check(
      'message body length is capped',
      tooLongMessage.status === 400,
      JSON.stringify(tooLongMessage.body)
    );

    const invalidMediaIds = await api(`/api/rooms/${mainRoom.id}/messages`, {
      method: 'POST',
      session: ownerSession,
      body: { body: 'hello', media_ids: ['not-an-id'] },
    });
    check(
      'media ids must be positive integers',
      invalidMediaIds.status === 400,
      JSON.stringify(invalidMediaIds.body)
    );

    const tooManyMediaIds = await api(`/api/rooms/${mainRoom.id}/messages`, {
      method: 'POST',
      session: ownerSession,
      body: {
        body: 'hello',
        media_ids: Array.from({ length: 11 }, (_, index) => index + 1),
      },
    });
    check(
      'media attachment count is capped',
      tooManyMediaIds.status === 400,
      JSON.stringify(tooManyMediaIds.body)
    );

    const tooManyDeletes = await api(`/api/rooms/${mainRoom.id}/messages/batch-delete`, {
      method: 'DELETE',
      session: ownerSession,
      body: { messageIds: Array.from({ length: 201 }, (_, index) => index + 1) },
    });
    check(
      'batch delete count is capped',
      tooManyDeletes.status === 400,
      JSON.stringify(tooManyDeletes.body)
    );

    const tooManyMembers = await api(`/api/rooms/${mainRoom.id}/members`, {
      method: 'PUT',
      session: ownerSession,
      body: {
        memberIds: Array.from({ length: 1001 }, (_, index) => index + 1),
      },
    });
    check(
      'room member list is capped',
      tooManyMembers.status === 400,
      JSON.stringify(tooManyMembers.body)
    );

    // --- Login throttling (kept last because it locks this IP briefly) -----
    let failures = 0;
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const response = await api('/api/auth/login', {
        method: 'POST',
        body: { login: ownerLogin, password: 'wrong-password' },
      });
      if (response.status === 401) failures += 1;
    }
    check('failed logins are counted', failures === 10, `${failures}`);

    const throttled = await api('/api/auth/login', {
      method: 'POST',
      body: { login: ownerLogin, password: 'ownerpass' },
    });
    check(
      'login is throttled after repeated failures',
      throttled.status === 429 && throttled.body?.code === 'LOGIN_RATE_LIMITED',
      `${throttled.status} ${JSON.stringify(throttled.body)}`
    );
    check(
      'throttled responses include Retry-After',
      Number(throttled.headers.get('retry-after')) > 0,
      throttled.headers.get('retry-after')
    );

    // Password change removed the other session; the successful login with
    // the new password then created a fresh one.
    const memberSessions = db
      .prepare(
        'SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.login = ?'
      )
      .all(memberLogin)
      .map((row) => row.id);
    check(
      'the revoked session is gone from the database',
      !memberSessions.includes(sessionB),
      JSON.stringify(memberSessions)
    );
    check(
      'the current and newly created sessions remain',
      memberSessions.includes(sessionA) &&
        memberSessions.includes(sessionOf(newPasswordLogin)),
      JSON.stringify(memberSessions)
    );
  } finally {
    db.close();
    await server.stop();
    removeWorkspace(workspace);
  }

  verify();
});
