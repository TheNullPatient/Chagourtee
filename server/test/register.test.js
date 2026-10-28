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

test('registration stores an optional comment while verification is enabled', async () => {
  const { check, verify } = createChecker();
  const workspace = createWorkspace('register');

  const seed = createDb(workspace.dbPath);
  const ownerId = seedUser(seed, unique('reg_owner'), { role: 'owner' });
  seed.prepare('DELETE FROM verification_settings').run();
  seed.prepare('INSERT INTO verification_settings (enabled) VALUES (1)').run();
  const inviteId = unique('reg_invite');
  seed.prepare('INSERT INTO invites (id, created_by) VALUES (?, ?)').run(inviteId, ownerId);
  seed.close();

  const server = await startServerOrCleanup(workspace);
  const db = new Database(workspace.dbPath);
  let serverOutput = '';

  async function register(login, comment) {
    const response = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inviteId, login, password: 'secret123', comment }),
    });
    return { status: response.status, body: await response.json() };
  }

  try {
    const publicStatus = await fetch(`${server.baseUrl}/api/verification/status`);
    const publicStatusBody = await publicStatus.json();
    check(
      'registration can read the public verification status',
      publicStatus.status === 200 && publicStatusBody.enabled === true,
      JSON.stringify(publicStatusBody)
    );

    const suffix = String(Date.now()).slice(-6);

    const withoutCommentLogin = `nocomment${suffix}`;
    const withoutComment = await register(withoutCommentLogin, undefined);
    check(
      'registration without a comment succeeds',
      withoutComment.status === 200 && Boolean(withoutComment.body.user),
      JSON.stringify(withoutComment)
    );
    check(
      'registration response does not leak the comment',
      withoutComment.body.user && !('registration_comment' in withoutComment.body.user),
      JSON.stringify(withoutComment.body.user)
    );
    const withoutCommentRow = db
      .prepare('SELECT verified, registration_comment FROM users WHERE login = ?')
      .get(withoutCommentLogin);
    check('new user is unverified when verification is on', withoutCommentRow && withoutCommentRow.verified === 0);
    check(
      'missing comment is stored as NULL',
      withoutCommentRow && withoutCommentRow.registration_comment === null,
      JSON.stringify(withoutCommentRow)
    );

    const withCommentLogin = `withcomment${suffix}`;
    const withComment = await register(
      withCommentLogin,
      '  Меня пригласил Alex.\nПишите в Telegram: @alex  '
    );
    check(
      'registration with a comment succeeds',
      withComment.status === 200 && Boolean(withComment.body.user),
      JSON.stringify(withComment)
    );
    const withCommentRow = db
      .prepare('SELECT verified, registration_comment FROM users WHERE login = ?')
      .get(withCommentLogin);
    check(
      'comment is trimmed and keeps line breaks',
      withCommentRow &&
        withCommentRow.registration_comment === 'Меня пригласил Alex.\nПишите в Telegram: @alex',
      JSON.stringify(withCommentRow)
    );

    const tooLongLogin = `toolong${suffix}`;
    const tooLong = await register(tooLongLogin, 'x'.repeat(501));
    check(
      'comment longer than 500 characters is rejected',
      tooLong.status === 400,
      JSON.stringify(tooLong)
    );

    const nonStringLogin = `nonstring${suffix}`;
    const nonString = await register(nonStringLogin, 42);
    check(
      'non-string comment is rejected',
      nonString.status === 400,
      JSON.stringify(nonString)
    );

    // Disable verification at runtime and register with a stray comment.
    db.prepare('UPDATE verification_settings SET enabled = 0').run();
    const strayLogin = `stray${suffix}`;
    const stray = await register(strayLogin, 'stray-comment');
    check(
      'registration succeeds when verification is off',
      stray.status === 200,
      JSON.stringify(stray)
    );
    const strayUser = db
      .prepare('SELECT verified, registration_comment FROM users WHERE login = ?')
      .get(strayLogin);
    check(
      'a stray comment does not lock the user out or get stored',
      strayUser && strayUser.verified === 1 && strayUser.registration_comment === null,
      JSON.stringify(strayUser)
    );

    const statusOff = await fetch(`${server.baseUrl}/api/verification/status`);
    const statusOffBody = await statusOff.json();
    check('public status reflects disabled verification', statusOffBody.enabled === false);
  } finally {
    serverOutput = await server.stop();
    db.close();
    removeWorkspace(workspace);
  }

  if (serverOutput && /error/i.test(serverOutput)) {
    process.stderr.write(`\nServer output:\n${serverOutput}\n`);
  }

  verify();
});
