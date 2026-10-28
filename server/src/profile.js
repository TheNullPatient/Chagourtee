const { hashPassword, verifyPassword } = require('./auth');

module.exports = function (fastify) {
  const db = fastify.db;

  fastify.post('/api/profile/change-password', {
    preHandler: [fastify.requireAuth],
  }, async (request, reply) => {
    const { currentPassword, newPassword } = request.body || {};
    if (!currentPassword || !newPassword) {
      return reply.code(400).send({ error: 'Current and new password required' });
    }
    if (String(newPassword).length < 6) {
      return reply.code(400).send({ error: 'New password too short' });
    }
    const user = db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(request.session.userId);
    if (!user || !verifyPassword(currentPassword, user.password_hash)) {
      return reply.code(401).send({ error: 'Current password is wrong' });
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), user.id);
    return { ok: true };
  });

  fastify.post('/api/profile/change-login', {
    preHandler: [fastify.requireAuth],
  }, async (request, reply) => {
    const { password, newLogin } = request.body || {};
    if (!password || !newLogin) {
      return reply.code(400).send({ error: 'Password and new login required' });
    }
    const newLoginTrim = String(newLogin).trim();
    
    // Validate new login format: only alphanumeric characters, length between 2 and 32
    if (!/^[a-zA-Z0-9]{2,32}$/.test(newLoginTrim)) {
      return reply.code(400).send({ error: 'Login must be 2-32 characters long and contain only letters and numbers' });
    }
    
    const user = db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(request.session.userId);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return reply.code(401).send({ error: 'Password is wrong' });
    }
    const existing = db.prepare('SELECT id FROM users WHERE login = ?').get(newLoginTrim);
    if (existing) return reply.code(400).send({ error: 'Login already taken' });
    db.prepare('UPDATE users SET login = ? WHERE id = ?').run(newLoginTrim, user.id);

    // Реалтайм: уведомляем о смене логина
    if (fastify.broadcastUserUpdated) {
      const updatedUser = db.prepare('SELECT id, login, role, verified, created_at FROM users WHERE id = ?').get(user.id);
      if (updatedUser) {
        fastify.broadcastUserUpdated(updatedUser);
      }
    }

    return { ok: true, login: newLoginTrim };
  });

  // Pending users may refine the note the owner sees in the verification queue.
  fastify.get('/api/profile/registration-comment', {
    preHandler: [fastify.requireAuth],
  }, async (request, reply) => {
    const user = db
      .prepare('SELECT id, verified, role, registration_comment FROM users WHERE id = ?')
      .get(request.session.userId);
    if (!user) return reply.code(401).send({ error: 'Unauthorized' });
    if (user.verified || user.role !== 'member') {
      return reply.code(400).send({ error: 'Account is already verified' });
    }
    return { comment: user.registration_comment ?? null };
  });

  fastify.patch('/api/profile/registration-comment', {
    preHandler: [fastify.requireAuth],
  }, async (request, reply) => {
    const { comment } = request.body || {};
    if (comment !== null && comment !== undefined && typeof comment !== 'string') {
      return reply.code(400).send({ error: 'Comment must be a string' });
    }

    const user = db
      .prepare('SELECT id, verified, role FROM users WHERE id = ?')
      .get(request.session.userId);
    if (!user) return reply.code(401).send({ error: 'Unauthorized' });
    if (user.verified || user.role !== 'member') {
      return reply.code(400).send({ error: 'Account is already verified' });
    }

    const trimmed = typeof comment === 'string' ? comment.trim() : '';
    if (trimmed.length > 500) {
      return reply.code(400).send({ error: 'Comment must not exceed 500 characters' });
    }

    db.prepare('UPDATE users SET registration_comment = ? WHERE id = ?').run(
      trimmed.length > 0 ? trimmed : null,
      user.id
    );
    return { ok: true, comment: trimmed.length > 0 ? trimmed : null };
  });
};
