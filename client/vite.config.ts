import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies API and WebSocket traffic to the backend. Set
// SERVER_ORIGIN=https://127.0.0.1:3000 when the backend runs with
// SECURE_CONNECTION=true and therefore speaks HTTPS/WSS.
const serverOrigin =
  process.env.CHAGOURTEE_SERVER_ORIGIN ||
  process.env.SERVER_ORIGIN ||
  'http://127.0.0.1:3000';
const wsOrigin = serverOrigin.replace(/^http/i, 'ws');

// Create a custom plugin to handle WebSocket errors
const handleWebSocketErrors = () => ({
  name: 'handle-websocket-errors',
  configureServer(server) {
    server.httpServer?.on('upgrade', (req, socket, head) => {
      // Handle WebSocket upgrade requests
      // When the client disconnects abruptly, this will handle the connection cleanup gracefully
      socket.on('error', (err) => {
        if (err && (err as any).code === 'ECONNRESET') {
          // This is a normal disconnection event, don't log as error
          console.debug('WebSocket connection reset (normal during disconnection):', (err as any).code);
        } else {
          console.error('WebSocket error during upgrade:', err);
        }
      });
    });
  }
});

export default defineConfig({
  plugins: [react(), handleWebSocketErrors()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: true, // Use boolean true instead of string 'all'
    proxy: {
      '/api': {
        target: serverOrigin,
        changeOrigin: true,
        secure: false // Accept self-signed certificates if needed
      },
      '/ws': {
        target: wsOrigin,
        ws: true,
        secure: false,
        changeOrigin: true,
      },
    },
  },
});