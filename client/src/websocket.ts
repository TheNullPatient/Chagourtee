import { logger } from './utils/logger';
import { redirectToConnectionError } from './api';

// Use the cross-environment compatible timeout types
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;
const reconnectDelay = 3000; // 3 seconds

// Handlers for messages and connection events
const messageHandlers: Set<(data: any) => void> = new Set();
const openHandlers: Set<() => void> = new Set();

// Track rooms we've joined so we can rejoin on reconnect
const joinedRooms: Set<number> = new Set();

/**
 * Initialize WebSocket connection
 */
export function initializeWebSocket() {
  if (sharedWebSocket && sharedWebSocket.readyState !== WebSocket.CLOSED) {
    logger.debug('WebSocket already exists with readyState:', sharedWebSocket.readyState);
    return sharedWebSocket;
  }

  try {
    logger.debug('Initializing WebSocket connection');
    sharedWebSocket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);

    sharedWebSocket.onopen = () => {
      logger.info('WebSocket connected');
      reconnectAttempts = 0; // Reset attempts on successful connection
      
      // Send any pending join requests
      joinedRooms.forEach(roomId => {
        if (sharedWebSocket?.readyState === WebSocket.OPEN) {
          sharedWebSocket.send(JSON.stringify({ type: 'join', roomId }));
          logger.debug(`Re-sent join request for room ${roomId}`);
        }
      });
      
      // Call all registered open handlers
      openHandlers.forEach(handler => handler());
    };

    sharedWebSocket.onmessage = (event) => {
      let data;

      try {
        data = JSON.parse(event.data);
      } catch (error) {
        logger.warn('Could not parse websocket message as JSON', event.data);
        return;
      }

      if (data.type === 'pong') {
        logger.debug('Received pong');
        return;
      }

      // Handle user disconnected message
      if (data.type === 'user_disconnected') {
        // Call all registered message handlers
        messageHandlers.forEach(handler => handler(data));
        return;
      }

      // Handle user connected message
      if (data.type === 'user_connected') {
        // Call all registered message handlers
        messageHandlers.forEach(handler => handler(data));
        return;
      }

      // Call all registered message handlers
      messageHandlers.forEach(handler => handler(data));
    };

    sharedWebSocket.onclose = (event) => {
      logger.info('WebSocket disconnected:', event.code, event.reason);
      
      // Clear heartbeat
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }

      // Don't try to reconnect if closed intentionally
      if (event.code === 1000) {
        logger.debug('WebSocket closed normally');
        return;
      }

      // Reconnect logic
      if (reconnectAttempts < maxReconnectAttempts) {
        logger.info(`Attempting to reconnect... (${reconnectAttempts + 1}/${maxReconnectAttempts})`);
        reconnectTimeout = setTimeout(() => {
          reconnectAttempts++;
          initializeWebSocket();
        }, reconnectDelay);
      } else {
        logger.error('Max reconnection attempts reached');
        // Redirect to connection error page after max attempts
        redirectToConnectionError('websocket_error', 'Превышено максимальное количество попыток переподключения');
      }
    };
    
    sharedWebSocket.onerror = (error) => {
      logger.error('WebSocket error:', error);
    };
  } catch (error) {
    logger.error('Error initializing WebSocket:', error);

    // Reconnect logic for initialization errors
    if (reconnectAttempts < maxReconnectAttempts) {
      logger.info(`Attempting to reconnect... (${reconnectAttempts + 1}/${maxReconnectAttempts})`);
      reconnectTimeout = setTimeout(() => {
        reconnectAttempts++;
        initializeWebSocket();
      }, reconnectDelay);
    } else {
      logger.error('Max reconnection attempts reached');
      redirectToConnectionError('websocket_error', (error as Error).message);
    }
  }

  // Start heartbeat once connected
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }

  // Send ping every 30 seconds to keep connection alive
  heartbeatInterval = setInterval(() => {
    if (sharedWebSocket?.readyState === WebSocket.OPEN) {
      logger.debug('Sending ping...');
      sharedWebSocket.send(JSON.stringify({ type: 'ping' }));
    } else {
      logger.warn('WebSocket not open, stopping heartbeat');
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
    }
  }, 30000); // 30 seconds

  return sharedWebSocket;
}

// Store the WebSocket instance globally
let sharedWebSocket: WebSocket | null = null;

/**
 * Get the current WebSocket instance
 */
export function getWebSocket(): WebSocket | null {
  return sharedWebSocket;
}

/**
 * Close the WebSocket connection gracefully
 */
export function closeWebSocket() {
  // Clear heartbeat
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  
  // Clear any reconnect attempt
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  // Close the WebSocket if it exists
  if (sharedWebSocket) {
    sharedWebSocket.close(1000, 'Closing WebSocket');
    sharedWebSocket = null;
  }
}

/**
 * Add a message handler
 */
export function addMessageHandler(handler: (data: any) => void) {
  messageHandlers.add(handler);
}

/**
 * Remove a message handler
 */
export function removeMessageHandler(handler: (data: any) => void) {
  messageHandlers.delete(handler);
}

/**
 * Add an open handler
 */
export function addOpenHandler(handler: () => void) {
  openHandlers.add(handler);
}

/**
 * Remove an open handler
 */
export function removeOpenHandler(handler: () => void) {
  openHandlers.delete(handler);
}

/**
 * Join a room
 */
export function joinRoom(roomId: number) {
  if (!sharedWebSocket) {
    logger.error('Cannot join room: WebSocket not initialized');
    return;
  }

  if (sharedWebSocket.readyState !== WebSocket.OPEN) {
    logger.error('Cannot join room: WebSocket not open');
    return;
  }

  sharedWebSocket.send(JSON.stringify({ type: 'join', roomId }));
  logger.debug(`Joined room ${roomId}`);

  // Track that we've joined this room
  joinedRooms.add(roomId);
}

/**
 * Leave a room
 */
export function leaveRoom(roomId: number) {
  if (!sharedWebSocket) {
    logger.error('Cannot leave room: WebSocket not initialized');
    return;
  }

  if (sharedWebSocket.readyState !== WebSocket.OPEN) {
    logger.error('Cannot leave room: WebSocket not open');
    return;
  }

  sharedWebSocket.send(JSON.stringify({ type: 'leave', roomId }));
  logger.debug(`Left room ${roomId}`);

  // Stop tracking that we're in this room
  joinedRooms.delete(roomId);
}

/**
 * Send a message to a room
 */
export function sendMessage(roomId: number, message: string) {
  if (!sharedWebSocket) {
    logger.error('Cannot send message: WebSocket not initialized');
    return;
  }

  if (sharedWebSocket.readyState !== WebSocket.OPEN) {
    logger.error('Cannot send message: WebSocket not open');
    return;
  }

  sharedWebSocket.send(JSON.stringify({ type: 'message', roomId, message }));
  logger.debug(`Sent message to room ${roomId}: ${message}`);
}

/**
 * Check if WebSocket is connected
 */
export function isWebSocketConnected(): boolean {
  return sharedWebSocket !== null && sharedWebSocket.readyState === WebSocket.OPEN;
}