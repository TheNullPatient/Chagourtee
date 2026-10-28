const { deleteRoomData, clearRoomMessages } = require('./dataCleanup');
const {
  DEFAULT_ACCESS_LEVEL,
  isValidAccessLevel,
  normalizeAccessLevel,
  getRoom,
  canViewRoom,
  decorateRoom,
  validateRoomPassword,
  checkRoomPassword,
  hashRoomPassword,
  normalizeMemberIds,
  listRoomMembers,
  replaceRoomMembers,
  clearRoomUnlocks,
  grantRoomUnlock,
  isPrivileged,
} = require('./roomAccess');

// Failed password attempts per user and room: 5 attempts per minute.
const unlockAttempts = new Map(); // `${userId}:${roomId}` -> { count, timestamp }
const UNLOCK_WINDOW_MS = 60 * 1000;
const MAX_UNLOCK_ATTEMPTS = 5;

const unlockCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, record] of unlockAttempts.entries()) {
    if (now - record.timestamp > UNLOCK_WINDOW_MS * 2) {
      unlockAttempts.delete(key);
    }
  }
}, 60 * 1000);
unlockCleanup.unref();

function getRoomSummary(db, roomId, userId) {
  return db
    .prepare(
      `SELECT
         r.id,
         r.name,
         r.created_by,
         r.access_level,
         r.password_hash,
         r.created_at,
         (SELECT COUNT(*) FROM messages WHERE room_id = r.id) as message_count,
         (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) as member_count,
         (
           SELECT COUNT(*)
           FROM messages m
           WHERE m.room_id = r.id
             AND NOT EXISTS (
               SELECT 1
               FROM message_reads mr
               WHERE mr.message_id = m.id AND mr.user_id = ?
             )
         ) AS unread_count
       FROM rooms r
       WHERE r.id = ?`
    )
    .get(userId, roomId);
}

module.exports = function (fastify) {
  const db = fastify.db;

  // Rooms carry per-user fields (unread count, locked state). Never leak one
  // user's values to another user through a broadcast.
  function forBroadcast(room) {
    const {
      unread_count: _unread,
      locked: _locked,
      password_required: _passwordRequired,
      member_only: _memberOnly,
      ...rest
    } = room;
    return rest;
  }

  function broadcastAccessChange(room) {
    if (fastify.broadcastRoomsChanged) {
      fastify.broadcastRoomsChanged();
    }
    if (fastify.broadcastRoomUpdated && room) {
      fastify.broadcastRoomUpdated(forBroadcast(room));
    }
  }

  fastify.get('/api/rooms', {
    preHandler: [fastify.requireAuth],
  }, async (request) => {
    const userId = request.session.userId;
    const user = fastify.getUser(userId);
    const rows = db.prepare(`
      SELECT 
        r.id, 
        r.name, 
        r.created_by,
        r.access_level,
        r.password_hash,
        r.created_at,
        (SELECT COUNT(*) FROM messages WHERE room_id = r.id) as message_count,
        (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) as member_count,
        (
          SELECT COUNT(*)
          FROM messages m
          WHERE m.room_id = r.id
            AND NOT EXISTS (
              SELECT 1 
              FROM message_reads mr 
              WHERE mr.message_id = m.id AND mr.user_id = ?
            )
        ) AS unread_count
      FROM rooms r
      ORDER BY r.created_at ASC
    `).all(userId);

    const visibleRooms = rows
      .filter((room) => canViewRoom(db, room, user))
      .map((room) => decorateRoom(db, room, user));

    return { rooms: visibleRooms };
  });

  fastify.post('/api/rooms', {
    preHandler: [fastify.requireAuth, fastify.requireOwner],
  }, async (request, reply) => {
    const { name, accessLevel, password, memberIds } = request.body || {};
    if (!name || !String(name).trim()) {
      return reply.code(400).send({ error: 'Room name required' });
    }
    
    // Check room name length
    const trimmedName = String(name).trim();
    if (trimmedName.length < 1) {
      return reply.code(400).send({ error: 'Room name cannot be empty' });
    }
    if (trimmedName.length > 32) {
      return reply.code(400).send({ error: 'Room name cannot exceed 32 characters' });
    }

    if (accessLevel !== undefined && !isValidAccessLevel(accessLevel)) {
      return reply.code(400).send({ error: 'Invalid room access level' });
    }
    const level = normalizeAccessLevel(accessLevel, DEFAULT_ACCESS_LEVEL);

    let passwordHash = null;
    if (level === 'closed') {
      const passwordCheck = validateRoomPassword(password);
      if (!passwordCheck.ok) {
        return reply.code(400).send({ error: passwordCheck.error });
      }
      passwordHash = hashRoomPassword(password);
    }

    // Check if a room with this name already exists
    const existingRoom = db.prepare('SELECT id FROM rooms WHERE name = ?').get(trimmedName);
    if (existingRoom) {
      return reply.code(400).send({ error: 'Room with this name already exists' });
    }
    
    const result = db.prepare(
      'INSERT INTO rooms (name, created_by, access_level, password_hash) VALUES (?, ?, ?, ?)'
    ).run(trimmedName, request.session.userId, level, passwordHash);

    if (memberIds !== undefined) {
      const memberResult = replaceRoomMembers(
        db,
        Number(result.lastInsertRowid),
        memberIds,
        request.session.userId
      );
      if (!memberResult.ok) {
        db.prepare('DELETE FROM rooms WHERE id = ?').run(result.lastInsertRowid);
        return reply.code(400).send({
          error: memberResult.error,
          ...(memberResult.missingIds ? { missingIds: memberResult.missingIds } : {}),
        });
      }
    }

    const user = fastify.getUser(request.session.userId);
    const storedRoom = getRoom(db, Number(result.lastInsertRowid));
    const room = {
      ...decorateRoom(db, storedRoom, user),
      message_count: 0,
      unread_count: 0,
      member_count: listRoomMembers(db, storedRoom.id).length,
    };

    // Реалтайм: сообщаем клиентам о создании комнаты. Private rooms are only
    // announced to users who are allowed to see them.
    if (fastify.broadcastRoomCreated) {
      fastify.broadcastRoomCreated(forBroadcast(room));
    }
    if (level !== 'public' && fastify.broadcastRoomsChanged) {
      fastify.broadcastRoomsChanged();
    }

    return room;
  });

  fastify.patch('/api/rooms/:id', {
    preHandler: [fastify.requireAuth, fastify.requireOwner],
  }, async (request, reply) => {
    const id = Number(request.params.id);
    const { name, accessLevel, password, memberIds } = request.body || {};

    const storedRoom = getRoom(db, id);
    if (!storedRoom) return reply.code(404).send({ error: 'Room not found' });

    const isMainRoom = storedRoom.name === 'main';
    const currentLevel = normalizeAccessLevel(storedRoom.access_level);

    // Prevent renaming of the 'main' room
    if (isMainRoom && name !== undefined) {
      return reply.code(400).send({ error: 'Main room cannot be renamed' });
    }

    let trimmedName = storedRoom.name;
    if (name !== undefined) {
      if (!name || !String(name).trim()) {
        return reply.code(400).send({ error: 'Room name required' });
      }
      trimmedName = String(name).trim();
      if (trimmedName.length < 1) {
        return reply.code(400).send({ error: 'Room name cannot be empty' });
      }
      if (trimmedName.length > 32) {
        return reply.code(400).send({ error: 'Room name cannot exceed 32 characters' });
      }

      const existingRoom = db
        .prepare('SELECT id FROM rooms WHERE name = ? AND id != ?')
        .get(trimmedName, id);
      if (existingRoom) {
        return reply.code(400).send({ error: 'Room with this name already exists' });
      }
    }

    if (accessLevel !== undefined && !isValidAccessLevel(accessLevel)) {
      return reply.code(400).send({ error: 'Invalid room access level' });
    }
    const nextLevel =
      accessLevel !== undefined ? normalizeAccessLevel(accessLevel) : currentLevel;

    if (isMainRoom && nextLevel !== 'public') {
      return reply.code(400).send({ error: 'Main room must stay public' });
    }

    let nextPasswordHash = storedRoom.password_hash || null;
    let passwordChanged = false;

    if (password !== undefined) {
      if (password === null || password === '') {
        nextPasswordHash = null;
        passwordChanged = true;
      } else {
        const passwordCheck = validateRoomPassword(password);
        if (!passwordCheck.ok) {
          return reply.code(400).send({ error: passwordCheck.error });
        }
        nextPasswordHash = hashRoomPassword(password);
        passwordChanged = true;
      }
    }

    if (nextLevel !== 'closed') {
      // Passwords and unlocks are meaningless outside closed rooms.
      if (nextPasswordHash) passwordChanged = true;
      nextPasswordHash = null;
    } else if (!nextPasswordHash) {
      return reply.code(400).send({ error: 'Password required for closed rooms' });
    }

    let memberResult = null;
    if (memberIds !== undefined) {
      memberResult = normalizeMemberIds(db, memberIds);
      if (!memberResult.ok) {
        return reply.code(400).send({
          error: memberResult.error,
          ...(memberResult.missingIds ? { missingIds: memberResult.missingIds } : {}),
        });
      }
    }

    const accessChanged =
      nextLevel !== currentLevel || passwordChanged || memberResult !== null;

    const update = db.transaction(() => {
      db.prepare(
        'UPDATE rooms SET name = ?, access_level = ?, password_hash = ? WHERE id = ?'
      ).run(trimmedName, nextLevel, nextPasswordHash, id);

      if (memberResult) {
        replaceRoomMembers(db, id, memberResult.ids, request.session.userId);
      }

      if (passwordChanged || nextLevel !== currentLevel) {
        clearRoomUnlocks(db, id);
      }
    });
    update();

    const user = fastify.getUser(request.session.userId);
    const updated = getRoomSummary(db, id, request.session.userId);
    const room = decorateRoom(db, updated, user);

    if (accessChanged) {
      broadcastAccessChange(room);
    } else if (fastify.broadcastRoomUpdated) {
      fastify.broadcastRoomUpdated(forBroadcast(room));
    }

    return room;
  });

  fastify.get('/api/rooms/:id/members', {
    preHandler: [fastify.requireAuth, fastify.requireOwner],
  }, async (request, reply) => {
    const id = Number(request.params.id);
    const room = getRoom(db, id);
    if (!room) return reply.code(404).send({ error: 'Room not found' });
    return { members: listRoomMembers(db, id) };
  });

  fastify.put('/api/rooms/:id/members', {
    preHandler: [fastify.requireAuth, fastify.requireOwner],
  }, async (request, reply) => {
    const id = Number(request.params.id);
    const { memberIds } = request.body || {};

    const room = getRoom(db, id);
    if (!room) return reply.code(404).send({ error: 'Room not found' });

    const result = replaceRoomMembers(db, id, memberIds, request.session.userId);
    if (!result.ok) {
      return reply.code(400).send({
        error: result.error,
        ...(result.missingIds ? { missingIds: result.missingIds } : {}),
      });
    }

    const user = fastify.getUser(request.session.userId);
    const updated = getRoomSummary(db, id, request.session.userId);
    broadcastAccessChange(decorateRoom(db, updated, user));

    return { ok: true, members: listRoomMembers(db, id) };
  });

  fastify.post('/api/rooms/:id/unlock', {
    preHandler: [fastify.requireAuth],
  }, async (request, reply) => {
    const id = Number(request.params.id);
    const userId = request.session.userId;
    const user = fastify.getUser(userId);
    const room = getRoom(db, id);
    if (!room) return reply.code(404).send({ error: 'Room not found' });
    if (!canViewRoom(db, room, user)) {
      return reply.code(404).send({ error: 'Room not found' });
    }

    const level = normalizeAccessLevel(room.access_level);
    if (level !== 'closed') {
      return reply.code(400).send({ error: 'Room does not require a password' });
    }
    if (isPrivileged(user)) {
      return { ok: true, unlocked: true };
    }

    const key = `${userId}:${id}`;
    const now = Date.now();
    const record = unlockAttempts.get(key) || { count: 0, timestamp: now };
    if (now - record.timestamp > UNLOCK_WINDOW_MS) {
      record.count = 0;
      record.timestamp = now;
    }
    if (record.count >= MAX_UNLOCK_ATTEMPTS) {
      return reply.code(429).send({ error: 'Too many password attempts. Try again later.' });
    }
    record.count += 1;
    unlockAttempts.set(key, record);

    const { password } = request.body || {};
    if (!checkRoomPassword(password, room.password_hash)) {
      return reply.code(401).send({ error: 'Invalid room password' });
    }

    unlockAttempts.delete(key);
    grantRoomUnlock(db, id, userId);

    return { ok: true, unlocked: true };
  });

  fastify.delete('/api/rooms/:id', {
    preHandler: [fastify.requireAuth, fastify.requireOwner],
  }, async (request, reply) => {
    const id = Number(request.params.id);
    
    // Check if this is the main room (assuming main room has id 1 or name 'main')
    const roomToCheck = db.prepare('SELECT id, name FROM rooms WHERE id = ?').get(id);
    if (!roomToCheck) return reply.code(404).send({ error: 'Room not found' });
    
    // Prevent deletion of the 'main' room
    if (roomToCheck.name === 'main') {
      return reply.code(400).send({ error: 'Main room cannot be deleted' });
    }
    
    // Get the room before deletion to broadcast the event
    const roomToDelete = roomToCheck;
    
    let r;
    try {
      r = deleteRoomData(db, id, fastify.log);
    } catch (error) {
      fastify.log.error(`Failed to delete room ${id}:`, error);
      return reply.code(500).send({ error: 'Failed to delete room' });
    }
    if (r.changes === 0) return reply.code(404).send({ error: 'Room not found' });
    
    // Broadcast room deletion to all connected clients
    if (fastify.broadcastRoomDeletion) {
      fastify.broadcastRoomDeletion(id);
    }
    
    return { ok: true };
  });
  
  // New endpoint to clear messages from a room
  fastify.delete('/api/rooms/:id/messages', {
    preHandler: [fastify.requireAuth, fastify.requireOwnerOrModerator],
  }, async (request, reply) => {
    const id = Number(request.params.id);
    
    // Check if room exists
    const room = db.prepare('SELECT id, name FROM rooms WHERE id = ?').get(id);
    if (!room) return reply.code(404).send({ error: 'Room not found' });
    
    // Delete all messages in the room
    let r;
    try {
      r = clearRoomMessages(db, id, fastify.log);
    } catch (error) {
      fastify.log.error(`Failed to clear messages in room ${id}:`, error);
      return reply.code(500).send({ error: 'Failed to clear messages' });
    }

    // Реалтайм: уведомляем всех клиентов в комнате, что сообщения очищены
    if (fastify.broadcastRoomMessagesCleared) {
      fastify.broadcastRoomMessagesCleared(id);
    }
    
    return { ok: true, message: `Cleared ${r.changes} messages from room` };
  });
  
  // Debug endpoint to drop tables (only available in development)
  if (process.env.NODE_ENV === 'development' || process.env.DEBUG_MODE === 'true') {
    fastify.delete('/debug/drop-table/:tableName', {
      preHandler: [fastify.requireAuth, fastify.requireOwner],
    }, async (request, reply) => {
      const tableName = request.params.tableName;
      
      // Validate table name to prevent SQL injection
      const validTables = ['rooms', 'messages', 'users', 'sessions', 'invites', 'verification_codes', 'verification_settings'];
      if (!validTables.includes(tableName)) {
        return reply.code(400).send({ error: 'Invalid table name' });
      }
      
      try {
        // Note: We're using raw SQL with a whitelist, which is safe
        db.prepare(`DROP TABLE IF EXISTS ${tableName}`).run();
        return { ok: true, message: `Table ${tableName} dropped` };
      } catch (error) {
        return reply.code(500).send({ error: error.message });
      }
    });
  }
};
