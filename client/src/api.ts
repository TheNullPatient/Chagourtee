const BASE = '';

export type ConnectionErrorReason = 'network_unreachable' | 'server_unavailable' | 'timeout' | 'api_error' | 'websocket_error';

const CONNECTION_ERROR_KEY = 'chagourtee_connection_error';
const REDIRECT_IN_PROGRESS_KEY = 'chagourtee_redirecting';

/**
 * Check if a redirect to connection error is already in progress
 */
export function isRedirecting(): boolean {
  try {
    return sessionStorage.getItem(REDIRECT_IN_PROGRESS_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Redirect to connection error page with reason and optional details
 */
export function redirectToConnectionError(reason: ConnectionErrorReason, details?: string): void {
  // Prevent infinite redirect loops
  try {
    if (sessionStorage.getItem(REDIRECT_IN_PROGRESS_KEY)) {
      // Already redirecting, don't stack more redirects
      return;
    }
    sessionStorage.setItem(REDIRECT_IN_PROGRESS_KEY, '1');
    sessionStorage.setItem(
      CONNECTION_ERROR_KEY,
      JSON.stringify({ reason, details })
    );
  } catch {
    /* ignore storage errors */
  }
  window.location.href = '/connection-error';
}

/**
 * Clear redirect flag (call after successful API response)
 */
export function clearRedirectFlag(): void {
  try {
    sessionStorage.removeItem(REDIRECT_IN_PROGRESS_KEY);
  } catch {
    /* ignore */
  }
}

export type StoredConnectionError = {
  reason: ConnectionErrorReason | null;
  details: string | null;
};

// Remembers the consumed error so repeated reads (e.g. React StrictMode
// re-rendering the page) still see the same values after the storage entry
// has been removed.
let cachedConnectionError: StoredConnectionError | null = null;

/**
 * Read and clear the connection error recorded by redirectToConnectionError().
 */
export function consumeConnectionError(): StoredConnectionError {
  if (cachedConnectionError) return cachedConnectionError;

  let result: StoredConnectionError = { reason: null, details: null };
  try {
    const stored = sessionStorage.getItem(CONNECTION_ERROR_KEY);
    if (stored) {
      const data = JSON.parse(stored);
      result = {
        reason: typeof data?.reason === 'string' ? data.reason : null,
        details: typeof data?.details === 'string' && data.details ? data.details : null,
      };
      sessionStorage.removeItem(CONNECTION_ERROR_KEY);
    }
  } catch {
    result = { reason: null, details: null };
  }

  cachedConnectionError = result;
  return result;
}

/**
 * Check if an error is a network-level error (not HTTP error)
 */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) {
    // Network errors in fetch manifest as TypeError with specific messages
    const message = error.message.toLowerCase();
    return (
      message.includes('fetch') ||
      message.includes('network') ||
      message.includes('failed to fetch') ||
      message.includes('networkerror') ||
      message.includes('connection') ||
      message.includes('abort')
    );
  }
  return false;
}

export type VersionInfo = {
  version: string;
  name: string;
  release: string;
};

export type User = {
  id: number;
  login: string;
  role: 'owner' | 'moderator' | 'member';
  verified: boolean;
};

export type Room = {
  id: number;
  name: string;
  created_at: string;
  message_count?: number;
  unread_count?: number;
};

export type MediaFile = {
  id: number;
  original_name: string;
  encrypted_filename: string;
  mime_type: string;
  file_size: number;
};

export type MediaUploadSettings = {
  uploadsEnabled: boolean;
  unlimited: boolean;
  maxFileSize: number | null;
  storage?: {
    maxStorageSize: number | null;
    cleanupStrategy: 'block' | 'delete_oldest';
    totalBytes: number;
    filesCount: number;
  };
};

export type MediaStorageSettings = {
  maxFileSize: number | null;
  maxStorageSize: number | null;
  cleanupStrategy: 'block' | 'delete_oldest';
  orphanCleanupEnabled: boolean;
  orphanCleanupIntervalMinutes: number;
  orphanCleanupGraceMinutes: number;
  totalBytes: number;
  filesCount: number;
};

export type Message = {
  id: number;
  room_id: number;
  user_id: number;
  body: string;
  mediaPosition?: 'above' | 'below';
  created_at: string;
  updated_at?: string; // Optional field for when message was last updated
  login: string;
  is_read?: 0 | 1;
  media?: MediaFile[]; // Optional array of media files attached to the message
};

export type MessageListResponse = {
  messages: Message[];
  first_unread_message_id: number | null;
};

export type Invite = {
  id: string;
  created_by: number;
  max_uses: number | null;
  uses_count: number;
  expires_at: string | null;
  created_at: string;
};

export type ServerSettings = {
  server_name: string | null;
};

export async function api<T>(
  path: string,
  opts: RequestInit = {}
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...opts,
      credentials: 'include',
      headers: {
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
    });
  } catch (error) {
    // Network error (e.g., server unreachable)
    if (isNetworkError(error)) {
      redirectToConnectionError('network_unreachable', (error as Error).message);
      return new Promise<T>(() => {});
    }
    throw error;
  }

  // Check if response status is 500 and redirect to error page
  if (res.status === 500) {
    // Peek at response to detect if it's from proxy (HTML) or server (JSON)
    const contentType = res.headers.get('content-type') || '';
    const isProxyError = contentType.includes('text/html');
    
    if (isProxyError) {
      // Proxy error (e.g., Vite dev server can't reach backend)
      redirectToConnectionError('server_unavailable', `Proxy error for ${path}`);
      return new Promise<T>(() => {});
    }

    // Store the error details in sessionStorage for the error page to display
    sessionStorage.setItem('lastErrorStatus', res.status.toString());
    sessionStorage.setItem('lastErrorUrl', path);

    // Redirect to the 500 error page
    window.location.href = '/500';
    // This promise will never resolve since we're redirecting
    return new Promise<T>(() => {});
  }

  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // If parsing fails, check if it's a 500 error situation
    if (res.status === 500) {
      sessionStorage.setItem('lastErrorStatus', res.status.toString());
      sessionStorage.setItem('lastErrorUrl', path);
      window.location.href = '/500';
      return new Promise<T>(() => {});
    }
    throw new Error(res.ok ? text : `HTTP ${res.status}`);
  }

  if (!res.ok) {
    // Handle other non-OK responses that aren't 500
    const err = data as { error?: string };
    throw new Error(err?.error || `HTTP ${res.status}`);
  }
  
  // Success - clear any redirect flag
  clearRedirectFlag();
  
  return data as T;
}

export const auth = {
  me: () => api<User>('/api/auth/me'),
  login: (login: string, password: string) =>
    api<{ user: User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ login, password }),
    }),
  logout: () => api<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  register: (body: {
    inviteId?: string;
    login: string;
    password: string;
    comment?: string;
    bootstrap?: string;
  }) =>
    api<{ user: User }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

export const rooms = {
  list: () => api<{ rooms: Room[] }>('/api/rooms'),
  create: (name: string) =>
    api<Room>('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  update: (id: number, name: string) =>
    api<Room>(`/api/rooms/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  delete: (id: number) =>
    api<{ ok: boolean }>(`/api/rooms/${id}`, { method: 'DELETE' }),
  clearMessages: (id: number) =>
    api<{ ok: boolean, message: string }>(`/api/rooms/${id}/messages`, { method: 'DELETE' }),
};

export const messages = {
  list: (roomId: number, params?: { limit?: number; before?: number }) => {
    const sp = new URLSearchParams();
    if (params?.limit) sp.set('limit', String(params.limit));
    if (params?.before) sp.set('before', String(params.before));
    const q = sp.toString();
    return api<MessageListResponse>(
      `/api/rooms/${roomId}/messages${q ? `?${q}` : ''}`
    );
  },
  send: (roomId: number, body: string, media_ids?: number[], mediaPosition?: 'above' | 'below') =>
    api<Message>(`/api/rooms/${roomId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body, media_ids, mediaPosition }),
    }),
  edit: (messageId: number, roomId: number, body: string, media_ids?: number[], mediaPosition?: 'above' | 'below') =>
    api<Message>(`/api/rooms/${roomId}/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ body, media_ids, mediaPosition }),
    }),
  delete: (messageId: number, roomId: number) =>
    api<{ ok: boolean }>(`/api/rooms/${roomId}/messages/${messageId}`, { 
      method: 'DELETE' 
    }),
  deleteMultiple: (roomId: number, messageIds: number[]) =>
    api<{ ok: boolean, count: number }>(`/api/rooms/${roomId}/messages/batch-delete`, {
      method: 'DELETE',
      body: JSON.stringify({ messageIds }),
    }),
  markRead: (roomId: number, lastReadMessageId: number) =>
    api<{ ok: boolean; marked: number; lastReadMessageId?: number }>(
      `/api/rooms/${roomId}/read`,
      {
        method: 'POST',
        body: JSON.stringify({ lastReadMessageId }),
      }
    ),
};

export const media = {
  upload: (file: File, onProgress?: (progress: number) => void) => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const formData = new FormData();
      formData.append('file', file);

      xhr.open('POST', '/api/upload', true);
      xhr.withCredentials = true;

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          const percentComplete = (event.loaded / event.total) * 100;
          onProgress?.(percentComplete);
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          let payload: { error?: string; code?: string; maxFileSize?: number | null; maxStorageSize?: number; currentStorageSize?: number; cleanupStrategy?: string } | null = null;
          try {
            payload = xhr.responseText ? JSON.parse(xhr.responseText) : null;
          } catch {
            payload = null;
          }
          const err = new Error(payload?.error || xhr.responseText || `HTTP ${xhr.status}`) as Error & {
            status?: number;
            code?: string;
            maxFileSize?: number | null;
            maxStorageSize?: number;
            currentStorageSize?: number;
            cleanupStrategy?: string;
          };
          err.status = xhr.status;
          err.code = payload?.code;
          err.maxFileSize = payload?.maxFileSize ?? null;
          err.maxStorageSize = payload?.maxStorageSize;
          err.currentStorageSize = payload?.currentStorageSize;
          err.cleanupStrategy = payload?.cleanupStrategy;
          reject(err);
        }
      };

      xhr.onerror = () => {
        reject(new Error('Network error'));
      };

      xhr.send(formData);
    });
  },
  
  getMediaUrl: (filename: string) => {
    return `/api/media/${filename}`;
  },
  settings: () => api<MediaUploadSettings>('/api/media/settings'),
  getStorageSettings: () => api<MediaStorageSettings>('/api/media/storage-settings'),
  updateStorageSettings: (body: {
    maxFileSize: number | null;
    maxStorageSize: number | null;
    cleanupStrategy: 'block' | 'delete_oldest';
    orphanCleanupEnabled: boolean;
    orphanCleanupIntervalMinutes: number;
    orphanCleanupGraceMinutes: number;
  }) =>
    api<MediaStorageSettings>('/api/media/storage-settings', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

export const invites = {
  list: () => api<{ invites: Invite[] }>('/api/invites'),
  create: (opts?: { maxUses?: number; expiresInHours?: number }) =>
    api<Invite>('/api/invites', {
      method: 'POST',
      body: JSON.stringify(opts || {}),
    }),
  delete: (id: string) =>
    api<{ ok: boolean }>(`/api/invites/${id}`, { method: 'DELETE' }),
};

export const serverSettings = {
  get: () => api<ServerSettings>('/api/server/settings'),
  update: (server_name: string) =>
    api<ServerSettings>('/api/server/settings', {
      method: 'POST',
      body: JSON.stringify({ server_name }),
    }),
};

export const serverVersion = {
  get: () => api<VersionInfo>('/api/version'),
};

export const verification = {
  status: () => api<{ enabled: boolean }>('/api/verification/status'),
  settings: () => api<{ enabled: boolean, deleteCommentOnApprove: boolean }>('/api/verification/settings'),
  updateSettings: (settings: { enabled?: boolean; deleteCommentOnApprove?: boolean }) =>
    api<{ ok: boolean, enabled: boolean, deleteCommentOnApprove: boolean }>('/api/verification/settings', {
      method: 'POST',
      body: JSON.stringify(settings),
    }),
  pending: () => api<{ pending: { id: number; login: string; created_at: string; registration_comment: string | null }[] }>('/api/verification/pending'),
  approve: (userId: number) =>
    api<{ ok: boolean }>('/api/verification/approve', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),
  reject: (userId: number) =>
    api<{ ok: boolean }>('/api/verification/reject', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),
  listCodes: () => 
    api<{ codes: {id: number, created_by_login: string, used: number, created_at: string, expires_at: string}[] }>('/api/verification/codes'),
  createCode: (customCode?: string) => 
    api<{ code: string, id: number, expires_at: string }>('/api/verification/codes', {
      method: 'POST',
      body: JSON.stringify({ code: customCode }),
    }),
  updateCode: (id: number, expiresAt: string) => 
    api<{ ok: boolean }>('/api/verification/codes/' + id, {
      method: 'PATCH',
      body: JSON.stringify({ expiresAt }),
    }),
  useCode: (code: string) => 
    api<{ ok: boolean }>('/api/verification/codes/use', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  deleteCode: (id: number) => 
    api<{ ok: boolean }>('/api/verification/codes/' + id, {
      method: 'DELETE',
    }),
};

export const users = {
  list: () =>
    api<{ users: (User & { created_at: string })[] }>('/api/users'),
  online: () =>
    api<{ onlineUserIds: number[] }>('/api/users/online'),
  changeRole: (userId: number, role: 'owner' | 'moderator' | 'member') =>
    api<{ ok: boolean }>(`/api/users/${userId}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    }),
  delete: (userId: number, reason?: string) =>
    api<{ ok: boolean }>(`/api/users/${userId}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason }),
    }),
};

export const profile = {
  changePassword: (currentPassword: string, newPassword: string) =>
    api<{ ok: boolean }>('/api/profile/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  changeLogin: (password: string, newLogin: string) =>
    api<{ ok: boolean, login: string }>('/api/profile/change-login', {
      method: 'POST',
      body: JSON.stringify({ password, newLogin }),
    }),
  getRegistrationComment: () =>
    api<{ comment: string | null }>('/api/profile/registration-comment'),
  updateRegistrationComment: (comment: string) =>
    api<{ ok: boolean, comment: string | null }>('/api/profile/registration-comment', {
      method: 'PATCH',
      body: JSON.stringify({ comment }),
    }),
};

// Export WebSocket related functions
export { 
  getWebSocket, 
  addMessageHandler, 
  removeMessageHandler,
  isWebSocketConnected,
  addOpenHandler,
  removeOpenHandler
} from './websocket';