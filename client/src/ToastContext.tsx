import React, { createContext, useCallback, useContext, useRef, useState, ReactNode } from 'react';
import Toast from './components/Toast';

interface ToastContextType {
  showToast: (message: string, type: 'success' | 'error', duration?: number) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

interface ToastProviderProps {
  children: ReactNode;
}

interface ToastItem {
  id: number;
  message: string;
  type: 'success' | 'error';
  duration?: number;
}

export const ToastProvider: React.FC<ToastProviderProps> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // A counter keeps ids unique even when two toasts are shown in the same
  // millisecond, so one timeout cannot remove another toast.
  const nextToastId = useRef(1);

  // Stable identity: consumers use showToast in effect dependencies, and an
  // unstable callback made those effects re-run on every toast.
  const showToast = useCallback(
    (message: string, type: 'success' | 'error', duration?: number) => {
      const id = nextToastId.current++;
      setToasts((prev) => [
        ...prev,
        { id, message, type, duration }
      ]);

      // Auto-remove toast after its duration plus animation time
      setTimeout(() => {
        setToasts((prev) => prev.filter((toast) => toast.id !== id));
      }, (duration || 5000) + 300); // 300ms for exit animation
    },
    []
  );

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="toast-container">
        {toasts.map((toast) => (
          <Toast
            key={toast.id}
            message={toast.message}
            type={toast.type}
            duration={toast.duration}
            onClose={() => removeToast(toast.id)}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = (): ToastContextType => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
};