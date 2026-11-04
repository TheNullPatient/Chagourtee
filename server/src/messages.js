const { isOwnerOrModerator } = require('./auth');
const { collectMediaForMessages, removeMediaFiles } = require('./dataCleanup');
const {
  normalizeReactionEmoji,
  parseReactionEmojis,
} = require('./reactions');
const {
  getRoom,
  canViewRoom,
  canAccessRoom,
  normalizeAccessLevel,
} = require('./roomAccess');

// Rate limiting store - keeps track of user message counts
const rateLimitStore = new Map(); // userId -> { count: number, timestamp: number }
const RATE_LIMIT_WINDOW = 10000; // 10 seconds window
const MAX_MESSAGES_PER_WINDOW = 5; // Max 5 messages per window

const MAX_MESSAGE_BODY_LENGTH = 10000;
const MAX_MEDIA_ATTACHMENTS = 10;
const MAX_BATCH_DELETE = 200;

function normalizeMessageBody(value) {
  if (value === undefined || value === null) {
    return { ok: true, body: '' };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: 'Message body must be a string' };
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_MESSAGE_BODY_LENGTH) {
    return {
      ok: false,
      error: `Message body cannot exceed ${MAX_MESSAGE_BODY_LENGTH} characters`,
    };
  }
  return { ok: true, body: trimmed };
}

function normalizeMediaIds(value) {
  if (value === undefined || value === null) {
    return { ok: true, ids: null };
  }
  if (!Array.isArray(value)) {
    return { ok: false, error: 'media_ids must be an array' };
  }
  if (value.length > MAX_MEDIA_ATTACHMENTS) {
    return {
      ok: false,
      error: `media_ids cannot contain more than ${MAX_MEDIA_ATTACHMENTS} items`,
    };
  }

  const ids = [];
  for (const item of value) {
    const id = Number(item);
    if (!Number.isInteger(id) || id <= 0) {
      return { ok: false, error: 'media_ids contains invalid ids' };
    }
    if (!ids.includes(id)) ids.push(id);
  }

  return { ok: true, ids };
}

/**
 * Returns media IDs the user may not attach. New messages may only claim
 * unattached files; editing may also keep files already on that message.
 */
function findUnavailableMedia(db, ids, userId, messageId = null) {
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(',');
  const params = [...ids, userId];
  let sql = `SELECT id FROM media_files WHERE id IN (${placeholders}) AND uploaded_by = ?`;
  if (messageId == null) {
    sql += ' AND message_id IS NULL';
  } else {
    sql += ' AND (message_id IS NULL OR message_id = ?)';
    params.push(messageId);
  }

  const rows = db.prepare(sql).all(...params);
  const found = new Set(rows.map((row) => Number(row.id)));
  return ids.filter((id) => !found.has(id));
}


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

const REPLY_FIELDS = [
  'reply_to_message_id',
  'reply_to_user_id',
  'reply_to_body',
  'reply_to_login',
];

/**
 * Replaces the reply snapshot columns with a single `replyTo` object.
 * Live parent messages win, so an edited original is quoted in its current
 * form; snapshots keep the quote readable after the original is deleted.
 */
function attachReplyInfo(db, messages) {  if (messages.length === 0) return messages;

  const replyIds = [
    ...new Set(
      messages
        .map((message) => message.reply_to_message_id)
        .filter((id) => Number.isInteger(id))
    ),
  ];

  const parents = new Map();
  if (replyIds.length > 0) {
    const placeholders = replyIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT m.id, m.body, m.user_id, u.login
         FROM messages m
         JOIN users u ON u.id = m.user_id
         WHERE m.id IN (${placeholders})`
      )
      .all(...replyIds);
    for (const row of rows) parents.set(Number(row.id), row);
  }

  for (const message of messages) {
    const hasSnapshot =
      message.reply_to_message_id != null ||
      message.reply_to_body != null ||
      message.reply_to_login != null;

    if (!hasSnapshot) {
      message.replyTo = null;
    } else {
      const parent =
        message.reply_to_message_id != null
          ? parents.get(Number(message.reply_to_message_id))
          : null;

      message.replyTo = {
        id:
          message.reply_to_message_id != null
            ? Number(message.reply_to_message_id)
            : null,
        userId: parent
          ? Number(parent.user_id)
          : message.reply_to_user_id != null
            ? Number(message.reply_to_user_id)
            : null,
        login: parent ? parent.login : message.reply_to_login || '',
        body: parent ? parent.body : message.reply_to_body || '',
        deleted: !parent,
      };
    }

    for (const field of REPLY_FIELDS) delete message[field];
  }

  return messages;
}

/**
 * Groups raw reaction rows into the shape sent to clients:
 * `[{ emoji, count, users: [{ id, login }] }]`.
 */
function buildReactionGroups(rows) {
  const groups = new Map();

  for (const row of rows) {
    let group = groups.get(row.emoji);
    if (!group) {
      group = { emoji: row.emoji, users: [] };
      groups.set(row.emoji, group);
    }
    group.users.push({ id: Number(row.user_id), login: row.login });
  }

  return [...groups.values()].map((group) => ({
    emoji: group.emoji,
    count: group.users.length,
    users: group.users,
  }));
}

function getMessageReactions(db, messageId) {
  const rows = db
    .prepare(
      `SELECT mr.emoji, u.id AS user_id, u.login
       FROM message_reactions mr
       JOIN users u ON u.id = mr.user_id
       WHERE mr.message_id = ?
       ORDER BY mr.created_at ASC, mr.rowid ASC`
    )
    .all(messageId);
  return buildReactionGroups(rows);
}

/**
 * Adds a `reactions` array to every message. The same grouped shape is used by
 * history responses, message creation/edit responses and WebSocket broadcasts,
 * so clients do not need to reconcile different formats.
 */
function attachReactionInfo(db, messages) {
  if (messages.length === 0) return messages;

  const messageIds = [...new Set(messages.map((message) => Number(message.id)))];
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT mr.message_id, mr.emoji, u.id AS user_id, u.login
       FROM message_reactions mr
       JOIN users u ON u.id = mr.user_id
       WHERE mr.message_id IN (${placeholders})
       ORDER BY mr.created_at ASC, mr.rowid ASC`
    )
    .all(...messageIds);

  const byMessage = new Map();
  for (const row of rows) {
    const key = Number(row.message_id);
    if (!byMessage.has(key)) byMessage.set(key, []);
    byMessage.get(key).push(row);
  }

  for (const message of messages) {
    message.reactions = buildReactionGroups(byMessage.get(Number(message.id)) || []);
  }

  return messages;
}

/**
 * Returns a Fastify reply when the user may not read/write the room, or null.
 * Private rooms answer 404 so outsiders cannot confirm that they exist.
 */
function denyRoomAccess(fastify, db, request, reply, room) {
  const user = fastify.getUser(request.session.userId);
  if (canAccessRoom(db, room, user)) return null;

  if (!canViewRoom(db, room, user)) {
    return reply.code(404).send({ error: 'Room not found' });
  }

  const level = normalizeAccessLevel(room.access_level);
  return reply.code(403).send({
    error: level === 'closed' ? 'Room is locked' : 'Room access denied',
    code: level === 'closed' ? 'ROOM_LOCKED' : 'ROOM_FORBIDDEN',
  });
}

module.exports = function (fastify) {
  const db = fastify.db;

  fastify.get('/api/rooms/:roomId/messages', {
    preHandler: [fastify.requireAuth],
  }, async (request, reply) => {
    const roomId = Number(request.params.roomId);
    const rawLimit = Number(request.query.limit);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.floor(rawLimit), 1), 100)
      : 50;

    let before = null;
    if (
      request.query.before !== undefined &&
      request.query.before !== null &&
      request.query.before !== ''
    ) {
      before = Number(request.query.before);
      if (!Number.isInteger(before) || before <= 0) {
        return reply.code(400).send({ error: 'Invalid before cursor' });
      }
    }

    const room = getRoom(db, roomId);
    if (!room) return reply.code(404).send({ error: 'Room not found' });
    const accessDenied = denyRoomAccess(fastify, db, request, reply, room);
    if (accessDenied) return accessDenied;

    const userId = request.session.userId;

    let rows;
    if (before) {
      rows = db.prepare(`
        SELECT m.id, m.room_id, m.user_id, m.body, m.media_position as mediaPosition, m.created_at, m.updated_at, u.login,
               m.reply_to_message_id, m.reply_to_user_id, m.reply_to_body, m.reply_to_login,
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
               m.reply_to_message_id, m.reply_to_user_id, m.reply_to_body, m.reply_to_login,
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

    attachReplyInfo(db, groupedRows);
    attachReactionInfo(db, groupedRows);

    return { messages: groupedRows, first_unread_message_id };
  });

  fastify.post('/api/rooms/:roomId/messages', {
    preHandler: [fastify.requireAuth],
  }, async (request, reply) => {
    const roomId = Number(request.params.roomId);
    const { body, media_ids, mediaPosition, replyToMessageId } = request.body || {};

    const bodyResult = normalizeMessageBody(body);
    if (!bodyResult.ok) {
      return reply.code(400).send({ error: bodyResult.error });
    }

    const mediaResult = normalizeMediaIds(media_ids);
    if (!mediaResult.ok) {
      return reply.code(400).send({ error: mediaResult.error });
    }

    const normalizedBody = bodyResult.body;
    const normalizedMediaIds = mediaResult.ids || [];
    const hasMedia = normalizedMediaIds.length > 0;

    // Either body or media_ids must be present
    if (!normalizedBody && !hasMedia) {
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

    if (hasMedia) {
      const unavailable = findUnavailableMedia(db, normalizedMediaIds, userId);
      if (unavailable.length > 0) {
        return reply.code(400).send({
          error: 'Some media files are not available for this user',
          mediaIds: unavailable,
        });
      }
    }

    const room = getRoom(db, roomId);
    if (!room) return reply.code(404).send({ error: 'Room not found' });
    const accessDenied = denyRoomAccess(fastify, db, request, reply, room);
    if (accessDenied) return accessDenied;

    let replyTarget = null;
    if (replyToMessageId !== undefined && replyToMessageId !== null) {
      const targetId = Number(replyToMessageId);
      if (!Number.isInteger(targetId) || targetId <= 0) {
        return reply.code(400).send({ error: 'Invalid replyToMessageId' });
      }
      replyTarget = db
        .prepare(
          `SELECT m.id, m.user_id, m.body, u.login
           FROM messages m
           JOIN users u ON u.id = m.user_id
           WHERE m.id = ? AND m.room_id = ?`
        )
        .get(targetId, roomId);
      if (!replyTarget) {
        return reply.code(400).send({ error: 'Reply target not found in this room' });
      }
    }

    // Insert the message
    const result = db.prepare(
      `INSERT INTO messages
         (room_id, user_id, body, media_position, reply_to_message_id, reply_to_user_id, reply_to_body, reply_to_login)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      roomId,
      request.session.userId,
      normalizedBody,
      mediaPosition === 'above' || mediaPosition === 'below' ? mediaPosition : null,
      replyTarget ? replyTarget.id : null,
      replyTarget ? replyTarget.user_id : null,
      replyTarget ? replyTarget.body : null,
      replyTarget ? replyTarget.login : null
    );
    
    const messageId = result.lastInsertRowid;
    
    // If media IDs were provided, link them to the message
    if (normalizedMediaIds.length > 0) {
      const placeholders = normalizedMediaIds.map(() => '?').join(',');
      db.prepare(`
        UPDATE media_files 
        SET message_id = ? 
        WHERE id IN (${placeholders}) AND uploaded_by = ?
      `).run(messageId, ...normalizedMediaIds, request.session.userId);
    }
    
    // Get the created message with media
    const msg = db.prepare(`
      SELECT m.id, m.room_id, m.user_id, m.body, m.media_position as mediaPosition, m.created_at, m.updated_at, u.login,
             m.reply_to_message_id, m.reply_to_user_id, m.reply_to_body, m.reply_to_login,
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

    attachReplyInfo(db, [fullMessage]);
    attachReactionInfo(db, [fullMessage]);

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
    // Additionally broadcast lightweight notification about new message to all
    // users who can access this room. Private/closed rooms must not leak
    // metadata to outsiders.
    if (fastify.broadcastRoomNotification) {
      const previewBody = String(fullMessage.body || '');
      const preview =
        previewBody.length > 120 ? `${previewBody.slice(0, 117)}...` : previewBody;
      fastify.broadcastRoomNotification(roomId, {
        type: 'room_message',
        roomId,
        messageId: fullMessage.id,
        userId: fullMessage.user_id,
        login: fullMessage.login,
        preview,
        replyToUserId: fullMessage.replyTo?.userId ?? null,
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

    const lastReadId = Number(lastReadMessageId);
    if (!Number.isInteger(lastReadId) || lastReadId <= 0) {
      return reply.code(400).send({ error: 'lastReadMessageId is required' });
    }

    const room = getRoom(db, roomId);
    if (!room) return reply.code(404).send({ error: 'Room not found' });
    const accessDenied = denyRoomAccess(fastify, db, request, reply, room);
    if (accessDenied) return accessDenied;

    const userId = request.session.userId;
    const maxIdRow = db
      .prepare(
        'SELECT MAX(id) as max_id FROM messages WHERE room_id = ? AND id <= ?'
      )
      .get(roomId, lastReadId);

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

    const bodyResult = normalizeMessageBody(body);
    if (!bodyResult.ok) {
      return reply.code(400).send({ error: bodyResult.error });
    }
    const mediaResult = normalizeMediaIds(media_ids);
    if (!mediaResult.ok) {
      return reply.code(400).send({ error: mediaResult.error });
    }

    const normalizedBody = body === undefined ? null : bodyResult.body;
    const normalizedMediaIds = mediaResult.ids;
    const hasBody = normalizedBody !== null && normalizedBody.length > 0;
    const hasMedia = normalizedMediaIds !== null && normalizedMediaIds.length > 0;

    if (!hasBody && !hasMedia) {
      return reply.code(400).send({ error: 'Message body or media files required' });
    }

    // Check if room exists
    const room = getRoom(db, roomId);
    if (!room) return reply.code(404).send({ error: 'Room not found' });
    const accessDenied = denyRoomAccess(fastify, db, request, reply, room);
    if (accessDenied) return accessDenied;

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

    if (normalizedMediaIds && normalizedMediaIds.length > 0) {
      const unavailable = findUnavailableMedia(
        db,
        normalizedMediaIds,
        request.session.userId,
        messageId
      );
      if (unavailable.length > 0) {
        return reply.code(400).send({
          error: 'Some media files are not available for this user',
          mediaIds: unavailable,
        });
      }
    }

    // Update the message
    const updateFields = [];
    const updateParams = [];
    
    if (normalizedBody !== null) {
      updateFields.push('body = ?');
      updateParams.push(normalizedBody);
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
    if (normalizedMediaIds !== null) {
      // First unlink all existing media from this message
      db.prepare(`
        UPDATE media_files 
        SET message_id = NULL 
        WHERE message_id = ?
      `).run(messageId);

      if (normalizedMediaIds.length > 0) {
        // Then link the specified media files to this message
        const placeholders = normalizedMediaIds.map(() => '?').join(',');
        db.prepare(`
          UPDATE media_files
          SET message_id = ?
          WHERE id IN (${placeholders}) AND uploaded_by = ?
        `).run(messageId, ...normalizedMediaIds, request.session.userId);
      }
    }

    // Get updated message with media
    const updatedMsg = db.prepare(`
      SELECT m.id, m.room_id, m.user_id, m.body, m.media_position as mediaPosition, m.created_at, m.updated_at, u.login,
             m.reply_to_message_id, m.reply_to_user_id, m.reply_to_body, m.reply_to_login,
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

    // Keep quotes of this message in sync even after the original is deleted.
    db.prepare(
      'UPDATE messages SET reply_to_body = ?, reply_to_login = ? WHERE reply_to_message_id = ?'
    ).run(updatedMsg.body, updatedMsg.login, messageId);

    attachReplyInfo(db, [fullUpdatedMessage]);
    attachReactionInfo(db, [fullUpdatedMessage]);

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

  // Toggle an emoji reaction on a message. One row per user and emoji; posting
  // the same emoji again removes it.
  fastify.post('/api/rooms/:roomId/messages/:messageId/reactions', {
    preHandler: [fastify.requireAuth],
  }, async (request, reply) => {
    const roomId = Number(request.params.roomId);
    const messageId = Number(request.params.messageId);
    const emoji = normalizeReactionEmoji(request.body?.emoji);

    if (!emoji) {
      return reply.code(400).send({ error: 'Invalid emoji' });
    }

    const room = getRoom(db, roomId);
    if (!room) return reply.code(404).send({ error: 'Room not found' });
    const accessDenied = denyRoomAccess(fastify, db, request, reply, room);
    if (accessDenied) return accessDenied;

    const message = db
      .prepare('SELECT id, room_id FROM messages WHERE id = ?')
      .get(messageId);
    if (!message) return reply.code(404).send({ error: 'Message not found' });
    if (Number(message.room_id) !== roomId) {
      return reply.code(400).send({ error: 'Message does not belong to room' });
    }

    const palette = parseReactionEmojis(room.reaction_emojis);
    const userId = request.session.userId;

    const toggle = db.transaction(() => {
      const existing = db
        .prepare(
          'SELECT 1 FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'
        )
        .get(messageId, userId, emoji);

      if (existing) {
        db.prepare(
          'DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'
        ).run(messageId, userId, emoji);
        return { added: false };
      }

      // Removed emojis can still be taken off an old reaction, but new ones
      // must come from the palette configured for this room.
      if (!palette.includes(emoji)) {
        return { error: 'Emoji is not available in this room' };
      }

      db.prepare(
        'INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)'
      ).run(messageId, userId, emoji);
      return { added: true };
    });

    const result = toggle();
    if (result.error) {
      return reply.code(400).send({ error: result.error });
    }

    const reactions = getMessageReactions(db, messageId);
    const currentUser = fastify.getUser(userId);

    if (fastify.broadcastRoom) {
      fastify.broadcastRoom(roomId, {
        type: 'reaction_updated',
        messageId,
        reactions,
        userId,
        login: currentUser?.login || String(userId),
        emoji,
        added: result.added,
      });
    }

    return { ok: true, messageId, emoji, added: result.added, reactions };
  });

  // Endpoint to delete a message
  fastify.delete('/api/rooms/:roomId/messages/:messageId', {
    preHandler: [fastify.requireAuth],
  }, async (request, reply) => {
    const roomId = Number(request.params.roomId);
    const messageId = Number(request.params.messageId);

    // Check if room exists
    const room = getRoom(db, roomId);
    if (!room) return reply.code(404).send({ error: 'Room not found' });
    const accessDenied = denyRoomAccess(fastify, db, request, reply, room);
    if (accessDenied) return accessDenied;

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
    if (messageIds.length > MAX_BATCH_DELETE) {
      return reply.code(400).send({
        error: `Cannot delete more than ${MAX_BATCH_DELETE} messages at once`,
      });
    }

    const uniqueMessageIds = [];
    for (const item of messageIds) {
      const id = Number(item);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({ error: 'Array of valid message IDs required' });
      }
      if (!uniqueMessageIds.includes(id)) uniqueMessageIds.push(id);
    }
    if (uniqueMessageIds.length === 0) {
      return reply.code(400).send({ error: 'Array of valid message IDs required' });
    }

    // Check if room exists
    const room = getRoom(db, roomId);
    if (!room) return reply.code(404).send({ error: 'Room not found' });
    const accessDenied = denyRoomAccess(fastify, db, request, reply, room);
    if (accessDenied) return accessDenied;

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