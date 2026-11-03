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

const workspace = createWorkspace('permissions');
useWorkspace(workspace);

const Fastify = require('fastify');
const { getDb } = require('../src/db');
const { plugin: authPlugin, authRoutes } = require('../src/auth');
const usersPlugin = require('../src/users');
const roomsPlugin = require('../src/rooms');
const invitesPlugin = require('../src/invites');
const settingsPlugin = require('../src/settings');
const verificationPlugin = require('../src/verification');
const { PERMISSIONS, DEFAULT_PERMISSIONS } = require('../src/permissions');

test('granular moderator permissions gate admin endpoints', async () => {
  const { check, verify } = createChecker();
  const db = getDb();

  const owner = seedUser(db, unique('px_owner'), { role: 'owner' });
  const moderator = seedUser(db, unique('px_moderator'), { role: 'moderator' });
  const secondModerator = seedUser(db, unique('px_moderator_b'), { role: 'moderator' });
  const member = seedUser(db, unique('px_member'));
  const promotee = seedUser(db, unique('px_promotee'));
  const disposable = seedUser(db, unique('px_disposable'));

  const permissionEvents = [];
  const roleEvents = [];

  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.decorate('getUser', (id) =>
    db.prepare('SELECT id, login, role, verified FROM users WHERE id = ?').get(id)
  );
  app.decorate('ws', {
    wss: { clients: new Set() },
    userByClient: new Map(),
  });
  app.decorate('broadcastAll', (payload) => permissionEvents.push(payload));
  app.decorate('broadcastUserRoleChanged', (user) => roleEvents.push(user));
  app.decorate('broadcastRoomCreated', () => {});
  app.decorate('broadcastRoomsChanged', () => {});
  app.decorate('broadcastRoomUpdated', () => {});
  app.decorate('broadcastRoomDeletion', () => {});
  app.decorate('broadcastRoomMessagesCleared', () => {});
  app.decorate('broadcastInvitesChanged', () => {});
  app.decorate('broadcastServerSettingsUpdated', () => {});
  app.decorate('broadcastToUser', () => {});
  app.decorate('broadcastVerificationSettingsUpdated', () => {});
  app.decorate('broadcastVerificationCodesChanged', () => {});

  await app.register(authPlugin);
  app.addHook('preHandler', async (request) => {
    const id = Number(request.headers['x-test-user']);
    if (id) request.session = { userId: id };
  });
  authRoutes(app, {}, () => {});
  usersPlugin(app);
  roomsPlugin(app);
  invitesPlugin(app);
  settingsPlugin(app);
  verificationPlugin(app);

  async function request(method, url, userId, payload) {
    return app.inject({
      method,
      url,
      headers: userId
        ? { 'x-test-user': String(userId), 'content-type': 'application/json' }
        : { 'content-type': 'application/json' },
      payload,
    });
  }

  function samePermissions(actual, expected) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((permission) => actual.includes(permission))
    );
  }

  try {
    const anonymous = await request('GET', '/api/users');
    check('anonymous requests stay unauthorized', anonymous.statusCode === 401, anonymous.body);

    const ownerList = await request('GET', '/api/users', owner);
    check('owner can list users', ownerList.statusCode === 200, ownerList.body);
    const ownerRow = ownerList.json().users.find((user) => user.id === owner);
    const moderatorRow = ownerList.json().users.find((user) => user.id === moderator);
    check(
      'the owner is shown with every permission',
      ownerRow &&
        PERMISSIONS.every((permission) => ownerRow.permissions.includes(permission)),
      ownerList.body
    );
    check(
      'a fresh moderator has no permissions',
      moderatorRow &&
        Array.isArray(moderatorRow.permissions) &&
        moderatorRow.permissions.length === 0,
      ownerList.body
    );

    const deniedCreate = await request('POST', '/api/rooms', moderator, {
      name: unique('px_room_denied'),
    });
    check(
      'a moderator without manage_rooms cannot create rooms',
      deniedCreate.statusCode === 403,
      deniedCreate.body
    );

    const deniedInvites = await request('GET', '/api/invites', moderator);
    check(
      'a moderator without manage_invites cannot list invites',
      deniedInvites.statusCode === 403,
      deniedInvites.body
    );

    const deniedServer = await request('POST', '/api/server/settings', moderator, {
      server_name: 'denied',
    });
    check(
      'a moderator without manage_server cannot rename the server',
      deniedServer.statusCode === 403,
      deniedServer.body
    );

    const deniedVerification = await request('GET', '/api/verification/pending', moderator);
    check(
      'a moderator without manage_verification cannot moderate accounts',
      deniedVerification.statusCode === 403,
      deniedVerification.body
    );

    const deniedUsers = await request('GET', '/api/users', member);
    check(
      'members do not receive permission grants in the user list',
      deniedUsers.statusCode === 200 &&
        deniedUsers.json().users.every((user) => user.permissions === undefined),
      deniedUsers.body
    );

    const unknownPermission = await request('PUT', `/api/users/${moderator}/permissions`, owner, {
      permissions: ['launch_missiles'],
    });
    check('unknown permissions are rejected', unknownPermission.statusCode === 400, unknownPermission.body);

    const memberTarget = await request('PUT', `/api/users/${member}/permissions`, owner, {
      permissions: ['manage_rooms'],
    });
    check(
      'permissions can only be assigned to moderators',
      memberTarget.statusCode === 400,
      memberTarget.body
    );

    const ownerTarget = await request('PUT', `/api/users/${owner}/permissions`, owner, {
      permissions: [],
    });
    check('owner permissions are implicit and immutable', ownerTarget.statusCode === 400, ownerTarget.body);

    const initial = await request('GET', `/api/users/${moderator}/permissions`, owner);
    check(
      'the owner can read a moderator permission set',
      initial.statusCode === 200 &&
        initial.json().role === 'moderator' &&
        initial.json().permissions.length === 0,
      initial.body
    );

    const promote = await request('PATCH', `/api/users/${promotee}/role`, owner, {
      role: 'moderator',
    });
    check('the owner can promote a member to moderator', promote.statusCode === 200, promote.body);
    const promotedPermissions = await request(
      'GET',
      `/api/users/${promotee}/permissions`,
      owner
    );
    check(
      'promotion applies the default permissions',
      promotedPermissions.statusCode === 200 &&
        samePermissions(promotedPermissions.json().permissions, DEFAULT_PERMISSIONS),
      promotedPermissions.body
    );

    const grant = await request('PUT', `/api/users/${moderator}/permissions`, owner, {
      permissions: [
        'manage_invites',
        'manage_rooms',
        'manage_users',
        'manage_server',
        'manage_verification',
      ],
    });
    check('the owner can grant permissions', grant.statusCode === 200, grant.body);
    check(
      'the grant response lists effective permissions',
      grant.json().permissions.includes('manage_invites') &&
        grant.json().permissions.includes('manage_rooms') &&
        grant.json().permissions.includes('manage_users') &&
        grant.json().permissions.includes('manage_server') &&
        grant.json().permissions.includes('manage_verification'),
      grant.body
    );
    check(
      'permission changes are broadcast',
      permissionEvents.some(
        (event) =>
          event.type === 'user_permissions_changed' &&
          event.userId === moderator &&
          event.permissions.includes('manage_rooms')
      ),
      JSON.stringify(permissionEvents)
    );

    const me = await request('GET', '/api/auth/me', moderator);
    check(
      'the current-user endpoint exposes effective permissions',
      me.statusCode === 200 &&
        me.json().permissions.includes('manage_rooms') &&
        me.json().permissions.includes('manage_users'),
      me.body
    );

    const inviteList = await request('GET', '/api/invites', moderator);
    check(
      'manage_invites allows a moderator to list invites',
      inviteList.statusCode === 200 && Array.isArray(inviteList.json().invites),
      inviteList.body
    );

    const inviteCreated = await request('POST', '/api/invites', moderator, { maxUses: 1 });
    check(
      'manage_invites allows a moderator to create invites',
      inviteCreated.statusCode === 200 && typeof inviteCreated.json().id === 'string',
      inviteCreated.body
    );

    const inviteDeleted = await request(
      'DELETE',
      `/api/invites/${inviteCreated.json().id}`,
      moderator
    );
    check(
      'manage_invites allows a moderator to delete invites',
      inviteDeleted.statusCode === 200,
      inviteDeleted.body
    );

    const roomName = unique('r');
    const created = await request('POST', '/api/rooms', moderator, { name: roomName });
    check('manage_rooms allows a moderator to create a room', created.statusCode === 200, created.body);
    const roomId = created.json().id;

    const renamed = await request('PATCH', `/api/rooms/${roomId}`, moderator, {
      name: unique('r2'),
    });
    check('manage_rooms allows a moderator to edit a room', renamed.statusCode === 200, renamed.body);

    const members = await request('GET', `/api/rooms/${roomId}/members`, moderator);
    check('manage_rooms allows reading the room access list', members.statusCode === 200, members.body);

    const cleared = await request('DELETE', `/api/rooms/${roomId}/messages`, moderator);
    check(
      'manage_rooms allows clearing room messages',
      cleared.statusCode === 200,
      cleared.body
    );

    const renamedServer = await request('POST', '/api/server/settings', moderator, {
      server_name: 'Managed server',
    });
    check(
      'manage_server allows a moderator to rename the server',
      renamedServer.statusCode === 200,
      renamedServer.body
    );

    const pendingAccounts = await request('GET', '/api/verification/pending', moderator);
    check(
      'manage_verification allows a moderator to view pending accounts',
      pendingAccounts.statusCode === 200,
      pendingAccounts.body
    );

    const promoteMember = await request('PATCH', `/api/users/${member}/role`, moderator, {
      role: 'moderator',
    });
    check(
      'delegated managers still cannot promote users to moderator',
      promoteMember.statusCode === 403,
      promoteMember.body
    );

    const keepMember = await request('PATCH', `/api/users/${member}/role`, moderator, {
      role: 'member',
    });
    check('manage_users allows assigning the member role', keepMember.statusCode === 200, keepMember.body);

    const deleteUser = await request('DELETE', `/api/users/${disposable}`, moderator);
    check('manage_users allows deleting a member', deleteUser.statusCode === 200, deleteUser.body);

    const deniedPermissions = await request(
      'GET',
      `/api/users/${secondModerator}/permissions`,
      moderator
    );
    check(
      'manage_users alone cannot read permission grants',
      deniedPermissions.statusCode === 403,
      deniedPermissions.body
    );

    const grantManage = await request('PUT', `/api/users/${moderator}/permissions`, owner, {
      permissions: [
        'manage_invites',
        'manage_server',
        'manage_rooms',
        'manage_verification',
        'manage_users',
        'manage_permissions',
      ],
    });
    check('the owner can delegate manage_permissions', grantManage.statusCode === 200, grantManage.body);

    const delegatedRead = await request(
      'GET',
      `/api/users/${secondModerator}/permissions`,
      moderator
    );
    check(
      'manage_permissions allows reading other moderators',
      delegatedRead.statusCode === 200,
      delegatedRead.body
    );

    const selfEdit = await request('PUT', `/api/users/${moderator}/permissions`, moderator, {
      permissions: ['manage_rooms'],
    });
    check('delegated managers cannot edit their own permissions', selfEdit.statusCode === 403, selfEdit.body);

    const delegateManage = await request(
      'PUT',
      `/api/users/${secondModerator}/permissions`,
      moderator,
      { permissions: ['manage_rooms', 'manage_permissions'] }
    );
    check(
      'only the owner can hand out manage_permissions',
      delegateManage.statusCode === 403,
      delegateManage.body
    );

    const delegateCreate = await request(
      'PUT',
      `/api/users/${secondModerator}/permissions`,
      moderator,
      { permissions: ['manage_rooms'] }
    );
    check(
      'delegated managers can grant ordinary permissions',
      delegateCreate.statusCode === 200,
      delegateCreate.body
    );

    const delegatedRoom = await request('POST', '/api/rooms', secondModerator, {
      name: unique('r3'),
    });
    check(
      'the newly granted moderator can use the permission',
      delegatedRoom.statusCode === 200,
      delegatedRoom.body
    );

    const deleteRoom = await request('DELETE', `/api/rooms/${roomId}`, moderator);
    check(
      'manage_rooms allows deleting a room',
      deleteRoom.statusCode === 200,
      deleteRoom.body
    );

    const demote = await request('PATCH', `/api/users/${moderator}/role`, owner, { role: 'member' });
    check('the owner can demote a moderator', demote.statusCode === 200, demote.body);
    const storedPermissions = db
      .prepare('SELECT COUNT(*) AS count FROM user_permissions WHERE user_id = ?')
      .get(moderator).count;
    check('demotion clears the permission grants', storedPermissions === 0, String(storedPermissions));

    const roleEvent = roleEvents.find((event) => event.id === moderator);
    check(
      'role changes broadcast the effective permissions',
      roleEvent && Array.isArray(roleEvent.permissions) && roleEvent.permissions.length === 0,
      JSON.stringify(roleEvent)
    );

    const afterDemote = await request('POST', '/api/rooms', moderator, {
      name: unique('px_room_after_demote'),
    });
    check(
      'a demoted moderator loses the delegated permission',
      afterDemote.statusCode === 403,
      afterDemote.body
    );

    const invitesAfterDemote = await request('GET', '/api/invites', moderator);
    check(
      'a demoted moderator loses manage_invites',
      invitesAfterDemote.statusCode === 403,
      invitesAfterDemote.body
    );
  } finally {
    await app.close();
    db.close();
    removeWorkspace(workspace);
  }

  verify();
});
