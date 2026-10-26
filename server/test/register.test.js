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

test('registration requires a codeword when verification is enabled', async () => {
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

  async function register(login, codeword) {
    const response = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inviteId, login, password: 'secret123', codeword }),
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

    const noCodewordLogin = `nocw${suffix}`;
    const noCodeword = await register(noCodewordLogin, undefined);
    check(
      'registration without a codeword is rejected when verification is on',
      noCodeword.status === 400,
      JSON.stringify(noCodeword)
    );

    const withCodewordLogin = `withcw${suffix}`;
    const withCodeword = await register(withCodewordLogin, 'my-codeword');
    check(
      'registration with a codeword succeeds',
      withCodeword.status === 200 && Boolean(withCodeword.body.user),
      JSON.stringify(withCodeword)
    );
    const created = db
      .prepare('SELECT verified, codeword_hash FROM users WHERE login = ?')
      .get(withCodewordLogin);
    check('new user is unverified when verification is on', created && created.verified === 0);
    check(
      'codeword is stored hashed',
      created && Boolean(created.codeword_hash) && created.codeword_hash !== 'my-codeword'
    );

    // Disable verification at runtime and register with a stray codeword.
    db.prepare('UPDATE verification_settings SET enabled = 0').run();
    const strayLogin = `stray${suffix}`;
    const stray = await register(strayLogin, 'stray-codeword');
    check(
      'registration succeeds when verification is off',
      stray.status === 200,
      JSON.stringify(stray)
    );
    const strayUser = db
      .prepare('SELECT verified, codeword_hash FROM users WHERE login = ?')
      .get(strayLogin);
    check(
      'a stray codeword does not lock the user out',
      strayUser && strayUser.verified === 1 && strayUser.codeword_hash === null,
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
