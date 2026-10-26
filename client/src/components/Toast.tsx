import React, { useCallback, useEffect, useRef, useState } from 'react';

interface ToastProps {
  message: string;
  type: 'success' | 'error';
  onClose: () => void;
  duration?: number;
}

const Toast: React.FC<ToastProps> = ({ message, type, onClose, duration = 5000 }) => {
  const [isVisible, setIsVisible] = useState(true);
  const [isExiting, setIsExiting] = useState(false);

  // Keep the latest onClose without restarting the auto-hide timer whenever
  // the parent re-renders and passes a new callback.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const closeToast = useCallback(() => {
    setIsExiting(true);
    setTimeout(() => {
      setIsVisible(false);
      onCloseRef.current();
    }, 300); // Match the CSS transition duration
  }, []);

  useEffect(() => {
    const timer = setTimeout(closeToast, duration);

    return () => {
      clearTimeout(timer);
    };
  }, [closeToast, duration]);

  if (!isVisible) return null;

  return (
    <div className={`toast toast-${type} ${isExiting ? 'toast-exit' : 'toast-enter'}`}>
      <div className="toast-content">
        <span className="toast-message">
          {type === 'success' && '✓ '}
          {message}
        </span>
        <button className="toast-close" onClick={closeToast}>&times;</button>
      </div>
    </div>
  );
};

export default Toast;