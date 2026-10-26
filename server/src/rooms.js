const { deleteRoomData, clearRoomMessages } = require('./dataCleanup');

module.exports = function (fastify) {
  const db = fastify.db;

  fastify.get('/api/rooms', {
    preHandler: [fastify.requireAuth],
  }, async (request) => {
    const userId = request.session.userId;
    const rows = db.prepare(`
      SELECT 
        r.id, 
        r.name, 
        r.created_at,
        (SELECT COUNT(*) FROM messages WHERE room_id = r.id) as message_count,
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
    return { rooms: rows };
  });

  fastify.post('/api/rooms', {
    preHandler: [fastify.requireAuth, fastify.requireOwner],
  }, async (request, reply) => {
    const { name } = request.body || {};
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
    
    // Check if a room with this name already exists
    const existingRoom = db.prepare('SELECT id FROM rooms WHERE name = ?').get(trimmedName);
    if (existingRoom) {
      return reply.code(400).send({ error: 'Room with this name already exists' });
    }
    
    const result = db.prepare('INSERT INTO rooms (name, created_by) VALUES (?, ?)').run(
      trimmedName,
      request.session.userId
    );
    const room = db.prepare('SELECT id, name, created_at FROM rooms WHERE id = ?').get(result.lastInsertRowid);

    // Реалтайм: сообщаем всем клиентам о создании комнаты
    if (fastify.broadcastRoomCreated) {
      const roomWithCount = {
        ...room,
        message_count: 0
      };
      fastify.broadcastRoomCreated(roomWithCount);
    }

    return room;
  });

  fastify.patch('/api/rooms/:id', {
    preHandler: [fastify.requireAuth, fastify.requireOwner],
  }, async (request, reply) => {
    const id = Number(request.params.id);
    const { name } = request.body || {};
    
    // Get the room to check if it's the main room
    const roomToCheck = db.prepare('SELECT id, name FROM rooms WHERE id = ?').get(id);
    if (!roomToCheck) return reply.code(404).send({ error: 'Room not found' });
    
    // Prevent renaming of the 'main' room
    if (roomToCheck.name === 'main') {
      return reply.code(400).send({ error: 'Main room cannot be renamed' });
    }
    
    if (!name) return reply.code(400).send({ error: 'Room name required' });
    
    const trimmedName = String(name).trim();
    
    // Check room name length
    if (trimmedName.length < 1) {
      return reply.code(400).send({ error: 'Room name cannot be empty' });
    }
    if (trimmedName.length > 32) {
      return reply.code(400).send({ error: 'Room name cannot exceed 32 characters' });
    }
    
    // Check if a room with this name already exists (excluding current room)
    const existingRoom = db.prepare('SELECT id FROM rooms WHERE name = ? AND id != ?').get(trimmedName, id);
    if (existingRoom) {
      return reply.code(400).send({ error: 'Room with this name already exists' });
    }
    
    const r = db.prepare('UPDATE rooms SET name = ? WHERE id = ?').run(trimmedName, id);
    if (r.changes === 0) return reply.code(404).send({ error: 'Room not found' });

    const room = db.prepare('SELECT id, name, created_at FROM rooms WHERE id = ?').get(id);

    // Реалтайм: сообщаем всем клиентам об обновлении комнаты
    if (fastify.broadcastRoomUpdated) {
      const messageCountRow = db.prepare('SELECT COUNT(*) as message_count FROM messages WHERE room_id = ?').get(id);
      const roomWithCount = {
        ...room,
        message_count: messageCountRow?.message_count ?? 0
      };
      fastify.broadcastRoomUpdated(roomWithCount);
    }

    return room;
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