module.exports = function (fastify) {
  const db = fastify.db;

  // Get current server settings (public, no auth required)
  fastify.get('/api/server/settings', async () => {
    const row = db.prepare('SELECT name FROM server_settings WHERE id = 1').get();
    return { 
      server_name: row ? row.name : null
    };
  });

  // Update server settings (requires manage_server)
  fastify.post('/api/server/settings', {
    preHandler: [fastify.requireAuth, fastify.requirePermission('manage_server')],
  }, async (request, reply) => {
    const { server_name } = request.body || {};
    
    // Validate and sanitize inputs
    if (server_name !== undefined && server_name !== null && typeof server_name !== 'string') {
      return reply.code(400).send({ error: 'Server name must be a string' });
    }
    const rawName = typeof server_name === 'string' ? server_name : '';
    const trimmedName = rawName.trim();

    if (trimmedName.length > 100) {
      return reply.code(400).send({ error: 'Server name too long' });
    }

    const existing = db.prepare('SELECT id FROM server_settings WHERE id = 1').get();
    const now = new Date().toISOString();

    if (existing) {
      db.prepare('UPDATE server_settings SET name = ?, updated_at = ? WHERE id = 1')
        .run(trimmedName || null, now);
    } else {
      db.prepare('INSERT INTO server_settings (id, name, created_at, updated_at) VALUES (1, ?, ?, ?)')
        .run(trimmedName || null, now, now);
    }

    // Получаем обновленные настройки для отправки
    const updatedSettings = { 
      server_name: trimmedName || null
    };

    // Реалтайм: сообщаем всем клиентам об обновлении настроек сервера
    if (fastify.broadcastServerSettingsUpdated) {
      fastify.broadcastServerSettingsUpdated(updatedSettings);
    }

    return updatedSettings;
  });
};