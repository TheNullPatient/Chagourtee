'use strict';

const test = require('node:test');

const { createChecker, createWorkspace, removeWorkspace, seedUser, unique, useWorkspace } =
  require('./helpers');

const workspace = createWorkspace('verification');
useWorkspace(workspace);

const Fastify = require('fastify');
const { getDb } = require('../src/db');
const verificationPlugin = require('../src/verification');

test('verification codes are hashed, single-use and rate limited', async () => {
  const { check, verify } = createChecker();
  const db = getDb();

  const owner = seedUser(db, unique('v_owner'), { role: 'owner' });
  const member = seedUser(db, unique('v_member'), { verified: false });
  const other = seedUser(db, unique('v_other'), { verified: false });
  const rateLimited = seedUser(db, unique('v_rate'), { verified: false });

  const broadcasts = [];
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.decorate('getUser', (id) => {
    const row = db
      .prepare('SELECT id, login, role, verified FROM users WHERE id = ?')
      .get(id);
    return row ? { ...row, verified: Boolean(row.verified) } : null;
  });

  function authenticate(request, reply) {
    const id = Number(request.headers['x-test-user']);
    if (!id) {
      reply.code(401).send({ error: 'Unauthorized' });
      return false;
    }
    const user = app.getUser(id);
    if (!user) {
      reply.code(401).send({ error: 'Unauthorized' });
      return false;
    }
    request.session = { userId: id };
    request.user = user;
    return true;
  }

  app.decorate('requireAuth', async (request, reply) => {
    authenticate(request, reply);
  });
  app.decorate('requireOwnerOrModerator', async (request, reply) => {
    if (!authenticate(request, reply)) return;
    if (!['owner', 'moderator'].includes(request.user.role)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
  });
  app.decorate('requireOwner', async (request, reply) => {
    if (!authenticate(request, reply)) return;
    if (request.user.role !== 'owner') {
      return reply.code(403).send({ error: 'Forbidden' });
    }
  });
  app.decorate('broadcastToUser', (userId, payload) =>
    broadcasts.push({ target: userId, payload })
  );
  app.decorate('broadcastAll', (payload) => broadcasts.push({ target: 'all', payload }));
  app.decorate('broadcastVerificationSettingsUpdated', (enabled) =>
    broadcasts.push({ target: 'all', payload: { type: 'verification_settings_updated', enabled } })
  );
  app.decorate('broadcastVerificationCodesChanged', () =>
    broadcasts.push({ target: 'all', payload: { type: 'verification_codes_changed' } })
  );

  verificationPlugin(app);

  async function request(method, url, userId, payload) {
    const headers = { 'content-type': 'application/json' };
    if (userId) headers['x-test-user'] = String(userId);
    return app.inject({ method, url, headers, payload });
  }

  try {
    const publicStatus = await request('GET', '/api/verification/status');
    check(
      'public status endpoint works without auth',
      publicStatus.statusCode === 200 && publicStatus.json().enabled === false,
      publicStatus.body
    );

    const protectedSettings = await request('GET', '/api/verification/settings');
    check(
      'admin settings endpoint requires auth',
      protectedSettings.statusCode === 401,
      protectedSettings.body
    );

    const memberSettings = await request('GET', '/api/verification/settings', member);
    check(
      'admin settings endpoint rejects members',
      memberSettings.statusCode === 403,
      memberSettings.body
    );

    const enable = await request('POST', '/api/verification/settings', owner, { enabled: true });
    check(
      'owner can enable verification',
      enable.statusCode === 200 && enable.json().enabled === true,
      enable.body
    );

    const statusAfterEnable = await request('GET', '/api/verification/status');
    check('public status reflects enabled verification', statusAfterEnable.json().enabled === true);

    const settingsAfterEnable = await request('GET', '/api/verification/settings', owner);
    check(
      'comment auto-deletion is disabled by default',
      settingsAfterEnable.statusCode === 200 &&
        settingsAfterEnable.json().deleteCommentOnApprove === false,
      settingsAfterEnable.body
    );

    const commentSetting = await request('POST', '/api/verification/settings', owner, {
      deleteCommentOnApprove: true,
    });
    check(
      'owner can enable comment auto-deletion without changing verification',
      commentSetting.statusCode === 200 &&
        commentSetting.json().enabled === true &&
        commentSetting.json().deleteCommentOnApprove === true,
      commentSetting.body
    );

    const invalidSetting = await request('POST', '/api/verification/settings', owner, {
      deleteCommentOnApprove: 'yes',
    });
    check(
      'non-boolean comment setting is rejected',
      invalidSetting.statusCode === 400,
      invalidSetting.body
    );

    db.prepare('UPDATE users SET registration_comment = ? WHERE id = ?').run(
      'Invited by Alex',
      member
    );
    const pendingList = await request('GET', '/api/verification/pending', owner);
    const pendingMember = pendingList.json().pending.find((row) => row.id === member);
    check(
      'pending list exposes the registration comment',
      pendingMember && pendingMember.registration_comment === 'Invited by Alex',
      pendingList.body
    );

    const approvedWithDeletion = seedUser(db, unique('v_approved'), { verified: false });
    db.prepare('UPDATE users SET registration_comment = ? WHERE id = ?').run(
      'delete me',
      approvedWithDeletion
    );
    const autoApprove = await request('POST', '/api/verification/approve', owner, {
      userId: approvedWithDeletion,
    });
    check(
      'approve works and clears the comment when auto-deletion is on',
      autoApprove.statusCode === 200 &&
        db.prepare('SELECT verified FROM users WHERE id = ?').get(approvedWithDeletion).verified === 1 &&
        db.prepare('SELECT registration_comment FROM users WHERE id = ?').get(approvedWithDeletion)
          .registration_comment === null,
      autoApprove.body
    );

    await request('POST', '/api/verification/settings', owner, { deleteCommentOnApprove: false });
    const approvedWithoutDeletion = seedUser(db, unique('v_kept'), { verified: false });
    db.prepare('UPDATE users SET registration_comment = ? WHERE id = ?').run(
      'keep me',
      approvedWithoutDeletion
    );
    const keepApprove = await request('POST', '/api/verification/approve', owner, {
      userId: approvedWithoutDeletion,
    });
    check(
      'approve keeps the comment when auto-deletion is off',
      keepApprove.statusCode === 200 &&
        db.prepare('SELECT registration_comment FROM users WHERE id = ?').get(approvedWithoutDeletion)
          .registration_comment === 'keep me',
      keepApprove.body
    );

    const unauthCreate = await request('POST', '/api/verification/codes', null, {
      code: 'ABC123',
    });
    check('code creation requires auth', unauthCreate.statusCode === 401, unauthCreate.body);

    const created = await request('POST', '/api/verification/codes', owner, { code: 'ABC123' });
    check(
      'owner can create a custom code',
      created.statusCode === 200 && created.json().code === 'ABC123',
      created.body
    );
    check(
      'created code returns expires_at',
      typeof created.json().expires_at === 'string',
      created.body
    );

    const codeId = created.json().id;
    const stored = db
      .prepare('SELECT code_hash FROM verification_codes WHERE id = ?')
      .get(codeId);
    check('code is stored hashed, not in plaintext', Boolean(stored) && stored.code_hash !== 'ABC123');

    const future = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const patched = await request('PATCH', `/api/verification/codes/${codeId}`, owner, {
      expiresAt: future,
    });
    check('code update accepts expiresAt', patched.statusCode === 200, patched.body);

    const wrongPatch = await request('PATCH', `/api/verification/codes/${codeId}`, owner, {
      expiration: future,
    });
    check(
      'code update rejects the old expiration field',
      wrongPatch.statusCode === 400,
      wrongPatch.body
    );

    const unauthUse = await request('POST', '/api/verification/codes/use', null, {
      code: 'ABC123',
    });
    check('code use requires auth', unauthUse.statusCode === 401, unauthUse.body);

    const wrongUse = await request('POST', '/api/verification/codes/use', member, {
      code: 'WRONG',
    });
    check('wrong code is rejected', wrongUse.statusCode === 400, wrongUse.body);

    const validUse = await request('POST', '/api/verification/codes/use', member, {
      code: 'ABC123',
    });
    check(
      'valid code verifies the user',
      validUse.statusCode === 200 && validUse.json().ok === true,
      validUse.body
    );
    check(
      'user is marked verified',
      Boolean(db.prepare('SELECT verified FROM users WHERE id = ?').get(member).verified)
    );
    check(
      'code is marked used',
      Boolean(
        db.prepare('SELECT used FROM verification_codes WHERE id = ?').get(codeId).used
      )
    );
    check(
      'verification broadcast is sent to the user',
      broadcasts.some((item) => item.target === member && item.payload.type === 'user_verified')
    );
    check(
      'verification broadcast is sent to everyone',
      broadcasts.some(
        (item) => item.target === 'all' && item.payload.type === 'user_verification_changed'
      )
    );

    const reuse = await request('POST', '/api/verification/codes/use', other, {
      code: 'ABC123',
    });
    check('used code cannot be reused', reuse.statusCode === 400, reuse.body);
    check(
      'another user stays unverified',
      !db.prepare('SELECT verified FROM users WHERE id = ?').get(other).verified
    );

    const second = await request('POST', '/api/verification/codes', owner, { code: 'SECOND' });
    const alreadyVerified = await request('POST', '/api/verification/codes/use', member, {
      code: 'SECOND',
    });
    check(
      'verified user short-circuits code use',
      alreadyVerified.statusCode === 200 && alreadyVerified.json().alreadyVerified === true,
      alreadyVerified.body
    );
    check(
      'short-circuit does not consume the code',
      !db.prepare('SELECT used FROM verification_codes WHERE id = ?').get(second.json().id).used
    );

    const past = new Date(Date.now() - 60 * 1000).toISOString();
    const expired = await request('POST', '/api/verification/codes', owner, {
      code: 'EXPIRED',
      expiresAt: past,
    });
    const expiredUse = await request('POST', '/api/verification/codes/use', other, {
      code: 'EXPIRED',
    });
    check(
      'expired code is rejected',
      expiredUse.statusCode === 400 && expiredUse.json().message === 'Code has expired',
      expiredUse.body
    );
    check(
      'expired code is not consumed',
      !db.prepare('SELECT used FROM verification_codes WHERE id = ?').get(expired.json().id).used
    );

    // Five failed attempts are allowed, the sixth request gets 429.
    for (let i = 0; i < 5; i += 1) {
      await request('POST', '/api/verification/codes/use', rateLimited, { code: `BAD${i}` });
    }
    const limited = await request('POST', '/api/verification/codes/use', rateLimited, {
      code: 'BAD_AGAIN',
    });
    check('sixth failed attempt is rate limited', limited.statusCode === 429, limited.body);
    check('rate limit sends Retry-After', typeof limited.headers['retry-after'] === 'string');
  } finally {
    await app.close();
    db.close();
    removeWorkspace(workspace);
  }

  verify();
});
