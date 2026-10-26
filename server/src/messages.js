const { isOwnerOrModerator } = require('./auth');
const { collectMediaForMessages, removeMediaFiles } = require('./dataCleanup');

// Rate limiting store - keeps track of user message counts
const rateLimitStore = new Map(); // userId -> { count: number, timestamp: number }
const RATE_LIMIT_WINDOW = 10000; // 10 seconds window
const MAX_MESSAGES_PER_WINDOW = 5; // Max 5 messages per window

// Cleanup old rate limit entries periodically
const rateLimitCleanup = setInterval(() => {
  const now = Date.now();
  for (const [userId, record] of rateLimitStore.entries()) {
    // If the record is older than 2 windows, remove it
    if (now - record.timestamp > RATE_LIMIT_WINDOW * 2) {
      rateLimitStore.delete(userId);
    }
  }
}, 30000); // Clean up every 30 seconds
rateLimitCleanup.unref();

module.exports = function (fastify) {
  const db = fastify.db;

  fastify.get('/api/rooms/:roomId/messages', {
    preHandler: [fastify.requireAuth],
  }, async (request, reply) => {
    const roomId = Number(request.params.roomId);
    const limit = Math.min(Number(request.query.limit) || 50, 100);
    const before = request.query.before;

    const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(roomId);
    if (!room) return reply.code(404).send({ error: 'Room not found' });

    const userId = request.session.userId;

    let rows;
    if (before) {
      rows = db.prepare(`
        SELECT m.id, m.room_id, m.user_id, m.body, m.media_position as mediaPosition, m.created_at, m.updated_at, u.login,
               CASE WHEN mr.user_id IS NULL THEN 0 ELSE 1 END AS is_read,
               mf.id as media_id, mf.original_name, mf.encrypted_filename, mf.mime_type, mf.file_size
        FROM messages m
        JOIN users u ON u.id = m.user_id
        LEFT JOIN message_reads mr ON mr.message_id = m.id AND mr.user_id = ?
        LEFT JOIN media_files mf ON mf.message_id = m.id
        WHERE m.room_id = ? AND m.id < ?
        ORDER BY m.id DESC
        LIMIT ?
      `).all(userId, roomId, before, limit);
    } else {
      rows = db.prepare(`
        SELECT m.id, m.room_id, m.user_id, m.body, m.media_position as mediaPosition, m.created_at, m.updated_at, u.login,
               CASE WHEN mr.user_id IS NULL THEN 0 ELSE 1 END AS is_read,
               mf.id as media_id, mf.original_name, mf.encrypted_filename, mf.mime_type, mf.file_size
        FROM messages m
        JOIN users u ON u.id = m.user_id
        LEFT JOIN message_reads mr ON mr.message_id = m.id AND mr.user_id = ?
        LEFT JOIN media_files mf ON mf.message_id = m.id
        WHERE m.room_id = ?
        ORDER BY m.id DESC
        LIMIT ?
      `).all(userId, roomId, limit);
    }
    rows.reverse();

    // Group messages with their media files
    const groupedRows = [];
    for (let i = 0; i < rows.length; i++) {
      const current = rows[i];
      
      // If this is the first occurrence of the message
      if (i === 0 || current.id !== (groupedRows[groupedRows.length - 1]?.id)) {
        // Add message with potentially empty media array
        const messageWithMedia = {
          ...current,
          media: current.media_id ? [{
            id: current.media_id,
            original_name: current.original_name,
            encrypted_filename: current.encrypted_filename,
            mime_type: current.mime_type,
            file_size: current.file_size
          }] : []
        };
        
        // Remove media-specific properties to avoid duplication
        delete messageWithMedia.media_id;
        delete messageWithMedia.original_name;
        delete messageWithMedia.encrypted_filename;
        delete messageWithMedia.mime_type;
        delete messageWithMedia.file_size;
        
        groupedRows.push(messageWithMedia);
      } else {
        // Add media to the existing message
        const lastMessage = groupedRows[groupedRows.length - 1];
        if (current.media_id) {
          lastMessage.media.push({
            id: current.media_id,
            original_name: current.original_name,
            encrypted_filename: current.encrypted_filename,
            mime_type: current.mime_type,
            file_size: current.file_size
          });
        }
      }
    }

    const firstUnreadRow = db.prepare(`
      SELECT MIN(m.id) as first_unread_id
      FROM messages m
      LEFT JOIN message_reads mr ON mr.message_id = m.id AND mr.user_id = ?
      WHERE m.room_id = ? AND mr.user_id IS NULL
    `).get(userId, roomId);

    const first_unread_message_id = firstUnreadRow ? firstUnreadRow.first_unread_id : null;

    return { messages: groupedRows, first_unread_message_id };
  });

  fastify.post('/api/rooms/:roomId/messages', {
    preHandler: [fastify.requireAuth],
  }, async (request, reply) => {
    const roomId = Number(request.params.roomId);
    const { body, media_ids, mediaPosition } = request.body || {};
    
    // Either body or media_ids must be present
    if ((!body || !String(body).trim()) && (!media_ids || !Array.isArray(media_ids) || media_ids.length === 0)) {
      return reply.code(400).send({ error: 'Message body or media files required' });
    }

    // Rate limiting check
    const userId = request.session.userId;
    const now = Date.now();
    const userRateLimit = rateLimitStore.get(userId) || { count: 0, timestamp: now };
    
    // Reset counter if window has passed
    if (now - userRateLimit.timestamp > RATE_LIMIT_WINDOW) {
      userRateLimit.count = 0;
      userRateLimit.timestamp = now;
    }
    
    // Increment count
    userRateLimit.count++;
    
    // Check if rate limit exceeded
    if (userRateLimit.count > MAX_MESSAGES_PER_WINDOW) {
      return reply.code(429).send({ error: 'Too many messages sent recently. Please slow down.' });
    }
    
    // Update rate limit store
    rateLimitStore.set(userId, userRateLimit);

    const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(roomId);
    if (!room) return reply.code(404).send({ error: 'Room not found' });

    // Insert the message
    const result = db.prepare(
      'INSERT INTO messages (room_id, user_id, body, media_position) VALUES (?, ?, ?, ?)'
    ).run(
      roomId,
      request.session.userId,
      String(body || '').trim(),
      mediaPosition === 'above' || mediaPosition === 'below' ? mediaPosition : null
    );
    
    const messageId = result.lastInsertRowid;
    
    // If media IDs were provided, link them to the message
    if (media_ids && Array.isArray(media_ids) && media_ids.length > 0) {
      const placeholders = media_ids.map(() => '?').join(',');
      db.prepare(`
        UPDATE media_files 
        SET message_id = ? 
        WHERE id IN (${placeholders}) AND uploaded_by = ?
      `).run(messageId, ...media_ids, request.session.userId);
    }
    
    // Get the created message with media
    const msg = db.prepare(`
      SELECT m.id, m.room_id, m.user_id, m.body, m.media_position as mediaPosition, m.created_at, m.updated_at, u.login,
             mf.id as media_id, mf.original_name, mf.encrypted_filename, mf.mime_type, mf.file_size
      FROM messages m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN media_files mf ON mf.message_id = m.id
      WHERE m.id = ?
    `).get(messageId);

    // Get all media files for this message
    const mediaFiles = db.prepare(`
      SELECT id, original_name, encrypted_filename, mime_type, file_size
      FROM media_files
      WHERE message_id = ?
    `).all(messageId);

    // Create final message object with all media files
    const fullMessage = {
      ...msg,
      media: mediaFiles
    };
    
    // Remove media-specific properties from the base message
    delete fullMessage.media_id;
    delete fullMessage.original_name;
    delete fullMessage.encrypted_filename;
    delete fullMessage.mime_type;
    delete fullMessage.file_size;

    // Mark author's own message as read for them
    try {
      db.prepare(
        `INSERT OR IGNORE INTO message_reads (message_id, user_id, read_at)
         VALUES (?, ?, datetime('now'))`
      ).run(msg.id, request.session.userId);
    } catch (e) {
      if (process.env.DEBUG_MODE === 'true') {
        fastify.log.error('Failed to insert into message_reads for author:', e);
      }
    }

    if (process.env.DEBUG_MODE === 'true') {
      fastify.log.info(`About to broadcast new message to room ${roomId}:`, fullMessage);
    }
    if (fastify.broadcastRoom) {
      if (process.env.DEBUG_MODE === 'true') {
        fastify.log.info(`Calling broadcastRoom for room ${roomId}`);
      }
      fastify.broadcastRoom(roomId, { type: 'message', message: fullMessage });
      if (process.env.DEBUG_MODE === 'true') {
        fastify.log.info(`Called broadcastRoom for room ${roomId}`);
      }
    } else {
      if (process.env.DEBUG_MODE === 'true') {
        fastify.log.info(`broadcastRoom function not available on fastify instance`);
      }
    }
    // Additionally broadcast lightweight notification about new message to all clients
    if (fastify.broadcastAll) {
      const previewBody = String(fullMessage.body || '');
      const preview =
        previewBody.length > 120 ? `${previewBody.slice(0, 117)}...` : previewBody;
      fastify.broadcastAll({
        type: 'room_message',
        roomId,
        messageId: fullMessage.id,
        userId: fullMessage.user_id,
        login: fullMessage.login,
        preview,
        created_at: fullMessage.created_at,
      });
    }
    return fullMessage;
  });

  // Endpoint to mark messages in a room as read up to a certain message
  fastify.post('/api/rooms/:roomId/read', {
    preHandler: [fastify.requireAuth],
  }, async (request, reply) => {
    const roomId = Number(request.params.roomId);
    const { lastReadMessageId } = request.body || {};

    if (!lastReadMessageId || Number.isNaN(Number(lastReadMessageId))) {
      return reply.code(400).send({ error: 'lastReadMessageId is required' });
    }

    const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(roomId);
    if (!room) return reply.code(404).send({ error: 'Room not found' });

    const userId = request.session.userId;
    const maxIdRow = db
      .prepare(
        'SELECT MAX(id) as max_id FROM messages WHERE room_id = ? AND id <= ?'
      )
      .get(roomId, Number(lastReadMessageId));

    if (!maxIdRow || !maxIdRow.max_id) {
      return { ok: true, marked: 0 };
    }

    const effectiveLastId = maxIdRow.max_id;

    try {
      const result = db
        .prepare(
          `
        INSERT OR IGNORE INTO message_reads (message_id, user_id, read_at)
        SELECT m.id, ?, datetime('now')
        FROM messages m
        WHERE m.room_id = ? AND m.id <= ?
      `
        )
        .run(userId, roomId, effectiveLastId);

      return { ok: true, marked: result.changes || 0, lastReadMessageId: effectiveLastId };
    } catch (error) {
      fastify.log.error('Error marking messages as read:', error);
      return reply.code(500).send({ error: 'Error marking messages as read' });
    }
  });

  // Endpoint to edit a message
  fastify.patch('/api/rooms/:roomId/messages/:messageId', {
    preHandler: [fastify.requireAuth],
  }, async (request, reply) => {
    const roomId = Number(request.params.roomId);
    const messageId = Number(request.params.messageId);
    const { body, media_ids, mediaPosition } = request.body || {};

    if ((!body || !String(body).trim()) && (!media_ids || !Array.isArray(media_ids))) {
      return reply.code(400).send({ error: 'Message body or media files required' });
    }

    // Check if room exists
    const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(roomId);
    if (!room) return reply.code(404).send({ error: 'Room not found' });

    // Get the message
    const message = db.prepare(`
      SELECT m.id, m.room_id, m.user_id, m.body, u.role
      FROM messages m
      JOIN users u ON u.id = m.user_id
      WHERE m.id = ?
    `).get(messageId);

    if (!message) return reply.code(404).send({ error: 'Message not found' });

    if (message.room_id !== roomId) {
      return reply.code(400).send({ error: 'Message does not belong to room' });
    }

    // Check permissions: user can edit own message, or if they are owner/moderator
    const isOwnMessage = message.user_id === request.session.userId;
    const currentUser = fastify.getUser(request.session.userId);
    const isAllowed = isOwnMessage || isOwnerOrModerator(currentUser?.role);

    if (!isAllowed) {
      return reply.code(403).send({ error: 'Cannot edit another user\'s message' });
    }

    // Update the message
    const updateFields = [];
    const updateParams = [];
    
    if (body !== undefined) {
      updateFields.push('body = ?');
      updateParams.push(String(body).trim());
    }
    
    if (mediaPosition !== undefined && (mediaPosition === 'above' || mediaPosition === 'below')) {
      updateFields.push('media_position = ?');
      updateParams.push(mediaPosition);
    }
    
    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    updateParams.push(messageId);

    const updateQuery = `UPDATE messages SET ${updateFields.join(', ')} WHERE id = ?`;
    const result = db.prepare(updateQuery).run(...updateParams);

    // If media_ids were provided, update media associations
    if (media_ids && Array.isArray(media_ids) && media_ids.length > 0) {
      // First unlink all existing media from this message
      db.prepare(`
        UPDATE media_files 
        SET message_id = NULL 
        WHERE message_id = ?
      `).run(messageId);
      
      // Then link the specified media files to this message
      const placeholders = media_ids.map(() => '?').join(',');
      db.prepare(`
        UPDATE media_files 
        SET message_id = ? 
        WHERE id IN (${placeholders}) AND uploaded_by = ?
      `).run(messageId, ...media_ids, request.session.userId);
    } else if (media_ids && Array.isArray(media_ids)) {
      // If empty array was provided, unlink all media from this message
      db.prepare(`
        UPDATE media_files 
        SET message_id = NULL 
        WHERE message_id = ?
      `).run(messageId);
    }

    // Get updated message with media
    const updatedMsg = db.prepare(`
      SELECT m.id, m.room_id, m.user_id, m.body, m.media_position as mediaPosition, m.created_at, m.updated_at, u.login,
             mf.id as media_id, mf.original_name, mf.encrypted_filename, mf.mime_type, mf.file_size
      FROM messages m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN media_files mf ON mf.message_id = m.id
      WHERE m.id = ?
    `).get(messageId);

    // Get all media files for this message
    const mediaFiles = db.prepare(`
      SELECT id, original_name, encrypted_filename, mime_type, file_size
      FROM media_files
      WHERE message_id = ?
    `).all(messageId);

    // Create final message object with all media files
    const fullUpdatedMessage = {
      ...updatedMsg,
      media: mediaFiles
    };
    
    // Remove media-specific properties from the base message
    delete fullUpdatedMessage.media_id;
    delete fullUpdatedMessage.original_name;
    delete fullUpdatedMessage.encrypted_filename;
    delete fullUpdatedMessage.mime_type;
    delete fullUpdatedMessage.file_size;

    // Broadcast update to all room participants
    if (process.env.DEBUG_MODE === 'true') {
      fastify.log.info(`About to broadcast message update to room ${roomId}:`, fullUpdatedMessage);
    }
    if (fastify.broadcastRoom) {
      if (process.env.DEBUG_MODE === 'true') {
        fastify.log.info(`Calling broadcastRoom for message update in room ${roomId}`);
      }
      fastify.broadcastRoom(roomId, { type: 'message_updated', message: fullUpdatedMessage });
      if (process.env.DEBUG_MODE === 'true') {
        fastify.log.info(`Called broadcastRoom for message update in room ${roomId}`);
      }
    } else {
      if (process.env.DEBUG_MODE === 'true') {
        fastify.log.info(`broadcastRoom function not available on fastify instance for update`);
      }
    }

    return fullUpdatedMessage;
  });

  // Endpoint to delete a message
  fastify.delete('/api/rooms/:roomId/messages/:messageId', {
    preHandler: [fastify.requireAuth],
  }, async (request, reply) => {
    const roomId = Number(request.params.roomId);
    const messageId = Number(request.params.messageId);

    // Check if room exists
    const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(roomId);
    if (!room) return reply.code(404).send({ error: 'Room not found' });

    // Get the message
    const message = db.prepare(`
      SELECT m.id, m.room_id, m.user_id, m.body, u.role
      FROM messages m
      JOIN users u ON u.id = m.user_id
      WHERE m.id = ?
    `).get(messageId);

    if (!message) return reply.code(404).send({ error: 'Message not found' });

    if (message.room_id !== roomId) {
      return reply.code(400).send({ error: 'Message does not belong to room' });
    }

    // Check permissions: user can delete own message, or if they are owner/moderator
    const isOwnMessage = message.user_id === request.session.userId;
    const currentUser = fastify.getUser(request.session.userId);
    const isAllowed = isOwnMessage || isOwnerOrModerator(currentUser?.role);

    if (!isAllowed) {
      return reply.code(403).send({ error: 'Cannot delete another user\'s message' });
    }

    // Get message with media files before deletion
    const messageWithMedia = db.prepare(`
      SELECT m.id, m.room_id, m.user_id, m.body, u.login,
             mf.encrypted_filename
      FROM messages m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN media_files mf ON mf.message_id = m.id
      WHERE m.id = ?
    `).get(messageId);

    // Get media files to clean up
    const mediaFiles = db.prepare(`
      SELECT encrypted_filename, transcoded_filename
      FROM media_files
      WHERE message_id = ?
    `).all(messageId);

    // Delete the message (this will also delete related media_files entries due to CASCADE)
    db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);

    // Delete actual media files from filesystem
    removeMediaFiles(mediaFiles, fastify.log);

    if (process.env.DEBUG_MODE === 'true') {
      fastify.log.info(`About to broadcast message deletion for message ${messageId} in room ${roomId}`);
    }
    // Broadcast deletion to all room participants via WebSocket
    if (fastify.broadcastMessageDeleted) {
      if (process.env.DEBUG_MODE === 'true') {
        fastify.log.info(`Calling broadcastMessageDeleted for message ${messageId} in room ${roomId}`);
      }
      fastify.broadcastMessageDeleted(roomId, messageId, request.session.userId, currentUser?.login || request.session.userId);
      if (process.env.DEBUG_MODE === 'true') {
        fastify.log.info(`Called broadcastMessageDeleted for message ${messageId} in room ${roomId}`);
      }
    } else if (fastify.broadcastRoom) {
      if (process.env.DEBUG_MODE === 'true') {
        fastify.log.info(`Calling broadcastRoom for message deletion in room ${roomId}`);
      }
      fastify.broadcastRoom(roomId, { type: 'message_deleted', messageId, userId: request.session.userId, login: currentUser?.login || request.session.userId });
      if (process.env.DEBUG_MODE === 'true') {
        fastify.log.info(`Called broadcastRoom for message deletion in room ${roomId}`);
      }
    } else {
      if (process.env.DEBUG_MODE === 'true') {
        fastify.log.info(`No broadcast function available for message deletion`);
      }
    }

    return { success: true };
  });

  // Endpoint to delete multiple messages
  fastify.delete('/api/rooms/:roomId/messages/batch-delete', {
    preHandler: [fastify.requireAuth],
  }, async (request, reply) => {
    const roomId = Number(request.params.roomId);
    const { messageIds } = request.body || {};

    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      return reply.code(400).send({ error: 'Array of message IDs required' });
    }

    // Check if room exists
    const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(roomId);
    if (!room) return reply.code(404).send({ error: 'Room not found' });

    const uniqueMessageIds = [...new Set(messageIds.map(Number).filter(Number.isInteger))];
    if (uniqueMessageIds.length === 0) {
      return reply.code(400).send({ error: 'Array of valid message IDs required' });
    }

    // Fetch messages to check permissions
    const placeholders = uniqueMessageIds.map(() => '?').join(',');
    const messagesQuery = db.prepare(`
      SELECT m.id, m.room_id, m.user_id, u.role
      FROM messages m
      JOIN users u ON u.id = m.user_id
      WHERE m.id IN (${placeholders}) AND m.room_id = ?
    `);
    const messages = messagesQuery.all([...uniqueMessageIds, roomId]);

    // Reject the whole request if any ID is missing or belongs to another room.
    // Otherwise a caller could pass foreign IDs and still trigger media cleanup.
    if (messages.length !== uniqueMessageIds.length) {
      const foundIds = new Set(messages.map((message) => message.id));
      const missingIds = uniqueMessageIds.filter((id) => !foundIds.has(id));
      return reply.code(404).send({
        error: 'Some messages were not found in this room',
        messageIds: missingIds,
      });
    }

    // Check permissions for each message
    const currentUser = fastify.getUser(request.session.userId);
    const isModerator = isOwnerOrModerator(currentUser?.role);

    for (const msg of messages) {
      const isOwnMessage = msg.user_id === request.session.userId;
      if (!isOwnMessage && !isModerator) {
        return reply.code(403).send({ error: `Cannot delete message ${msg.id}: not your message and not moderator` });
      }
    }

    // Get media files that need to be cleaned up (only for messages in this room)
    const mediaFilesToDelete = collectMediaForMessages(db, uniqueMessageIds);

    // Delete the messages using proper parameter binding
    try {
      const deleteQuery = `DELETE FROM messages WHERE id IN (${placeholders}) AND room_id = ?`;
      const deleteStmt = db.prepare(deleteQuery);
      const result = deleteStmt.run([...uniqueMessageIds, roomId]);

      // Delete actual media files from filesystem
      removeMediaFiles(mediaFilesToDelete, fastify.log);

      // Broadcast deletion to all room participants
      if (fastify.broadcastRoom) {
        fastify.broadcastRoom(roomId, { type: 'messages_deleted', messageIds: uniqueMessageIds });
      }

      return { ok: true, count: result.changes };
    } catch (error) {
      fastify.log.error('Error deleting messages:', error);
      return reply.code(500).send({ error: 'Error deleting messages' });
    }
  });
};