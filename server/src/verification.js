const { verifyPassword, hashPassword } = require('./auth');
const { deleteUserData } = require('./dataCleanup');
const crypto = require('crypto');

module.exports = function (fastify) {
  const db = fastify.db;

  // Проверяем, включена ли система верификации
  fastify.get('/api/verification/settings', {
    preHandler: [fastify.requireAuth, fastify.requireOwnerOrModerator],
  }, async () => {
    const setting = db.prepare('SELECT enabled FROM verification_settings LIMIT 1').get();
    return { enabled: setting ? !!setting.enabled : false };
  });

  // Включить/выключить систему верификации
  fastify.post('/api/verification/settings', {
    preHandler: [fastify.requireAuth, fastify.requireOwner],
  }, async (request, reply) => {
    const { enabled } = request.body || {};
    if (typeof enabled !== 'boolean') {
      return reply.code(400).send({ error: 'enabled must be boolean' });
    }

    // Удаляем старую запись, если существует
    db.prepare('DELETE FROM verification_settings').run();
    // Создаем новую запись
    db.prepare('INSERT INTO verification_settings (enabled) VALUES (?)').run(enabled ? 1 : 0);

    // Реалтайм: уведомляем всех о смене настроек верификации
    if (fastify.broadcastVerificationSettingsUpdated) {
      fastify.broadcastVerificationSettingsUpdated(enabled);
    }

    return { ok: true, enabled };
  });

  // Получить список ожидающих верификации пользователей
  fastify.get('/api/verification/pending', {
    preHandler: [fastify.requireAuth, fastify.requireOwnerOrModerator],
  }, async () => {
    const setting = db.prepare('SELECT enabled FROM verification_settings LIMIT 1').get();
    if (!setting || !setting.enabled) {
      // Если верификация отключена, возвращаем пустой массив
      return { pending: [] };
    }
    
    const rows = db.prepare(`
      SELECT id, login, created_at
      FROM users
      WHERE verified = 0 AND role = 'member'
      ORDER BY created_at ASC
    `).all();
    return { pending: rows };
  });

  // Проверка кодового слова для конкретного пользователя (для ручной верификации)
  fastify.post('/api/verification/check', {
    preHandler: [fastify.requireAuth, fastify.requireOwnerOrModerator],
  }, async (request, reply) => {
    const setting = db.prepare('SELECT enabled FROM verification_settings LIMIT 1').get();
    if (!setting || !setting.enabled) {
      return reply.code(400).send({ error: 'Verification system is disabled' });
    }
    
    const { userId, codeword } = request.body || {};
    if (!userId || codeword === undefined) {
      return reply.code(400).send({ error: 'userId and codeword required' });
    }
    const user = db.prepare('SELECT id, codeword_hash FROM users WHERE id = ? AND verified = 0').get(Number(userId));
    if (!user) return reply.code(404).send({ error: 'User not found or already verified' });
    if (!user.codeword_hash) {
      return { match: false, message: 'User has no codeword set' };
    }
    const match = verifyPassword(codeword, user.codeword_hash);
    return { match };
  });

  // Одобрение пользователя (ручная верификация)
  fastify.post('/api/verification/approve', {
    preHandler: [fastify.requireAuth, fastify.requireOwnerOrModerator],
  }, async (request, reply) => {
    const setting = db.prepare('SELECT enabled FROM verification_settings LIMIT 1').get();
    if (!setting || !setting.enabled) {
      return reply.code(400).send({ error: 'Verification system is disabled' });
    }
    
    const { userId } = request.body || {};
    if (!userId) return reply.code(400).send({ error: 'userId required' });
    const r = db.prepare('UPDATE users SET verified = 1 WHERE id = ? AND verified = 0').run(Number(userId));
    if (r.changes === 0) return reply.code(404).send({ error: 'User not found or already verified' });
    
    // Broadcast user verification to the user
    fastify.broadcastToUser(Number(userId), {
      type: 'user_verified',
      userId: Number(userId)
    });

    // Реалтайм: обновляем списки пользователей/ожидающих
    if (fastify.broadcastAll) {
      const updatedUser = db.prepare('SELECT id, login, role, verified, created_at FROM users WHERE id = ?').get(Number(userId));
      if (updatedUser) {
        fastify.broadcastAll({
          type: 'user_verification_changed',
          user: updatedUser
        });
      }
    }
    
    return { ok: true };
  });

  // Отклонение пользователя
  fastify.post('/api/verification/reject', {
    preHandler: [fastify.requireAuth, fastify.requireOwnerOrModerator],
  }, async (request, reply) => {
    const setting = db.prepare('SELECT enabled FROM verification_settings LIMIT 1').get();
    if (!setting || !setting.enabled) {
      return reply.code(400).send({ error: 'Verification system is disabled' });
    }
    
    const { userId } = request.body || {};
    if (!userId) return reply.code(400).send({ error: 'userId required' });
    const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(Number(userId));
    if (!target) return reply.code(404).send({ error: 'User not found' });
    if (target.role === 'owner') return reply.code(403).send({ error: 'Cannot reject owner' });
    
    try {
      deleteUserData(db, Number(userId), fastify.log);
    } catch (error) {
      fastify.log.error(`Failed to reject user ${userId}:`, error);
      return reply.code(500).send({ error: 'Failed to reject user' });
    }

    // Broadcast user rejection to the user
    fastify.broadcastToUser(Number(userId), {
      type: 'user_rejected',
      userId: Number(userId),
      message: 'Your account has been rejected by an administrator.'
    });

    // Реалтайм: список пользователей изменился
    if (fastify.broadcastAll) {
      fastify.broadcastAll({
        type: 'user_deleted_admin',
        userId: Number(userId)
      });
    }

    return { ok: true };
  });

  // Создание одноразового кода верификации
  fastify.post('/api/verification/codes', {
    preHandler: [fastify.requireAuth, fastify.requireOwnerOrModerator],
  }, async (request, reply) => {
    const setting = db.prepare('SELECT enabled FROM verification_settings LIMIT 1').get();
    if (!setting || !setting.enabled) {
      return reply.code(400).send({ error: 'Verification system is disabled' });
    }

    const { expiresAt, code: customCode } = request.body || {};
    const now = new Date();
    
    // Генерируем код или используем предоставленный пользовательский
    let rawCode;
    if (customCode && typeof customCode === 'string' && customCode.trim().length > 0) {
      rawCode = customCode.trim();
    } else {
      rawCode = crypto.randomBytes(8).toString('hex'); // генерируем случайный код
    }
    
    // Проверяем, не существует ли уже такой код
    const existingCode = db.prepare('SELECT id FROM verification_codes WHERE code_hash = ? AND used = 0').get(hashPassword(rawCode));
    if (existingCode) {
      return reply.code(409).send({ error: 'Code already exists and is unused' });
    }
    
    const codeHash = hashPassword(rawCode);
    
    const result = db.prepare(`
      INSERT INTO verification_codes (code_hash, created_by, expires_at)
      VALUES (?, ?, ?)
    `).run(codeHash, request.session.userId, expiresAt || new Date(now.getTime() + 24*60*60*1000).toISOString());
    
    const response = {
      id: result.lastInsertRowid,
      code: rawCode, // Отправляем нехэшированный код клиенту
      created_by: request.session.userId,
      expires_at: expiresAt || new Date(now.getTime() + 24*60*60*1000).toISOString()
    };

    // Реалтайм: список кодов изменился
    if (fastify.broadcastVerificationCodesChanged) {
      fastify.broadcastVerificationCodesChanged();
    }

    return response;
  });

  // Получение списка одноразовых кодов верификации
  fastify.get('/api/verification/codes', {
    preHandler: [fastify.requireAuth, fastify.requireOwnerOrModerator],
  }, async (request, reply) => {
    const setting = db.prepare('SELECT enabled FROM verification_settings LIMIT 1').get();
    if (!setting || !setting.enabled) {
      return reply.code(400).send({ error: 'Verification system is disabled' });
    }

    const rows = db.prepare(`
      SELECT vc.id, u.login as created_by_login, vc.used, vc.created_at, vc.expires_at
      FROM verification_codes vc
      JOIN users u ON vc.created_by = u.id
      ORDER BY vc.created_at DESC
    `).all();

    return { codes: rows };
  });

  // Использование одноразового кода верификации
  fastify.post('/api/verification/codes/use', async (request, reply) => {
    const setting = db.prepare('SELECT enabled FROM verification_settings LIMIT 1').get();
    if (!setting || !setting.enabled) {
      return reply.code(400).send({ error: 'Verification system is disabled' });
    }

    const { code } = request.body || {};
    if (!code) {
      return reply.code(400).send({ error: 'Code required' });
    }

    const codeRecord = db.prepare(`
      SELECT id, code_hash, used, expires_at
      FROM verification_codes
      WHERE used = 0
    `).all();

    // Проверяем каждый код на совпадение
    let matchedCode = null;
    for (const record of codeRecord) {
      if (verifyPassword(code, record.code_hash)) {
        matchedCode = record;
        break;
      }
    }

    if (!matchedCode) {
      return reply.code(400).send({ 
        ok: false, 
        message: 'Invalid or expired code' 
      });
    }

    // Проверяем срок действия
    if (new Date() > new Date(matchedCode.expires_at)) {
      return reply.code(400).send({ 
        ok: false, 
        message: 'Code has expired' 
      });
    }

    // Помечаем код как использованный
    db.prepare('UPDATE verification_codes SET used = 1 WHERE id = ?').run(matchedCode.id);

    // Обновляем статус текущего пользователя на верифицированного
    db.prepare('UPDATE users SET verified = 1 WHERE id = ?').run(request.session.userId);

    return { ok: true };
  });

  // Удаление одноразового кода верификации
  fastify.delete('/api/verification/codes/:id', {
    preHandler: [fastify.requireAuth, fastify.requireOwnerOrModerator],
  }, async (request, reply) => {
    const setting = db.prepare('SELECT enabled FROM verification_settings LIMIT 1').get();
    if (!setting || !setting.enabled) {
      return reply.code(400).send({ error: 'Verification system is disabled' });
    }

    const { id } = request.params || {};
    if (!id) return reply.code(400).send({ error: 'id required' });

    const result = db.prepare('DELETE FROM verification_codes WHERE id = ?').run(Number(id));
    if (result.changes === 0) return reply.code(404).send({ error: 'Code not found' });

    // Реалтайм: список кодов изменился
    if (fastify.broadcastVerificationCodesChanged) {
      fastify.broadcastVerificationCodesChanged();
    }

    return { ok: true };
  });
  
  // Обновление одноразового кода верификации (пока только продление срока действия)
  fastify.patch('/api/verification/codes/:id', {
    preHandler: [fastify.requireAuth, fastify.requireOwnerOrModerator],
  }, async (request, reply) => {
    const setting = db.prepare('SELECT enabled FROM verification_settings LIMIT 1').get();
    if (!setting || !setting.enabled) {
      return reply.code(400).send({ error: 'Verification system is disabled' });
    }

    const { id } = request.params || {};
    const { expiresAt } = request.body || {};
    
    if (!id) return reply.code(400).send({ error: 'id required' });
    if (!expiresAt) return reply.code(400).send({ error: 'New expiration date (expiresAt) required' });

    // Проверяем, существует ли код
    const code = db.prepare('SELECT * FROM verification_codes WHERE id = ?').get(Number(id));
    if (!code) return reply.code(404).send({ error: 'Code not found' });
    
    // Обновляем срок действия
    const result = db.prepare('UPDATE verification_codes SET expires_at = ? WHERE id = ?')
      .run(expiresAt, Number(id));
      
    if (result.changes === 0) return reply.code(404).send({ error: 'Failed to update code' });

    // Реалтайм: список кодов обновлён
    if (fastify.broadcastVerificationCodesChanged) {
      fastify.broadcastVerificationCodesChanged();
    }

    return { ok: true, id: Number(id), expires_at: expiresAt };
  });

};