const crypto = require('crypto');

const MAX_INVITE_USES = 10000;
const MAX_INVITE_EXPIRY_HOURS = 24 * 365; // one year

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

    let normalizedMaxUses = null;
    if (maxUses !== undefined && maxUses !== null && maxUses !== '') {
      const parsedMaxUses = Number(maxUses);
      if (
        !Number.isInteger(parsedMaxUses) ||
        parsedMaxUses < 1 ||
        parsedMaxUses > MAX_INVITE_USES
      ) {
        return reply.code(400).send({
          error: `maxUses must be an integer between 1 and ${MAX_INVITE_USES}`,
        });
      }
      normalizedMaxUses = parsedMaxUses;
    }

    let expiresAt = null;
    if (expiresInHours !== undefined && expiresInHours !== null && expiresInHours !== '') {
      const parsedHours = Number(expiresInHours);
      if (
        !Number.isFinite(parsedHours) ||
        parsedHours <= 0 ||
        parsedHours > MAX_INVITE_EXPIRY_HOURS
      ) {
        return reply.code(400).send({
          error: `expiresInHours must be between 1 and ${MAX_INVITE_EXPIRY_HOURS}`,
        });
      }
      expiresAt = new Date(Date.now() + parsedHours * 60 * 60 * 1000).toISOString();
    }

    const id = generateInviteId();
    db.prepare(
      'INSERT INTO invites (id, created_by, max_uses, expires_at) VALUES (?, ?, ?, ?)'
    ).run(id, request.session.userId, normalizedMaxUses, expiresAt);
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
