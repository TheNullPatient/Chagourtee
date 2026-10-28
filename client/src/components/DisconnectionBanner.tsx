import React, { useState, useEffect } from 'react';
import { isWebSocketConnected, addOpenHandler, removeOpenHandler, addMessageHandler, removeMessageHandler } from '../websocket';

interface DisconnectionBannerProps {
  className?: string;
}

const DisconnectionBanner: React.FC<DisconnectionBannerProps> = ({ className }) => {
  const [isVisible, setIsVisible] = useState(!isWebSocketConnected());
  const [message, setMessage] = useState('Соединение с сервером потеряно. Ожидание сети...');

  useEffect(() => {
    // Function to handle connection state changes
    const handleConnectionChange = () => {
      setIsVisible(!isWebSocketConnected());
    };

    // Add handlers for WebSocket events
    const openHandler = () => {
      setIsVisible(false);
      setMessage('Соединение с сервером потеряно. Ожидание сети...');
    };

    const messageHandler = (data: any) => {
      // A planned shutdown is different from a network failure.
      if (data && data.type === 'server_shutdown') {
        setMessage('Сервер перезапускается. Подключение восстановится автоматически...');
        setIsVisible(true);
        return;
      }
      // If we receive any message, we know we're connected
      if (data && typeof data === 'object') {
        setIsVisible(false);
      }
    };

    // Listen to WebSocket open events
    addOpenHandler(openHandler);
    // Listen to WebSocket message events
    addMessageHandler(messageHandler);

    // Poll for connection status every 3 seconds
    const intervalId = setInterval(() => {
      handleConnectionChange();
    }, 3000);

    // Initial check
    handleConnectionChange();

    // Cleanup function to remove event listeners and clear interval
    return () => {
      removeOpenHandler(openHandler);
      removeMessageHandler(messageHandler);
      clearInterval(intervalId);
    };
  }, []);

  if (!isVisible) {
    return null;
  }

  return (
    <div className={`disconnection-banner ${className}`}>
      <span>{message}</span>
    </div>
  );
};

export default DisconnectionBanner;