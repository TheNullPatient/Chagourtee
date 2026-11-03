const { deleteUserData } = require('./dataCleanup');
const {
  DEFAULT_PERMISSIONS,
  clearUserPermissions,
  getEffectivePermissions,
  getUserPermissions,
  hasPermission,
  normalizePermissionList,
  replaceUserPermissions,
} = require('./permissions');

module.exports = function (fastify) {
  const db = fastify.db;

  fastify.get('/api/users/online', {
    preHandler: [fastify.requireAuth],
  }, async () => {
    const onlineUserIds = [];
    for (const [uid, clients] of fastify.ws.clientsByUser.entries()) {
      if (clients.size > 0) onlineUserIds.push(uid);
    }
    return { onlineUserIds };
  });

  fastify.get('/api/users', {
    preHandler: [fastify.requireAuth], // Изменено: теперь любой аутентифицированный пользователь может получить список пользователей
  }, async (request) => {
    const rows = db.prepare(`
      SELECT id, login, role, verified, created_at
      FROM users
      ORDER BY created_at DESC
    `).all();

    // Permission grants are only meaningful to admins who can act on them.
    const includePermissions =
      request.user.role === 'owner' ||
      hasPermission(db, request.user, 'manage_permissions');

    return {
      users: rows.map((user) =>
        includePermissions
          ? { ...user, permissions: getEffectivePermissions(db, user) }
          : user
      ),
    };
  });

  fastify.patch('/api/users/:id/role', {
    preHandler: [fastify.requireAuth, fastify.requirePermission('manage_users')],
  }, async (request, reply) => {
    const userId = Number(request.params.id);
    const { role } = request.body || {};
    if (!['owner', 'moderator', 'member'].includes(role)) {
      return reply.code(400).send({ error: 'Invalid role' });
    }
    const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
    if (!target) return reply.code(404).send({ error: 'User not found' });
    
    // Check if trying to assign owner role
    if (role === 'owner' && request.user.id !== userId) {
      // Only the original owner (who created the first account) can assign owner role
      const firstUser = db.prepare('SELECT id, role FROM users ORDER BY id ASC LIMIT 1').get();
      if (!firstUser || request.user.id !== firstUser.id || firstUser.role !== 'owner') {
        return reply.code(403).send({ error: 'Only the original owner can assign owner role' });
      }
    }
    
    if (target.role === 'owner' && role !== 'owner') {
      return reply.code(403).send({ error: 'Cannot demote owner' });
    }
    
    // Prevent moderators from assigning roles higher than moderator
    if (request.user.role === 'moderator' && role !== 'member') {
      return reply.code(403).send({ error: 'Moderators can only assign member role' });
    }
    
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);

    // Permissions only apply to moderators. Promotion applies the default set,
    // while demotion clears everything so stale capabilities never linger.
    if (target.role !== role) {
      if (role === 'moderator') {
        replaceUserPermissions(db, userId, DEFAULT_PERMISSIONS, request.user.id);
      } else {
        clearUserPermissions(db, userId);
      }
    }

    // Реалтайм: уведомляем клиентов об изменении роли пользователя
    if (fastify.broadcastUserRoleChanged) {
      const updatedUser = db.prepare(
        'SELECT id, login, role, verified, created_at FROM users WHERE id = ?'
      ).get(userId);
      if (updatedUser) {
        fastify.broadcastUserRoleChanged({
          ...updatedUser,
          permissions: getEffectivePermissions(db, updatedUser),
        });
      }
    }

    return { ok: true };
  });

  fastify.delete('/api/users/:id', {
    preHandler: [fastify.requireAuth, fastify.requirePermission('manage_users')],
  }, async (request, reply) => {
    const userId = Number(request.params.id);
    const reason = request.body?.reason || 'Account removed by administrator';
    const target = db.prepare('SELECT id, role, login FROM users WHERE id = ?').get(userId);
    if (!target) return reply.code(404).send({ error: 'User not found' });
    if (target.role === 'owner') {
      return reply.code(403).send({ error: 'Cannot delete owner' });
    }
    if (userId === request.user.id) {
      return reply.code(403).send({ error: 'Cannot delete yourself' });
    }
    
    try {
      deleteUserData(db, userId, fastify.log);
    } catch (error) {
      fastify.log.error(`Failed to delete user ${userId}:`, error);
      return reply.code(500).send({ error: 'Failed to delete user' });
    }

    // Broadcast user deletion to all connected clients for this user
    const wsServer = fastify.ws.wss;
    if (wsServer) {
      const payload = {
        type: 'user_deleted',
        userId: userId,
        reason: reason
      };
      
      wsServer.clients.forEach((client) => {
        // Get the user ID associated with this WebSocket connection
        const clientId = fastify.ws.userByClient.get(client);
        if (client.readyState === 1 /* WebSocket.OPEN */ && clientId === userId) {
          client.send(JSON.stringify(payload));
        }
      });
    }

    // Реалтайм: уведомляем админку/клиентов об изменении списка пользователей
    if (fastify.broadcastAll) {
      fastify.broadcastAll({
        type: 'user_deleted_admin',
        userId
      });
    }

    return { ok: true };
  });

  fastify.get('/api/users/:id/permissions', {
    preHandler: [fastify.requireAuth, fastify.requirePermission('manage_permissions')],
  }, async (request, reply) => {
    const userId = Number(request.params.id);
    const target = db.prepare('SELECT id, login, role FROM users WHERE id = ?').get(userId);
    if (!target) return reply.code(404).send({ error: 'User not found' });

    return {
      userId: target.id,
      role: target.role,
      permissions: getUserPermissions(db, target.id),
      effective: getEffectivePermissions(db, target),
    };
  });

  fastify.put('/api/users/:id/permissions', {
    preHandler: [fastify.requireAuth, fastify.requirePermission('manage_permissions')],
  }, async (request, reply) => {
    const userId = Number(request.params.id);
    const normalized = normalizePermissionList(request.body?.permissions);
    if (!normalized.ok) {
      return reply.code(400).send({ error: normalized.error });
    }

    const target = db.prepare('SELECT id, login, role FROM users WHERE id = ?').get(userId);
    if (!target) return reply.code(404).send({ error: 'User not found' });
    if (target.role === 'owner') {
      return reply.code(400).send({ error: 'Owner permissions cannot be changed' });
    }
    if (target.role !== 'moderator') {
      return reply.code(400).send({ error: 'Permissions can only be assigned to moderators' });
    }

    const actor = request.user;
    const current = getUserPermissions(db, target.id);

    // Delegated managers may not edit themselves or hand out the power to
    // manage permissions. Only the owner can do that.
    if (actor.role !== 'owner') {
      if (actor.id === target.id) {
        return reply.code(403).send({ error: 'Cannot change your own permissions' });
      }
      const changesManagePermissions =
        current.includes('manage_permissions') !==
        normalized.permissions.includes('manage_permissions');
      if (changesManagePermissions) {
        return reply.code(403).send({
          error: 'Only the owner can change manage_permissions',
        });
      }
    }

    replaceUserPermissions(db, target.id, normalized.permissions, actor.id);

    const effective = getEffectivePermissions(db, target);

    if (fastify.broadcastAll) {
      fastify.broadcastAll({
        type: 'user_permissions_changed',
        userId: target.id,
        permissions: effective,
      });
    }

    return { ok: true, userId: target.id, permissions: effective };
  });
};