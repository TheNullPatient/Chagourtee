const WebSocket = require('ws');
const { getDb } = require('./db');
const fs = require('fs');
const path = require('path');
const {
  getRoom,
  canViewRoom,
  canAccessRoom,
  normalizeAccessLevel,
} = require('./roomAccess');

const SESSION_COOKIE = 'chagourtee_sid';
const { MEDIA_DIR } = require('./dataCleanup');

// Rate limiting for WebSocket messages
const wsRateLimitStore = new Map(); // userId -> { count: number, timestamp: number }
const WS_RATE_LIMIT_WINDOW = 5000; // 5 seconds window
const WS_MAX_MESSAGES_PER_WINDOW = 10; // Max 10 messages per window

// Cleanup old WebSocket rate limit entries periodically
const wsRateLimitCleanup = setInterval(() => {
  const now = Date.now();
  for (const [userId, record] of wsRateLimitStore.entries()) {
    // If the record is older than 2 windows, remove it
    if (now - record.timestamp > WS_RATE_LIMIT_WINDOW * 2) {
      wsRateLimitStore.delete(userId);
    }
  }
}, 30000); // Clean up every 30 seconds
wsRateLimitCleanup.unref();

function getUserIdFromCookie(cookieHeader) {
  if (!cookieHeader) return null;
  const db = getDb();
  const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE id = ?').get(match[1].trim());
  if (!row || new Date(row.expires_at) < new Date()) return null;
  return row.user_id;
}

function isValidRoomId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0;
}

module.exports = function (fastify) {
  const server = fastify.server;
  if (!server) return;

  const wss = new WebSocket.Server({ server, path: '/ws', maxPayload: 256 * 1024 });
  const clientsByUser = new Map();
  const userByClient = new Map();

  wss.on('connection', (ws, req) => {
    const userId = getUserIdFromCookie(req.headers.cookie);
    if (!userId) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    // Unverified accounts may keep a socket open so they can receive
    // user_verified, but they must not join rooms or receive broadcasts.
    const connectionUser = fastify.db
      .prepare('SELECT verified FROM users WHERE id = ?')
      .get(userId);
    if (!connectionUser) {
      ws.close(4001, 'Unauthorized');
      return;
    }
    const verificationSetting = fastify.db
      .prepare('SELECT enabled FROM verification_settings LIMIT 1')
      .get();
    ws.isVerified = Boolean(connectionUser.verified) || !(verificationSetting && verificationSetting.enabled);
    
    // Set up heartbeat mechanism
    let heartbeatInterval = setInterval(() => {
      if (ws.isAlive === false) {
        // Client did not respond to ping, close connection
        ws.terminate();
        return;
      }
      
      ws.isAlive = false;
      // Send ping to client
      try {
        ws.ping();
      } catch (e) {
        // Connection might be dead, terminate it
        ws.terminate();
      }
    }, 35000); // Ping every 35 seconds (slightly more than client ping interval)
    
    // Mark connection as alive when pong is received
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    
    if (!clientsByUser.has(userId)) clientsByUser.set(userId, new Set());
    clientsByUser.get(userId).add(ws);
    userByClient.set(ws, userId);

    const user = fastify.getUser(userId);
    // Defer the presence broadcast to ensure connection is fully established
    if (ws.isVerified) setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      broadcast({ type: 'presence', userId, login: user?.login, online: true });
      // Send current online users snapshot to the newly connected client
      const onlineUsers = [];
      for (const [uid, clients] of clientsByUser.entries()) {
        if (clients.size > 0) {
          const u = fastify.getUser(uid);
          onlineUsers.push({ userId: uid, login: u?.login });
        }
      }
      try {
        ws.send(JSON.stringify({ type: 'presence_snapshot', users: onlineUsers }));
      } catch (e) { /* ignore */ }
    }, 100); // Small delay to ensure connection is ready

    ws.on('message', (raw) => {
      try {
        // Проверяем, что raw - это строка или Buffer перед парсингом
        let rawData;
        if (typeof raw === 'string') {
          rawData = raw;
        } else if (Buffer.isBuffer(raw)) {
          rawData = raw.toString();
        } else {
          if (process.env.DEBUG_MODE === 'true') {
            fastify.log.warn('Received non-string/non-buffer data from WebSocket');
          }
          return;
        }
        
        const msg = JSON.parse(rawData);
        if (process.env.DEBUG_MODE === 'true') {
          fastify.log.info('Received WebSocket message:', msg);
        }
        
        // For WebSocket messages, we only apply rate limiting to actual message sending actions
        // Currently, none of the WebSocket message types should be rate limited since they are all service messages
        // Text messages are rate limited separately via the REST API
        
        // WebSocket is only used for ephemeral events (presence, typing,
        // media availability). Messages, edits, deletions and media metadata
        // are persisted through the REST API, which performs authorization.
        // Never trust or rebroadcast content-mutating events from a client.
        if (msg.type === 'typing' && isValidRoomId(msg.roomId)) {
          const roomId = Number(msg.roomId);
          // Only allow typing events for the room this socket has joined
          if (ws.currentRoomId === roomId) {
            broadcastToRoom(roomId, { type: 'typing', userId, login: user?.login || userId }, ws);
          }
        }
        if (msg.type === 'join' && isValidRoomId(msg.roomId)) {
          if (!ws.isVerified) {
            ws.send(JSON.stringify({
              type: 'error',
              code: 'ACCOUNT_NOT_VERIFIED',
              message: 'Account verification required',
            }));
            return;
          }
          const roomId = Number(msg.roomId);
          const room = getRoom(fastify.db, roomId);
          if (!room) {
            ws.send(JSON.stringify({ type: 'error', code: 'ROOM_NOT_FOUND', message: 'Room not found' }));
            return;
          }
          const joinUser = fastify.getUser(userId);
          if (!canAccessRoom(fastify.db, room, joinUser)) {
            const level = normalizeAccessLevel(room.access_level);
            ws.send(JSON.stringify({
              type: 'error',
              code: level === 'closed' ? 'ROOM_LOCKED' : 'ROOM_FORBIDDEN',
              message: level === 'closed'
                ? 'Room requires a password'
                : 'Room access denied',
            }));
            return;
          }
          ws.currentRoomId = roomId;
          if (process.env.DEBUG_MODE === 'true') {
            fastify.log.info(`User ${userId} joined room ${ws.currentRoomId}`);
          }
        }
        if (msg.type === 'leave' && isValidRoomId(msg.roomId)) {
          const roomId = Number(msg.roomId);
          if (ws.currentRoomId === roomId) {
            ws.currentRoomId = null;
            if (process.env.DEBUG_MODE === 'true') {
              fastify.log.info(`User ${userId} left room ${roomId}`);
            }
          }
        }
        // Handle ping messages from client
        if (msg.type === 'ping') {
          // Respond with pong
          ws.send(JSON.stringify({ type: 'pong' }));
        }

        if (msg.type === 'check_media_availability' && msg.requestId && Array.isArray(msg.files)) {
          const unavailableIds = [];
          // Cap the batch so a client cannot force unbounded DB/disk lookups
          const files = msg.files.slice(0, 100);
          for (const file of files) {
            const mediaId = Number(file.id);
            const encryptedFilename = typeof file.encrypted_filename === 'string'
              ? file.encrypted_filename
              : '';
            if (!Number.isFinite(mediaId) || !encryptedFilename) continue;

            const row = fastify.db
              .prepare('SELECT id, encrypted_filename FROM media_files WHERE id = ?')
              .get(mediaId);

            const existsInDb = !!row && row.encrypted_filename === encryptedFilename;
            const existsOnDisk = existsInDb
              ? fs.existsSync(path.join(MEDIA_DIR, encryptedFilename))
              : false;

            if (!existsInDb || !existsOnDisk) {
              unavailableIds.push(mediaId);
            }
          }
          ws.send(
            JSON.stringify({
              type: 'media_availability_result',
              requestId: msg.requestId,
              unavailableIds,
            })
          );
        }
      } catch (err) {
        // Логируем конкретную ошибку вместо игнорирования
        if (process.env.DEBUG_MODE === 'true') {
          fastify.log.error('Error processing WebSocket message:', err);
        }
        // Можно также отправить сообщение клиенту о проблеме
        try {
          ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Invalid message format' 
          }));
        } catch (sendErr) {
          if (process.env.DEBUG_MODE === 'true') {
            fastify.log.error('Error sending error response to client:', sendErr);
          }
        }
      }
    });

    let cleanedUp = false;
    function cleanupConnection() {
      if (cleanedUp) return;
      cleanedUp = true;

      clearInterval(heartbeatInterval);
      ws.currentRoomId = null;
      userByClient.delete(ws);

      const set = clientsByUser.get(userId);
      if (!set) return;

      set.delete(ws);
      if (set.size === 0) {
        clientsByUser.delete(userId);
        broadcast({ type: 'presence', userId, login: user?.login, online: false });
      }
    }

    ws.on('close', cleanupConnection);

    // Mark connection as alive initially
    ws.isAlive = true;

    // Handle connection errors (e.g., ECONNRESET when client disconnects abruptly)
    ws.on('error', (error) => {
      // Suppress noisy ECONNRESET/EPIPE errors — these are normal during abrupt disconnections
      if (error.code === 'ECONNRESET' || error.code === 'EPIPE') {
        if (process.env.DEBUG_MODE === 'true') {
          fastify.log.debug(`WebSocket error for user ${userId} (${error.code}), cleaning up...`);
        }
      } else {
        fastify.log.error(`WebSocket error for user ${userId}:`, error);
      }
      // Force cleanup — connection is dead
      cleanupConnection();
    });
  });

  // Periodically remove dead connections
  const heartbeatCleanup = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        return ws.terminate();
      }
      // Ensure all connections are marked as not alive until next heartbeat
    });
  }, 30000); // Check every 30 seconds
  heartbeatCleanup.unref();

  function broadcast(payload) {
    const data = JSON.stringify(payload);
    wss.clients.forEach((c) => {
      if (c.readyState === WebSocket.OPEN && c.isVerified) {
        try {
          c.send(data);
        } catch (err) {
          // Connection might be dead - will be cleaned up by error handler
          if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
            fastify.log.error('Broadcast send error:', err);
          }
        }
      }
    });
  }
  
  function sendToClient(c, data) {
    try {
      c.send(data);
      return true;
    } catch (err) {
      if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
        fastify.log.error('Broadcast send error:', err);
      }
      return false;
    }
  }

  function canClientAccessRoom(c, room) {
    const clientUserId = userByClient.get(c);
    if (!clientUserId) return false;
    return canAccessRoom(fastify.db, room, fastify.getUser(clientUserId));
  }

  function canClientViewRoom(c, room) {
    const clientUserId = userByClient.get(c);
    if (!clientUserId) return false;
    return canViewRoom(fastify.db, room, fastify.getUser(clientUserId));
  }

  /** Sends an event only to users who can currently access the room. */
  function broadcastToRoomAudience(room, payload) {
    const data = JSON.stringify(payload);
    wss.clients.forEach((c) => {
      if (c.readyState === WebSocket.OPEN && c.isVerified && canClientAccessRoom(c, room)) {
        sendToClient(c, data);
      }
    });
  }

  function broadcastMessageUpdated(roomId, messageId, content, userId, login) {
    const room = getRoom(fastify.db, roomId);
    if (!room) return;
    const payload = JSON.stringify({
      type: 'message_updated',
      messageId,
      content,
      userId,
      login
    });

    wss.clients.forEach((c) => {
      if (
        c.readyState === WebSocket.OPEN &&
        c.isVerified &&
        c.currentRoomId === roomId &&
        canClientAccessRoom(c, room)
      ) {
        sendToClient(c, payload);
      }
    });
  }
  
  // Broadcast message deletions to all users in the room
  function broadcastMessageDeleted(roomId, messageId, userId, login) {
    const room = getRoom(fastify.db, roomId);
    if (!room) return;
    const payload = JSON.stringify({
      type: 'message_deleted',
      messageId,
      userId,
      login
    });

    wss.clients.forEach((c) => {
      if (
        c.readyState === WebSocket.OPEN &&
        c.isVerified &&
        c.currentRoomId === roomId &&
        canClientAccessRoom(c, room)
      ) {
        sendToClient(c, payload);
      }
    });
  }
  
  function broadcastToRoom(roomId, payload, senderWs = null) {
    const data = JSON.stringify(payload);
    const room = getRoom(fastify.db, roomId);
    if (!room) return;
    if (process.env.DEBUG_MODE === 'true') {
      fastify.log.info(`Broadcasting to room ${roomId}:`, payload.type);
    }
    let count = 0;
    wss.clients.forEach((c) => {
      if (
        c.readyState === WebSocket.OPEN &&
        c.isVerified &&
        c.currentRoomId === roomId
      ) {
        // Don't send the message back to the sender
        if (c === senderWs) {
          return; // Skip the sender
        }
        if (!canClientAccessRoom(c, room)) {
          // Access may have been revoked while the socket stayed in the room.
          c.currentRoomId = null;
          return;
        }
        if (process.env.DEBUG_MODE === 'true') {
          fastify.log.info(`Sending to client in room ${roomId}`);
        }
        if (sendToClient(c, data)) count++;
      }
    });
    if (process.env.DEBUG_MODE === 'true') {
      fastify.log.info(`Sent to ${count} clients in room ${roomId}`);
    }
  }

  function broadcastRoomCreated(room) {
    // Private and restricted rooms must not be announced to outsiders.
    broadcastToRoomAudience(room, { type: 'room_created', room });
  }

  function broadcastRoomUpdated(room) {
    const data = JSON.stringify({ type: 'room_updated', room });
    wss.clients.forEach((c) => {
      if (c.readyState === WebSocket.OPEN && c.isVerified && canClientViewRoom(c, room)) {
        sendToClient(c, data);
      }
    });
  }

  function broadcastRoomsChanged() {
    // A tiny signal without room metadata: clients refetch /api/rooms, which
    // applies per-user visibility and lock state.
    broadcast({ type: 'rooms_changed' });
  }
  
  function broadcastRoomDeletion(roomId) {
    broadcast({ type: 'room_deleted', roomId });
  }

  function broadcastRoomMessagesCleared(roomId) {
    broadcast({ type: 'room_messages_cleared', roomId });
  }

  function broadcastUserUpdated(user) {
    const payload = JSON.stringify({ type: 'user_updated', user });
    wss.clients.forEach((c) => {
      if (c.readyState === WebSocket.OPEN && c.isVerified) {
        try {
          c.send(payload);
        } catch (err) {
          if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
            fastify.log.error('broadcastUserUpdated send error:', err);
          }
        }
      }
    });
  }

  function broadcastUserRoleChanged(user) {
    // Clients update both the directory (login, role, verified) and, when the
    // affected user is the current one, the session user without a reload.
    broadcast({
      type: 'user_role_changed',
      userId: user.id,
      newRole: user.role,
      user,
    });
  }

  function broadcastInvitesChanged(invites) {
    broadcast({ type: 'invites_changed', invites });
  }

  function broadcastVerificationCodesChanged(codes) {
    broadcast({ type: 'verification_codes_changed', codes });
  }

  function broadcastVerificationPendingChanged() {
    // Only signals that the moderation queue changed; admins refetch the data.
    broadcast({ type: 'verification_pending_changed' });
  }

  function broadcastVerificationSettingsUpdated(enabled, deleteCommentOnApprove) {
    broadcast({ type: 'verification_settings_updated', enabled, deleteCommentOnApprove });
  }

  function broadcastServerSettingsUpdated(settings) {
    broadcast({ type: 'server_settings_updated', settings });
  }

  fastify.broadcastRoom = function (roomId, payload) {
    broadcastToRoom(roomId, payload);
  };

  fastify.broadcastAll = function (payload) {
    broadcast(payload);
  };

  // Broadcast message updates to all users in the room
  fastify.broadcastMessageUpdated = function (roomId, messageId, content, userId, login) {
    broadcastMessageUpdated(roomId, messageId, content, userId, login);
  };
  
  // Broadcast message deletions to all users in the room
  fastify.broadcastMessageDeleted = function (roomId, messageId, userId, login) {
    broadcastMessageDeleted(roomId, messageId, userId, login);
  };
  
  fastify.broadcastRoomDeletion = function (roomId) {
    broadcastRoomDeletion(roomId);
  };
  
  fastify.broadcastToUser = function (userId, payload) {
    const userClients = clientsByUser.get(userId);
    if (userClients) {
      const data = JSON.stringify(payload);
      userClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          try {
            if (payload && payload.type === 'user_verified') {
              client.isVerified = true;
            }
            client.send(data);
          } catch (err) {
            if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
              fastify.log.error('broadcastToUser send error:', err);
            }
          }
        }
      });
    }
  };
  
  // Export the userByClient map so other modules can access it
  fastify.ws = {
    wss,
    clientsByUser,
    userByClient
  };

  fastify.broadcastRoomCreated = broadcastRoomCreated;
  fastify.broadcastRoomUpdated = broadcastRoomUpdated;
  fastify.broadcastRoomsChanged = broadcastRoomsChanged;
  fastify.broadcastRoomNotification = function (roomId, payload) {
    const room = getRoom(fastify.db, roomId);
    if (!room) return;
    broadcastToRoomAudience(room, payload);
  };
  fastify.broadcastRoomMessagesCleared = broadcastRoomMessagesCleared;
  fastify.broadcastUserRoleChanged = broadcastUserRoleChanged;
  fastify.broadcastUserUpdated = broadcastUserUpdated;
  fastify.broadcastInvitesChanged = broadcastInvitesChanged;
  fastify.broadcastVerificationCodesChanged = broadcastVerificationCodesChanged;
  fastify.broadcastVerificationPendingChanged = broadcastVerificationPendingChanged;
  fastify.broadcastVerificationSettingsUpdated = broadcastVerificationSettingsUpdated;
  fastify.broadcastServerSettingsUpdated = broadcastServerSettingsUpdated;

  fastify.notifyServerShutdown = function (message) {
    const text = message || 'Server is shutting down';
    const payload = JSON.stringify({
      type: 'server_shutdown',
      message: text,
    });
    wss.clients.forEach((c) => {
      if (c.readyState !== WebSocket.OPEN) return;
      try {
        c.send(payload);
      } catch (err) {
        fastify.log.warn({ err }, 'notifyServerShutdown send failed');
      }
      try {
        c.close(1001, 'Server shutdown');
      } catch (err2) {
        fastify.log.warn({ err: err2 }, 'notifyServerShutdown close failed');
      }
    });
  };
};