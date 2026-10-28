const { verifyPassword, hashPassword } = require('./auth');
const { deleteUserData } = require('./dataCleanup');
const crypto = require('crypto');

const CODE_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const codeAttempts = new Map();

const codeAttemptCleanup = setInterval(() => {
  const now = Date.now();
  for (const [userId, record] of codeAttempts) {
    if (record.resetAt <= now) {
      codeAttempts.delete(userId);
    }
  }
}, 60 * 1000);
if (typeof codeAttemptCleanup.unref === 'function') {
  codeAttemptCleanup.unref();
}

function getCodeAttemptRecord(userId) {
  const now = Date.now();
  const record = codeAttempts.get(userId);
  if (!record || record.resetAt <= now) {
    return { count: 0, resetAt: now + CODE_ATTEMPT_WINDOW_MS };
  }
  return record;
}

function registerFailedCodeAttempt(userId) {
  const record = getCodeAttemptRecord(userId);
  record.count += 1;
  codeAttempts.set(userId, record);
  return record;
}

module.exports = function (fastify) {
  const db = fastify.db;

  // Public endpoint: the registration page needs to know whether a codeword
  // is required before the user has a session.
  fastify.get('/api/verification/status', async () => {
    const setting = db.prepare('SELECT enabled FROM verification_settings LIMIT 1').get();
    return { enabled: setting ? !!setting.enabled : false };
  });

  // Проверяем, включена ли система верификации
  fastify.get('/api/verification/settings', {
    preHandler: [fastify.requireAuth, fastify.requireOwnerOrModerator],
  }, async () => {
    const setting = db.prepare('SELECT enabled, delete_comment_on_approve FROM verification_settings LIMIT 1').get();
    return {
      enabled: setting ? !!setting.enabled : false,
      deleteCommentOnApprove: setting ? !!setting.delete_comment_on_approve : false,
    };
  });

  // Включить/выключить систему верификации
  fastify.post('/api/verification/settings', {
    preHandler: [fastify.requireAuth, fastify.requireOwner],
  }, async (request, reply) => {
    const { enabled, deleteCommentOnApprove } = request.body || {};
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return reply.code(400).send({ error: 'enabled must be boolean' });
    }
    if (deleteCommentOnApprove !== undefined && typeof deleteCommentOnApprove !== 'boolean') {
      return reply.code(400).send({ error: 'deleteCommentOnApprove must be boolean' });
    }
    if (enabled === undefined && deleteCommentOnApprove === undefined) {
      return reply.code(400).send({ error: 'No settings provided' });
    }

    const current = db
      .prepare('SELECT id, enabled, delete_comment_on_approve FROM verification_settings LIMIT 1')
      .get();
    const nextEnabled = enabled === undefined ? !!(current && current.enabled) : enabled;
    const nextDeleteComment =
      deleteCommentOnApprove === undefined
        ? !!(current && current.delete_comment_on_approve)
        : deleteCommentOnApprove;

    if (current) {
      db.prepare(
        "UPDATE verification_settings SET enabled = ?, delete_comment_on_approve = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(nextEnabled ? 1 : 0, nextDeleteComment ? 1 : 0, current.id);
    } else {
      db.prepare(
        'INSERT INTO verification_settings (enabled, delete_comment_on_approve) VALUES (?, ?)'
      ).run(nextEnabled ? 1 : 0, nextDeleteComment ? 1 : 0);
    }

    // Реалтайм: уведомляем всех о смене настроек верификации
    if (fastify.broadcastVerificationSettingsUpdated) {
      fastify.broadcastVerificationSettingsUpdated(nextEnabled, nextDeleteComment);
    }

    return { ok: true, enabled: nextEnabled, deleteCommentOnApprove: nextDeleteComment };
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
      SELECT id, login, created_at, registration_comment
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

    if (expiresAt !== undefined && (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt)))) {
      return reply.code(400).send({ error: 'expiresAt must be a valid date' });
    }

    // Генерируем код или используем предоставленный пользовательский
    let rawCode;
    if (customCode !== undefined && customCode !== null && customCode !== '') {
      if (typeof customCode !== 'string') {
        return reply.code(400).send({ error: 'code must be a string' });
      }
      rawCode = customCode.trim();
      if (rawCode.length === 0 || rawCode.length > 128) {
        return reply.code(400).send({ error: 'code must be between 1 and 128 characters' });
      }
    } else {
      rawCode = crypto.randomBytes(8).toString('hex'); // генерируем случайный код
    }

    const codeHash = hashPassword(rawCode);
    const expiresAtValue = expiresAt || new Date(now.getTime() + 24*60*60*1000).toISOString();

    const result = db.prepare(`
      INSERT INTO verification_codes (code_hash, created_by, expires_at)
      VALUES (?, ?, ?)
    `).run(codeHash, request.session.userId, expiresAtValue);
    
    const response = {
      id: result.lastInsertRowid,
      code: rawCode, // Отправляем нехэшированный код клиенту
      created_by: request.session.userId,
      expires_at: expiresAtValue
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
  fastify.post('/api/verification/codes/use', {
    preHandler: [fastify.requireAuth],
  }, async (request, reply) => {
    const setting = db.prepare('SELECT enabled FROM verification_settings LIMIT 1').get();
    if (!setting || !setting.enabled) {
      return reply.code(400).send({ error: 'Verification system is disabled' });
    }

    const userId = request.session.userId;
    const currentUser = fastify.getUser(userId);
    if (!currentUser) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    if (currentUser.verified) {
      return { ok: true, alreadyVerified: true };
    }

    const { code } = request.body || {};
    if (typeof code !== 'string' || code.length === 0 || code.length > 128) {
      return reply.code(400).send({ error: 'Code must be between 1 and 128 characters' });
    }

    const attempt = getCodeAttemptRecord(userId);
    if (attempt.count >= MAX_CODE_ATTEMPTS) {
      const retryAfter = Math.max(1, Math.ceil((attempt.resetAt - Date.now()) / 1000));
      return reply
        .code(429)
        .header('Retry-After', String(retryAfter))
        .send({ error: 'Too many verification attempts. Try again later.' });
    }

    // Records the failed attempt and returns the reusable error response
    const rejectAttempt = (message) => {
      registerFailedCodeAttempt(userId);
      return reply.code(400).send({ ok: false, message });
    };

    const codeRows = db.prepare(`
      SELECT id, code_hash, expires_at
      FROM verification_codes
      WHERE used = 0
      ORDER BY created_at DESC
    `).all();

    // Bcrypt hashes are salted, so every candidate has to be compared.
    // Attempts are rate limited above to keep this loop bounded.
    let matchedCode = null;
    for (const record of codeRows) {
      let matches = false;
      try {
        matches = verifyPassword(code, record.code_hash);
      } catch {
        matches = false;
      }
      if (matches) {
        matchedCode = record;
        break;
      }
    }

    if (!matchedCode) {
      return rejectAttempt('Invalid or expired code');
    }

    // Проверяем срок действия
    const expiresAtMs = Date.parse(matchedCode.expires_at);
    if (!Number.isFinite(expiresAtMs) || Date.now() > expiresAtMs) {
      return rejectAttempt('Code has expired');
    }

    // Помечаем код использованным и верифицируем пользователя атомарно
    const consumed = db.transaction(() => {
      const markUsed = db
        .prepare('UPDATE verification_codes SET used = 1 WHERE id = ? AND used = 0')
        .run(matchedCode.id);
      if (markUsed.changes === 0) return false;
      db.prepare('UPDATE users SET verified = 1 WHERE id = ?').run(userId);
      return true;
    })();

    if (!consumed) {
      return rejectAttempt('Invalid or expired code');
    }

    codeAttempts.delete(userId);

    if (fastify.broadcastToUser) {
      fastify.broadcastToUser(userId, {
        type: 'user_verified',
        userId,
      });
    }

    if (fastify.broadcastAll) {
      const updatedUser = db
        .prepare('SELECT id, login, role, verified, created_at FROM users WHERE id = ?')
        .get(userId);
      if (updatedUser) {
        fastify.broadcastAll({
          type: 'user_verification_changed',
          user: updatedUser,
        });
      }
    }

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
    if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) {
      return reply.code(400).send({ error: 'New expiration date (expiresAt) required' });
    }

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