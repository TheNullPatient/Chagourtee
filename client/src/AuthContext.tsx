import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, User, isNetworkError, redirectToConnectionError, clearRedirectFlag, isRedirecting } from './api';
import { 
  initializeWebSocket, 
  closeWebSocket, 
  addMessageHandler, 
  removeMessageHandler,
  addOpenHandler,
  removeOpenHandler,
  isWebSocketConnected 
} from './websocket';
import { logger } from './utils/logger'; // Import our logger
import { errorTranslations } from './localization/errors';

type AuthContextType = {
  user: User | null;
  loading: boolean;
  login: (login: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  setUser: (user: User | null) => void;
};

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  // Message handler for auth-related events
  const handleMessage = (data: any) => {
    switch (data.type) {
      case 'user_deleted':
        // Use a more robust comparison to handle potential type differences
        // and check that user is not null
        if (user && Number(data.userId) === Number(user.id)) {
          // Navigate to account deleted page instead of showing alert
          navigate(`/account-deleted?reason=${encodeURIComponent(data.reason || 'Администратором')}`);
        }
        break;
        
      case 'user_verified':
        if (user && Number(data.userId) === Number(user.id)) {
          // Refresh user data to reflect verification status
          refresh();
        }
        break;
        
      case 'user_rejected':
        if (user && Number(data.userId) === Number(user.id)) {
          // Navigate to account rejected page instead of showing alert
          navigate(`/account-rejected?message=${encodeURIComponent(data.message || 'Ваша заявка на верификацию была отклонена')}`);
        }
        break;
        
      case 'user_updated':
      case 'user_role_changed':
      case 'user_verification_changed':
        // Update user data if the current user is affected
        if (user && data.user && Number(data.user.id) === Number(user.id)) {
          // Update the local user object with new data
          setUser(prevUser => {
            if (!prevUser) return prevUser;
            // Merge the old user object with the new data
            return { ...prevUser, ...data.user };
          });
        }
        break;
        
      case 'verification_settings_updated':
        // We could handle this if needed, but typically settings changes
        // would be noticed on subsequent page loads or API calls
        break;
    }
  };

  // Connect to WebSocket and handle events
  useEffect(() => {
    if (!user) {
      return;
    }

    // Initialize WebSocket connection
    initializeWebSocket();

    // Add message handler for auth-related events
    addMessageHandler(handleMessage);

    // Handle visibility change to manage WebSocket connection when tab is not active
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && !isWebSocketConnected()) {
        logger.debug('Tab became visible, attempting to reconnect to WebSocket...');
        initializeWebSocket();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Cleanup function
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      removeMessageHandler(handleMessage);
    };
  }, [user, navigate]); // Make sure to reinitialize when user changes

  const handleLogout = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch (error) {
      logger.error('Logout API error:', error);
    } finally {
      setUser(null);
      localStorage.removeItem('chagourtee_token'); // In case token was stored
      closeWebSocket(); // Close WebSocket on logout
      navigate('/login');
    }
  };

  const refresh = useCallback(async () => {
    if (!user) {
      try {
        const userData = await api<User>('/api/auth/me');
        setUser(userData);
      } catch (error) {
        // User is not logged in or session expired
        setUser(null);
      }
    } else {
      try {
        const userData = await api<User>('/api/auth/me');
        setUser(userData);
      } catch (error) {
        // Session may have expired
        setUser(null);
        navigate('/login');
      }
    }
  }, [user, navigate]);

  // A role or verification change made while the socket was down is never
  // replayed, so refresh identity after every reconnect.
  useEffect(() => {
    if (!user) return;
    const handleOpen = () => {
      void refresh();
    };
    addOpenHandler(handleOpen);
    return () => {
      removeOpenHandler(handleOpen);
    };
  }, [user, refresh]);

  useEffect(() => {
    const init = async () => {
      // If we're already in a redirect to connection-error, don't make API calls
      if (isRedirecting()) {
        setUser(null);
        setLoading(false);
        return;
      }

      try {
        const userData = await api<User>('/api/auth/me');
        setUser(userData);
      } catch (error) {
        if (isNetworkError(error)) {
          redirectToConnectionError('network_unreachable', (error as Error).message);
        } else {
          // Not authenticated
          setUser(null);
        }
      } finally {
        // Clear redirect flag on successful load or auth failure
        clearRedirectFlag();
        setLoading(false);
      }
    };

    init();
  }, []);

  const login = async (login: string, password: string) => {
    setLoading(true);
    try {
      const response = await api<{ user: User }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ login, password }),
      });
      setUser(response.user);
      navigate('/');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Ошибка входа';
      const translatedError = errorTranslations[errorMessage] || errorMessage;
      throw new Error(translatedError);
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    await handleLogout();
  };

  const value = {
    user,
    loading,
    login,
    logout,
    refresh,
    setUser,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

// Export the hook to allow other components to access the auth context
export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}