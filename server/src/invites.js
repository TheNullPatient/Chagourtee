const crypto = require('crypto');

function generateInviteId() {
  return crypto.randomBytes(12).toString('hex');
}

module.exports = function (fastify) {
  const db = fastify.db;

  fastify.get('/api/invites', {
    preHandler: [fastify.requireAuth, fastify.requirePermission('manage_invites')],
  }, async () => {
    const rows = db.prepare(`
      SELECT id, created_by, max_uses, uses_count, expires_at, created_at
      FROM invites
      ORDER BY created_at DESC
    `).all();
    return { invites: rows };
  });

  fastify.post('/api/invites', {
    preHandler: [fastify.requireAuth, fastify.requirePermission('manage_invites')],
  }, async (request, reply) => {
    const { maxUses, expiresInHours } = request.body || {};
    const id = generateInviteId();
    let expiresAt = null;
    if (expiresInHours != null && Number(expiresInHours) > 0) {
      expiresAt = new Date(Date.now() + Number(expiresInHours) * 60 * 60 * 1000).toISOString();
    }
    db.prepare(
      'INSERT INTO invites (id, created_by, max_uses, expires_at) VALUES (?, ?, ?, ?)'
    ).run(id, request.session.userId, maxUses ?? null, expiresAt);
    const invite = db.prepare(
      'SELECT id, created_by, max_uses, uses_count, expires_at, created_at FROM invites WHERE id = ?'
    ).get(id);
    
    // Реалтайм: список инвайтов изменился
    if (fastify.broadcastInvitesChanged) {
      fastify.broadcastInvitesChanged();
    }

    return invite;
  });

  fastify.delete('/api/invites/:id', {
    preHandler: [fastify.requireAuth, fastify.requirePermission('manage_invites')],
  }, async (request, reply) => {
    const { id } = request.params;
    const r = db.prepare('DELETE FROM invites WHERE id = ?').run(id);
    if (r.changes === 0) return reply.code(404).send({ error: 'Invite not found' });

    // Реалтайм: список инвайтов изменился
    if (fastify.broadcastInvitesChanged) {
      fastify.broadcastInvitesChanged();
    }

    return { ok: true };
  });
};
