import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import type { Room, Message, User, MessageListResponse, MediaFile, MediaUploadSettings } from '../api';
import { rooms as roomsApi, messages as messagesApi, users, media } from '../api';
import {
  getWebSocket,
  addMessageHandler,
  removeMessageHandler,
  initializeWebSocket,
  addOpenHandler,
  removeOpenHandler,
  isWebSocketConnected,
  leaveRoom
} from '../websocket'; // Import WebSocket manager
import { logger } from '../utils/logger'; // Import our logger
// Import the custom hook
import { useMessageInputBehavior } from '../hooks/useMessageInputBehavior';
import MarkdownMessage from '../components/MarkdownMessage'; // Import MarkdownMessage component
import Marquee from '../components/Marquee'; // Import Marquee component
import { playIncoming, playMention, playSent } from '../sounds';
import { ensureNotificationPermission, showMessageNotification } from '../notifications';
import { useUserListPanel } from '../UserListPanelContext';
import { useToast } from '../ToastContext';
import { useAuth } from '../AuthContext';
import ConfirmModal from '../components/ConfirmModal';
import InfoModal from '../components/InfoModal';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { TabletBottomNav } from '../components/TabletBottomNav';
import { IconHome, IconLock, IconUsers } from '../components/icons/Icons';
import { errorTranslations } from '../localization/errors';
import { useChatChrome } from '../ChatChromeContext';

// How long the user may skip re-entering a room password. 0 = ask on every visit.
const UNLOCK_REMEMBER_OPTIONS: Array<{ value: number | null; label: string }> = [
  { value: 0, label: 'Спрашивать каждый раз' },
  { value: 5, label: '5 минут' },
  { value: 15, label: '15 минут' },
  { value: 30, label: '30 минут' },
  { value: 60, label: '1 час' },
  { value: 120, label: '2 часа' },
  { value: 300, label: '5 часов' },
  { value: 1440, label: '1 день' },
  { value: null, label: 'Никогда' },
];
const UNLOCK_REMEMBER_STORAGE_KEY = 'chagourtee:roomUnlockRemember';
const UNLOCK_REMEMBER_NEVER = 'never';

// Errors returned by the server when the room access was lost (e.g. a
// remembered password expired while the room was open).
const ROOM_ACCESS_ERRORS = new Set(['Room is locked', 'Room access denied']);
function isRoomAccessError(error: unknown): boolean {
  return error instanceof Error && ROOM_ACCESS_ERRORS.has(error.message);
}

// Global type extensions used by the drag-and-drop folder handling below
declare global {
  interface FileSystemEntry {
    readonly isFile: boolean;
    readonly isDirectory: boolean;
    readonly name: string;
  }

  interface FileSystemFileEntry extends FileSystemEntry {
    file(successCallback: (file: File) => void, errorCallback?: (error: Error) => void): void;
  }

  interface FileSystemDirectoryEntry extends FileSystemEntry {
    createReader(): FileSystemDirectoryReader;
  }

  interface FileSystemDirectoryReader {
    readEntries(
      successCallback: (entries: FileSystemEntry[]) => void,
      errorCallback?: (error: Error) => void
    ): void;
  }
}

type TypingUser = {
  userId: number;
  login: string;
};

// Add a helper function to get user role by user ID
const getUserRoleById = (userId: number, allUsers: User[]) => {
  const user = allUsers.find(u => u.id === userId);
  return user?.role;
};

function formatTypingUsers(users: TypingUser[]): string | null {
  if (!users.length) return null;

  const names = users.map((u) => u.login);

  if (names.length === 1) {
    return names[0]!;
  }

  if (names.length === 2) {
    return `${names[0]} и ${names[1]}`;
  }

  if (names.length === 3) {
    return `${names[0]}, ${names[1]} и ${names[2]}`;
  }

  // 4 и более: показываем первых трёх и "и др."
  return `${names[0]}, ${names[1]}, ${names[2]} и др.`;
}

function formatBytes(size: number): string {
  if (size === 0) return '0 Б';
  if (size >= 1024 * 1024 * 1024) return `${(size / (1024 * 1024 * 1024)).toFixed(2)} ГиБ`;
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(2)} МиБ`;
  if (size >= 1024) return `${(size / 1024).toFixed(2)} КиБ`;
  return `${size} Б`;
}

function formatReplyPreview(body: string, maxLength = 120): string {
  const normalized = body.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Вложение';
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1)}…`
    : normalized;
}

/**
 * Preview for a file selected from disk.
 *
 * The blob URL is created and revoked inside an effect instead of during
 * render, otherwise every re-render leaks a new object URL.
 */
function LocalFilePreview({ file }: { file: File }) {
  const imageRef = useRef<HTMLImageElement | null>(null);

  useLayoutEffect(() => {
    if (!file.type.startsWith('image/')) return;

    const objectUrl = URL.createObjectURL(file);
    if (imageRef.current) {
      imageRef.current.src = objectUrl;
    }

    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  if (file.type.startsWith('image/')) {
    return (
      <div className="file-preview">
        <img ref={imageRef} alt="Preview" />
      </div>
    );
  }

  if (file.type.startsWith('video/')) {
    return (
      <div className="file-preview video-preview">
        <div className="video-placeholder">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="23 7 16 12 23 17 23 7"></polygon>
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
          </svg>
        </div>
      </div>
    );
  }

  if (file.type.startsWith('audio/')) {
    return (
      <div className="file-preview audio-preview">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 18V5l12-2v13"></path>
          <circle cx="6" cy="18" r="3"></circle>
          <circle cx="18" cy="16" r="3"></circle>
        </svg>
      </div>
    );
  }

  const ext = file.name.split('.').pop()?.substring(0, 3) || 'FILE';
  return <div className="file-preview other">{ext.toUpperCase()}</div>;
}

function getUploadErrorMessage(
  error: unknown,
  fallbackMaxFileSize: number | null | undefined
): string {
  if (!(error instanceof Error)) return 'Не удалось загрузить файл.';
  const uploadError = error as Error & { code?: string; maxFileSize?: number | null; maxStorageSize?: number; currentStorageSize?: number; cleanupStrategy?: string };
  if (uploadError.code === 'MEDIA_UPLOAD_DISABLED') {
    return 'Загрузка файлов отключена настройками сервера.';
  }
  if (uploadError.code === 'MEDIA_STORAGE_QUOTA_EXCEEDED') {
    const maxSize = uploadError.maxStorageSize;
    const currentSize = uploadError.currentStorageSize;
    const strategy = uploadError.cleanupStrategy;
    if (strategy === 'delete_oldest') {
      return 'Хранилище заполнено. Не удалось освободить место. Удалите старые сообщения или попросите владельца увеличить лимит.';
    }
    return maxSize && currentSize
      ? `Хранилище заполнено: ${formatBytes(currentSize)} из ${formatBytes(maxSize)}. Удалите старые файлы или попросите владельца увеличить лимит.`
      : 'Хранилище заполнено. Удалите старые файлы или попросите владельца увеличить лимит.';
  }
  if (uploadError.code === 'MEDIA_FILE_TOO_LARGE') {
    const maxSize = uploadError.maxFileSize ?? fallbackMaxFileSize;
    return maxSize
      ? `Файл превышает лимит ${formatBytes(maxSize)}.`
      : 'Файл превышает допустимый размер.';
  }
  return uploadError.message || 'Не удалось загрузить файл.';
}

export default function Chat() {
  const { roomId: routeRoomId } = useParams();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    confirmText?: string;
    cancelText?: string;
    variant?: 'danger' | 'warning' | 'info';
  }>({ isOpen: false, title: '', message: '', onConfirm: () => {} });
  const [uploadInfoModalOpen, setUploadInfoModalOpen] = useState(false);
  
  const roomId = routeRoomId ? Number(routeRoomId) : null;
  const [roomList, setRoomList] = useState<Room[]>([]);
  const [roomsLoaded, setRoomsLoaded] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [lockingRoom, setLockingRoom] = useState(false);
  const [unlockRememberMinutes, setUnlockRememberMinutes] = useState<number | null>(() => {
    try {
      const stored = localStorage.getItem(UNLOCK_REMEMBER_STORAGE_KEY);
      if (stored === UNLOCK_REMEMBER_NEVER) return null;
      const value = Number(stored);
      return UNLOCK_REMEMBER_OPTIONS.some((option) => option.value === value) ? value : 0;
    } catch {
      return 0;
    }
  });
  // Rooms unlocked "for this visit only", so they can be locked again when the
  // user leaves them even if the socket could not deliver the leave event.
  const ephemeralUnlockedRoomsRef = useRef<Set<number>>(new Set());
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [sendText, setSendText] = useState('');
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);
  const { user } = useAuth();
  const { setLockAction } = useChatChrome();
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    message: Message | null;
  }>({ visible: false, x: 0, y: 0, message: null });
  const [selectedMessages, setSelectedMessages] = useState<number[]>([]);
  const [editingMessage, setEditingMessage] = useState<{id: number, body: string, originalBody: string, media?: any[], mediaPosition?: string} | null>(null);
  const [originalMediaOnEditStart, setOriginalMediaOnEditStart] = useState<any[] | null>(null);  // Track original media when editing starts
  const typingIndicatorRef = useRef<HTMLDivElement>(null);
  const typingTimeoutsRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const hasConnectedRef = useRef(isWebSocketConnected());
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const longPressTimeout = useRef<ReturnType<typeof setTimeout> | null>(null); // Для обработки долгого нажатия
  const doubleClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null); // Таймер для отслеживания двойного клика
  const editMessageTextareaRef = useRef<HTMLTextAreaElement>(null); // Ref for the editing message textarea
  const messagesEndRef = useRef<HTMLDivElement>(null); // Ref for scroll-to-bottom button
  const [showScrollButton, setShowScrollButton] = useState(false); // State to control visibility of scroll button
  const [allUsers, setAllUsers] = useState<User[]>([]); // Keep track of all users to get their roles
  const [firstUnreadMessageId, setFirstUnreadMessageId] = useState<number | null>(null);
  const [onlineUserIds, setOnlineUserIds] = useState<Set<number>>(() => new Set());
  const [mentionedMessages, setMentionedMessages] = useState<Set<number>>(new Set()); // Track messages where user is mentioned
  const [mentionedRooms, setMentionedRooms] = useState<Set<number>>(new Set()); // Track rooms where user is mentioned
  // Mentions that arrived while the user was scrolled up in the current room.
  // The floating button steps through them and clears the ones already visited.
  const [unseenMentions, setUnseenMentions] = useState<Set<number>>(new Set());
  
  // State for media uploads
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState<Record<number, number>>({});
  const [mediaSettings, setMediaSettings] = useState<MediaUploadSettings | null>(null);
  const [storageUsage, setStorageUsage] = useState<{ totalBytes: number; maxStorageSize: number | null }>({
    totalBytes: 0,
    maxStorageSize: null
  });
  const [uploadWarning, setUploadWarning] = useState<string | null>(null);
  const mediaRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadMediaSettings = useCallback(() => {
    return media
      .settings()
      .then((settings) => {
        setMediaSettings(settings);
        setStorageUsage({
          totalBytes: settings.storage?.totalBytes ?? 0,
          maxStorageSize: settings.storage?.maxStorageSize ?? null,
        });
      })
      .catch((error) => console.error('Failed to load media settings:', error));
  }, []);

  const scheduleMediaSettingsRefresh = useCallback(() => {
    if (mediaRefreshTimeoutRef.current) clearTimeout(mediaRefreshTimeoutRef.current);
    mediaRefreshTimeoutRef.current = setTimeout(() => {
      mediaRefreshTimeoutRef.current = null;
      void loadMediaSettings();
    }, 300);
  }, [loadMediaSettings]);

  const isStorageFull = storageUsage.maxStorageSize !== null && storageUsage.maxStorageSize > 0
    ? storageUsage.totalBytes >= storageUsage.maxStorageSize
    : false;

  const storageUsagePercent = storageUsage.maxStorageSize !== null && storageUsage.maxStorageSize > 0
    ? Math.min(100, (storageUsage.totalBytes / storageUsage.maxStorageSize) * 100)
    : 0;

  const getStorageLimitLabel = useCallback(() => {
    if (!mediaSettings) return '';
    const storageLabel = storageUsage.maxStorageSize === null || storageUsage.maxStorageSize === 0
      ? 'Хранилище: без ограничений'
      : `Хранилище: ${formatBytes(storageUsage.totalBytes)} из ${formatBytes(storageUsage.maxStorageSize)}`;
    const fileLabel = !mediaSettings.uploadsEnabled
      ? 'Загрузка медиа отключена'
      : mediaSettings.unlimited
      ? `Лимит файла: без ограничений`
      : `Лимит файла: ${formatBytes(mediaSettings.maxFileSize || 0)}`;
    return `${fileLabel}. ${storageLabel}`;
  }, [mediaSettings, storageUsage]);

  // State for per-message media position (above or below text)
  const [mediaPositionDraft, setMediaPositionDraft] = useState<'above' | 'below'>('below');
  
  // Track whether user wants to stay at bottom
  const shouldAutoScrollRef = useRef(true);
  const lastReadMessageIdRef = useRef<Record<number, number>>({});
  const markRoomAsReadRef = useRef<() => void>(() => {});
  const skipAutoScrollRef = useRef(false);
  const prevMessagesRef = useRef<{ roomId: number | null; lastId: number | null; count: number }>({
    roomId: null,
    lastId: null,
    count: 0,
  });
  
  // Store scroll position to preserve it between room switches
  const scrollPositions = useRef<Record<number, number>>({}); // Store scroll position per room
  
  // Throttle accidental double submits. Longer limits are enforced by the
  // server, which answers 429 and is surfaced as a toast.
  const lastMessageTimeRef = useRef<number>(0);
  const rateLimitDelay = 300; // Minimum delay between messages in milliseconds

  useLayoutEffect(() => {
    const el = contextMenuRef.current;
    if (el && contextMenu.visible) {
      el.style.setProperty('--ctx-left', `${contextMenu.x}px`);
      el.style.setProperty('--ctx-top', `${contextMenu.y}px`);
    }
  }, [contextMenu.visible, contextMenu.x, contextMenu.y]);

  // Render upload warning
  const renderUploadWarning = () => {
    if (!uploadWarning) return null;
    return (
      <div className="rate-limit-warning-container">
        <div className="rate-limit-warning">{uploadWarning}</div>
      </div>
    );
  };

  const { isOpen: isUserListOpen, close: closeUserList, toggle: toggleUserList } =
    useUserListPanel();

  // Create ref for the user panel to detect clicks outside
  const userPanelRef = useRef<HTMLElement>(null);

  // State to track if we're in the 678-876px range
  const [isTabletInRange, setIsTabletInRange] = useState(
    typeof window !== 'undefined' 
      ? window.matchMedia('(min-width: 678px) and (max-width: 876px)').matches
      : false
  );

  // Effect to handle clicks outside the user panel
  useEffect(() => {
    if (!isUserListOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (userPanelRef.current && !userPanelRef.current.contains(event.target as Node)) {
        closeUserList();
      }
    };

    // Add event listener when panel is open
    document.addEventListener('mousedown', handleClickOutside);
    
    return () => {
      // Clean up event listener when component unmounts or panel closes
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isUserListOpen, closeUserList]);

  // Update tablet range state when window resizes
  useEffect(() => {
    const handleResize = () => {
      setIsTabletInRange(window.matchMedia('(min-width: 678px) and (max-width: 876px)').matches);
    };

    window.addEventListener('resize', handleResize);
    
    // Cleanup listener on unmount
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  // Load all users to get their roles
  const loadUsers = useCallback(async () => {
    try {
      const [usersResponse, onlineResponse] = await Promise.all([
        users.list(),
        users.online(),
      ]);
      setAllUsers(usersResponse.users);
      setOnlineUserIds(new Set(onlineResponse.onlineUserIds));
    } catch (error) {
      console.error('Failed to load users:', error);
    }
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  // Handle clicks outside the context menu
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(event.target as Node)) {
        setContextMenu({ visible: false, x: 0, y: 0, message: null });
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Load current user info
  useEffect(() => {
    ensureNotificationPermission();
  }, []);

  const loadRooms = useCallback(async () => {
    try {
      const { rooms } = await roomsApi.list();
      setRoomList(rooms);
    } catch (error) {
      console.error('Failed to load rooms:', error);
    } finally {
      setRoomsLoaded(true);
    }
  }, []);

  const activeRoom = roomId ? roomList.find((r) => r.id === roomId) : undefined;
  const activeRoomId = activeRoom?.id ?? null;
  const activeRoomLocked = Boolean(activeRoom?.locked);
  const activeRoomMissing = roomsLoaded && Boolean(roomId) && !activeRoom;
  const canJoinRoom = roomsLoaded && activeRoomId !== null && !activeRoomLocked;
  const isPrivilegedUser = user?.role === 'owner' || user?.role === 'moderator';
  // Locking only makes sense for password-protected rooms the user is inside.
  const canLockRoom =
    Boolean(roomId) && activeRoom?.access_level === 'closed' && !activeRoomLocked;

  // Function to update scroll button visibility based on scroll position
  const updateScrollButtonVisibility = useCallback(() => {
    const messagesContainer = document.querySelector('.chat-messages-wrap');
    if (messagesContainer) {
      const { scrollTop, scrollHeight, clientHeight } = messagesContainer as HTMLElement;
      const distanceToBottom = scrollHeight - scrollTop - clientHeight;

      // Show button only when:
      // 1. Distance to bottom is greater than 100px (user scrolled up significantly)
      // 2. Container is actually scrollable (content is taller than container)
      setShowScrollButton(distanceToBottom > 100 && scrollHeight > clientHeight);
    } else {
      // If there's no messages container (e.g. no room selected), hide the button
      setShowScrollButton(false);
    }
  }, []);

  const loadMessages = useCallback(async (id: number) => {
    setLoading(true);
    try {
      const { messages: list, first_unread_message_id }: MessageListResponse = await messagesApi.list(id);
      // Loading a message list is not a new incoming message: never auto-scroll
      // over a restored position just because the list was replaced.
      skipAutoScrollRef.current = true;
      setMessages(list);
      setFirstUnreadMessageId(first_unread_message_id ?? null);
      
      // Clear mentions for this room when loading messages
      setMentionedRooms(prev => {
        const newSet = new Set(prev);
        newSet.delete(id);
        return newSet;
      });
    } finally {
      setLoading(false);
      
      // Update scroll button visibility after messages are loaded and rendered
      setTimeout(updateScrollButtonVisibility, 0);
      
      // After loading messages, check if we should preserve scroll position or scroll to bottom
      setTimeout(() => {
        const messagesContainer = document.querySelector('.chat-messages-wrap');
        if (messagesContainer && roomId && scrollPositions.current[roomId] !== undefined) {
          // Restore the saved scroll position for this room
          messagesContainer.scrollTop = scrollPositions.current[roomId];
        }
      }, 0);
    }
  }, [updateScrollButtonVisibility, roomId]);

  useEffect(() => {
    // Access may have changed while the user was elsewhere, and a password
    // remembered for a limited time may have expired, so refresh the per-user
    // room list on every room switch before loading its messages.
    setRoomsLoaded(false);
    void loadRooms();
  }, [roomId, loadRooms]);

  // A password remembered "for this visit only" must not survive leaving the
  // room, even if the socket is down and cannot deliver the leave event.
  useEffect(() => {
    if (!roomId) return;
    const leavingRoomId = roomId;
    // The Set instance is created once with useRef and never reassigned.
    const ephemeralUnlockedRooms = ephemeralUnlockedRoomsRef.current;
    return () => {
      if (ephemeralUnlockedRooms.has(leavingRoomId)) {
        ephemeralUnlockedRooms.delete(leavingRoomId);
        roomsApi.lock(leavingRoomId).catch(() => {});
      }
    };
  }, [roomId]);

  // Mentions tracked for the floating button belong to the room they came from.
  useEffect(() => {
    setUnseenMentions(new Set());
  }, [roomId]);

  useEffect(() => {
    setReplyingTo(null);
    setUnlockPassword('');
    if (!roomId) {
      setMessages([]);
      setFirstUnreadMessageId(null);
      // When no room is selected, ensure scroll button is hidden and update visibility
      setTimeout(() => {
        setShowScrollButton(false);
        updateScrollButtonVisibility();
      }, 0);
      return;
    }

    // Wait until the room list is loaded: it tells us whether the room is
    // locked or hidden from this user, so we do not fire a doomed request.
    if (!roomsLoaded || activeRoomId === null || activeRoomLocked) {
      setMessages([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    loadMessages(roomId)
      .catch((error) => {
        const message =
          error instanceof Error ? error.message : 'Не удалось загрузить сообщения';
        if (isRoomAccessError(error)) {
          // The room locked itself again (expired password window or revoked
          // access) — refresh the list so the unlock panel takes over.
          void loadRooms();
        }
        showToast(errorTranslations[message] || message, 'error');
        setMessages([]);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [
    roomId,
    roomsLoaded,
    activeRoomId,
    activeRoomLocked,
    loadMessages,
    loadRooms,
    updateScrollButtonVisibility,
    showToast,
  ]);

  const handleUnlockRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomId || !unlockPassword) return;
    setUnlocking(true);
    try {
      const result = await roomsApi.unlock(roomId, unlockPassword, unlockRememberMinutes);
      if (result.ephemeral) {
        ephemeralUnlockedRoomsRef.current.add(roomId);
      } else {
        ephemeralUnlockedRoomsRef.current.delete(roomId);
      }
      setUnlockPassword('');
      await loadRooms();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Не удалось разблокировать комнату';
      showToast(errorTranslations[message] || message, 'error');
    } finally {
      setUnlocking(false);
    }
  };

  const handleUnlockRememberChange = (value: number | null) => {
    setUnlockRememberMinutes(value);
    try {
      localStorage.setItem(
        UNLOCK_REMEMBER_STORAGE_KEY,
        value === null ? UNLOCK_REMEMBER_NEVER : String(value)
      );
    } catch {
      // Private mode may block storage; the choice still works for this visit.
    }
  };

  const lockRoom = useCallback(
    async (forEveryone: boolean) => {
      if (!roomId) return;
      setLockingRoom(true);
      try {
        let message: string;
        if (forEveryone) {
          await roomsApi.lockAll(roomId);
          message = 'Комната заблокирована для всех';
        } else {
          await roomsApi.lock(roomId);
          ephemeralUnlockedRoomsRef.current.delete(roomId);
          message = 'Комната заблокирована';
        }
        setUnlockPassword('');
        // Refresh the list before showing the toast: the room is already locked
        // on the server, and the message effect must not try to load messages
        // in the short window before the UI knows about it.
        await loadRooms();
        showToast(message, 'success');
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Не удалось заблокировать комнату';
        showToast(errorTranslations[message] || message, 'error');
      } finally {
        setLockingRoom(false);
      }
    },
    [roomId, loadRooms, showToast]
  );

  const handleLockRoom = useCallback(() => {
    if (!roomId || lockingRoom) return;

    // Privileged users bypass the password, so for them the button locks the
    // room for everyone instead of just themselves.
    if (isPrivilegedUser) {
      setConfirmModal({
        isOpen: true,
        title: 'Заблокировать комнату для всех?',
        message:
          'Все пользователи потеряют доступ к комнате и должны будут снова ввести пароль.',
        confirmText: 'Заблокировать',
        cancelText: 'Отмена',
        variant: 'danger',
        onConfirm: () => {
          setConfirmModal((prev) => ({ ...prev, isOpen: false }));
          void lockRoom(true);
        },
      });
      return;
    }

    void lockRoom(false);
  }, [roomId, lockingRoom, isPrivilegedUser, lockRoom, setConfirmModal]);

  // Expose the lock button in the mobile/tablet header rendered by Layout.
  useEffect(() => {
    if (!canLockRoom) {
      setLockAction(null);
      return;
    }
    setLockAction({
      title: isPrivilegedUser
        ? 'Заблокировать комнату для всех'
        : 'Заблокировать комнату',
      busy: lockingRoom,
      onLock: handleLockRoom,
    });
    return () => setLockAction(null);
  }, [canLockRoom, isPrivilegedUser, lockingRoom, handleLockRoom, setLockAction]);

  const markRoomAsRead = useCallback(async () => {
    if (!roomId || activeRoomLocked || !activeRoomId || messages.length === 0) return;
    const lastMessageId = messages[messages.length - 1]?.id;
    if (!lastMessageId) return;

    const prevMarked = lastReadMessageIdRef.current[roomId];
    if (prevMarked && lastMessageId <= prevMarked) {
      return;
    }

    try {
      const result = await messagesApi.markRead(roomId, lastMessageId);
      const effectiveLastId = result.lastReadMessageId ?? lastMessageId;
      lastReadMessageIdRef.current[roomId] = effectiveLastId;

      setMessages(prev =>
        prev.map((m) =>
          m.id <= effectiveLastId ? { ...m, is_read: 1 } : m
        )
      );

      setFirstUnreadMessageId((prev) =>
        prev && prev <= effectiveLastId ? null : prev
      );

      setRoomList(prev =>
        prev.map((r) =>
          r.id === roomId ? { ...r, unread_count: 0 } : r
        )
      );
    } catch (error) {
      console.error('Failed to mark messages as read:', error);
    }
  }, [roomId, messages, activeRoomLocked, activeRoomId]);

  // Keep a stable reference for scroll handlers without re-binding listeners
  useEffect(() => {
    markRoomAsReadRef.current = markRoomAsRead;
  }, [markRoomAsRead]);

  // When messages change, if user is near the bottom, mark them as read
  useEffect(() => {
    if (!roomId || messages.length === 0) return;
    const messagesContainer = document.querySelector('.chat-messages-wrap');
    if (!messagesContainer) return;
    const { scrollTop, scrollHeight, clientHeight } = messagesContainer as HTMLElement;
    const distanceToBottom = scrollHeight - scrollTop - clientHeight;
    if (distanceToBottom < 40) {
      void markRoomAsRead();
    }
  }, [roomId, messages, markRoomAsRead]);

  // Handle WebSocket messages related to global state (rooms, users, etc.)
  useEffect(() => {
    logger.debug('Global WebSocket handler mounted for Chat component');

    const handleGlobalWsMessage = (data: any) => {
      logger.debug('Received global WebSocket message:', data);
      
      switch(data.type) {
        case 'error':
          // The socket refused a join because the room is locked or access was
          // revoked; refetch the list so the UI shows the right panel.
          if (data.code === 'ROOM_LOCKED' || data.code === 'ROOM_FORBIDDEN') {
            void loadRooms();
          }
          break;

        case 'room_deleted':
          // Handle room deletion notification
          if (data.roomId === roomId) {
            // Navigate away from the deleted room without reloading the page
            navigate('/chat', { replace: true });
          }
          // Удаляем комнату из локального списка
          setRoomList(prev => prev.filter(r => r.id !== data.roomId));
          break;

        case 'room_created':
          if (data.room) {
            setRoomList(prev => {
              if (prev.some(r => r.id === data.room.id)) return prev;
              return [...prev, data.room];
            });
          }
          break;

        case 'room_updated':
          if (data.room) {
            setRoomList(prev =>
              prev.map(r => (r.id === data.room.id ? { ...r, ...data.room } : r))
            );
          }
          break;

        case 'rooms_changed':
          // Access levels, passwords and whitelists changed. Refetch because
          // the list and lock state are per-user.
          void loadRooms();
          break;
          
        case 'room_message':
          if (data.roomId && data.userId && user) {
            const msgRoomId = Number(data.roomId);
            const senderId = Number(data.userId);
            // Ignore own messages for unread counters
            if (senderId === user.id) {
              break;
            }

            setRoomList(prev =>
              prev.map(r => {
                if (r.id !== msgRoomId) return r;

                const isActiveRoom = roomId === msgRoomId;
                const shouldCountUnread = !(isActiveRoom && shouldAutoScrollRef.current);

                if (!shouldCountUnread) {
                  return r;
                }

                const current = r.unread_count ?? 0;
                return { ...r, unread_count: current + 1 };
              })
            );

            // For messages in other rooms (or when tab is hidden), play sounds and show notification
            const roomName =
              roomList.find((r) => r.id === msgRoomId)?.name ?? 'Чат';
            const preview: string = data.preview || '';
            const bodyForDetection = preview;
            const login = user.login;
            const hasDirectMention =
              bodyForDetection &&
              new RegExp(`(^|\\s)@${login}(\\b|\\s|$)`).test(bodyForDetection);
            const hasAllMention =
              bodyForDetection &&
              /(^|\s)@(all|here)(\b|\s|$)/i.test(bodyForDetection);
            const isReplyToUser =
              data.replyToUserId != null && Number(data.replyToUserId) === user.id;
            const isMentionForUser = !!(hasDirectMention || hasAllMention || isReplyToUser);

            if (isMentionForUser) {
              // Add the room to mentioned rooms to trigger flash animation
              if (msgRoomId !== roomId) { // Only add to mentioned rooms if it's not the current room
                setMentionedRooms(prev => {
                  const newSet = new Set(prev);
                  newSet.add(msgRoomId);
                  return newSet;
                });
              }
              
              playMention();
            } else {
              playIncoming();
            }

            const isTabVisible = document.visibilityState === 'visible';
            // Если сообщение в другой комнате или вкладка скрыта — показываем нотификацию
            if (!isTabVisible || msgRoomId !== roomId) {
              const notifPreview =
                preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
              void showMessageNotification({
                roomName,
                preview: notifPreview,
                isMention: isMentionForUser,
              });
            }
          }
          break;
          
        case 'presence':
          if (typeof data.userId === 'number') {
            setOnlineUserIds((prev) => {
              const next = new Set(prev);
              if (data.online) {
                next.add(data.userId);
              } else {
                next.delete(data.userId);
              }
              return next;
            });
          }
          break;

        case 'presence_snapshot':
          if (Array.isArray(data.users)) {
            setOnlineUserIds(new Set(data.users.map((u: { userId: number }) => u.userId)));
          }
          break;
          
        case 'user_deleted_admin':
          if (typeof data.userId === 'number') {
            setAllUsers(prev => prev.filter(u => u.id !== data.userId));
            setOnlineUserIds(prev => {
              const next = new Set(prev);
              next.delete(data.userId);
              return next;
            });
            setTypingUsers(prev => prev.filter(u => u.userId !== data.userId));
            // Messages are cascade-deleted on the server.
            setMessages(prev => prev.filter(m => m.user_id !== data.userId));
            void loadRooms();
          }
          break;

        case 'user_role_changed':
        case 'user_updated':
        case 'user_verification_changed':
          if (data.user) {
            // Обновляем информацию о пользователе в списке allUsers
            setAllUsers(prev => {
              // Проверяем, существует ли пользователь в списке
              const userExists = prev.some(u => u.id === data.user.id);
              
              if (userExists) {
                // Обновляем существующего пользователя
                return prev.map(u => 
                  u.id === data.user.id ? { ...u, ...data.user } : u
                );
              } else {
                // Добавляем нового пользователя
                return [...prev, data.user];
              }
            });
            
            // Обновляем логин пользователя в списке печатающих
            setTypingUsers(prev => 
              prev.map(typingUser => 
                typingUser.userId === data.user.id 
                  ? { ...typingUser, login: data.user.login } 
                  : typingUser
              )
            );
          }
          break;
          
        case 'server_settings_updated':
          if (data.settings) {
            // Обновляем имя сервера, если оно доступно
            // Но это обрабатывается в ServerNameContext, так что можно пропустить
          }
          break;

        case 'media_settings_updated':
        case 'media_usage_changed':
        case 'media_removed':
          // Лимиты, квота или список файлов изменились — обновляем индикаторы
          scheduleMediaSettingsRefresh();
          break;
          
        default:
          // Не обрабатываем специфичные для комнаты события в глобальном обработчике
          break;
      }
    };

    // Add message handler when component mounts
    addMessageHandler(handleGlobalWsMessage);

    // Ensure WebSocket is initialized
    initializeWebSocket();

    // Cleanup function
    return () => {
      logger.debug('Global WebSocket handler unmounting');
      // Remove message handler when component unmounts
      removeMessageHandler(handleGlobalWsMessage);
    };
  }, [roomId, user, navigate, scheduleMediaSettingsRefresh, loadRooms]); // Re-run when room or user changes so unread logic sees fresh state

  // Handle WebSocket messages related to chat and room-specific events
  useEffect(() => {
    logger.debug(`Chat component mounted for room ${roomId || 'none'}`);

    const handleRoomSpecificWsMessage = (data: any) => {
      logger.debug('Received room-specific WebSocket message:', data);
      
      switch(data.type) {
        case 'message':
          if (data.message?.room_id === roomId) {
            logger.debug('Processing new message:', data.message);
            setMessages(prev => {
              // Check if message already exists
              if (prev.some(m => m.id === data.message.id)) {
                logger.debug('Message already exists, skipping');
                return prev;
              }
              logger.debug('Adding new message to state');
              const isReadNow = shouldAutoScrollRef.current ? 1 : 0;
              const newMessage: Message = { ...data.message, is_read: isReadNow };
              if (!isReadNow && firstUnreadMessageId == null) {
                setFirstUnreadMessageId(newMessage.id);
              }
              return [...prev, newMessage];
            });

            // Check for mentions and add flash animation if needed
            if (user && data.message?.user_id !== user.id) {
              const body: string = data.message.body || '';
              const login = user.login;
              const hasDirectMention =
                new RegExp(`(^|\\s)@${login}(\\b|\\s|$)`).test(body);
              const hasAllMention = /(^|\s)@(all|here)(\b|\s|$)/i.test(body);
              const isReplyToUser = data.message?.replyTo?.userId === user.id;
              const isMentionForUser = hasDirectMention || hasAllMention || isReplyToUser;

              if (isMentionForUser) {
                // Add the message to mentioned messages to trigger flash animation
                setMentionedMessages(prev => {
                  const newSet = new Set(prev);
                  newSet.add(data.message.id);
                  
                  // Remove the message from mentioned set after animation completes
                  setTimeout(() => {
                    setMentionedMessages(current => {
                      const updated = new Set(current);
                      updated.delete(data.message.id);
                      return updated;
                    });
                  }, 1500);
                  
                  return newSet;
                });

                // If the user is scrolled up, the mention is out of sight:
                // collect it for the floating "jump to mention" button.
                if (!shouldAutoScrollRef.current) {
                  setUnseenMentions(prev => {
                    if (prev.has(data.message.id)) return prev;
                    const next = new Set(prev);
                    next.add(data.message.id);
                    return next;
                  });
                }
              }
            }

            // Play sound and possibly show notification for messages in the current room
            if (user && data.message?.user_id !== user.id) {
              const body: string = data.message.body || '';
              const login = user.login;
              const hasDirectMention =
                new RegExp(`(^|\\s)@${login}(\\b|\\s|$)`).test(body);
              const hasAllMention = /(^|\s)@(all|here)(\b|\s|$)/i.test(body);
              const isReplyToUser = data.message?.replyTo?.userId === user.id;
              const isMentionForUser = hasDirectMention || hasAllMention || isReplyToUser;

              if (isMentionForUser) {
                playMention();
              } else {
                playIncoming();
              }

              const isTabVisible = document.visibilityState === 'visible';
              if (!isTabVisible) {
                const roomName =
                  roomList.find((r) => r.id === roomId)?.name ?? 'Чат';
                const preview =
                  body.length > 120 ? `${body.slice(0, 117)}...` : body;
                void showMessageNotification({
                  roomName,
                  preview,
                  isMention: isMentionForUser,
                });
              }
            }
          }
          break;
          
        case 'message_updated':
          // Update the message in the list if it exists
          logger.debug('Processing message update:', data.message);
          // Only update if this is not from the current user (to avoid duplicate updates)
          setMessages(prev => 
            prev.map(msg => {
              if (msg.id === data.message.id) return data.message;
              if (msg.replyTo?.id === data.message.id) {
                return {
                  ...msg,
                  replyTo: {
                    ...msg.replyTo,
                    body: data.message.body,
                    login: data.message.login,
                    userId: data.message.user_id,
                  },
                };
              }
              return msg;
            })
          );
          break;
          
        case 'message_deleted':
          // Remove the message from the list
          logger.debug('Processing message deletion:', data.messageId);
          setMessages(prev => 
            prev
              .filter(msg => msg.id !== data.messageId)
              .map(msg => {
                if (!msg.replyTo || msg.replyTo.id !== data.messageId) return msg;
                return { ...msg, replyTo: { ...msg.replyTo, id: null, deleted: true } };
              })
          );
          setReplyingTo(prev => (prev?.id === data.messageId ? null : prev));
          setEditingMessage(prev => prev?.id === data.messageId ? null : prev);
          
          // After deleting a message, update the scroll button visibility
          setTimeout(updateScrollButtonVisibility, 0);
          break;
          
        case 'messages_deleted':
          // Remove multiple messages from the list
          if (Array.isArray(data.messageIds)) {
            logger.debug('Processing multiple message deletion:', data.messageIds);
            setMessages(prev => 
              prev
                .filter(msg => !data.messageIds.includes(msg.id))
                .map(msg => {
                  if (
                    !msg.replyTo ||
                    msg.replyTo.id == null ||
                    !data.messageIds.includes(msg.replyTo.id)
                  ) {
                    return msg;
                  }
                  return { ...msg, replyTo: { ...msg.replyTo, id: null, deleted: true } };
                })
            );
            setReplyingTo(prev => (prev && data.messageIds.includes(prev.id) ? null : prev));
            setEditingMessage(prev => prev && data.messageIds.includes(prev.id) ? null : prev);
            
            // After deleting messages, update the scroll button visibility
            setTimeout(updateScrollButtonVisibility, 0);
          }
          break;
          
        case 'typing':
          // Сообщение о наборе приходит уже только в нужную комнату,
          // поэтому roomId в payload не обязатен
          if (data.userId != null && user && data.userId !== user.id) { // Исключаем себя из отображения
            const userId = Number(data.userId);
            const login = data.login || String(data.userId);

            setTypingUsers((prev) => {
              const exists = prev.some((u) => u.userId === userId);
              if (exists) {
                return prev.map((u) =>
                  u.userId === userId ? { ...u, login } : u
                );
              }
              return [...prev, { userId, login }];
            });

            const timeouts = typingTimeoutsRef.current;
            const existingTimeout = timeouts.get(userId);
            if (existingTimeout) clearTimeout(existingTimeout);

            const timeoutId = setTimeout(() => {
              setTypingUsers((prev) => prev.filter((u) => u.userId !== userId));
              timeouts.delete(userId);
            }, 800); // Изменено с 3000 на 800 мс для уменьшения задержки

            timeouts.set(userId, timeoutId);
          }
          break;
          
        case 'room_messages_cleared':
          if (data.roomId === roomId) {
            setMessages([]);
          }
          break;
          
        case 'pong': // Response to heartbeat ping - handled internally
          // Connection is alive, do nothing
          break;
          
        // room events are now handled in the global handler
        case 'room_deleted':
        case 'room_created':
        case 'room_updated':
          // These are handled by the global handler
          break;
          
        default:
          // Handle any other message types
          break;
      }
    };

    // Add message handler when component mounts
    addMessageHandler(handleRoomSpecificWsMessage);

    // Function to join room with retry logic
    const joinRoomWithRetry = (attempts = 0) => {
      const ws = getWebSocket();
      logger.debug(`Attempting to join room ${roomId}. WebSocket readyState: ${ws?.readyState}, connecting: ${ws?.readyState === WebSocket.CONNECTING}`);
      
      if (!ws) {
        logger.debug('WebSocket not available, attempting to initialize');
        // Initialize WebSocket if not available
        initializeWebSocket();
        // Retry after a short delay
        setTimeout(() => joinRoomWithRetry(attempts + 1), 100);
        return;
      }

      if (ws.readyState === WebSocket.OPEN && roomId) {
        ws.send(JSON.stringify({ type: 'join', roomId }));
        logger.debug(`Sent join message for room ${roomId}`);
      } else if (ws.readyState === WebSocket.CONNECTING) {
        // Wait for connection to open before joining
        const onOpenHandler = () => {
          logger.debug(`WebSocket opened, joining room ${roomId}`);
          if (roomId) {
            ws.send(JSON.stringify({ type: 'join', roomId }));
            logger.debug(`Sent join message for room ${roomId}`);
          }
          // Clean up this temporary handler
          ws.removeEventListener('open', onOpenHandler);
        };
        ws.addEventListener('open', onOpenHandler);
      } else {
        // If WebSocket is closed or closing, try to reinitialize
        if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
          logger.debug('WebSocket is closed, reinitializing...');
          initializeWebSocket();
        }
        
        // Retry after a delay if we haven't exceeded max attempts
        if (attempts < 5) {
          setTimeout(() => joinRoomWithRetry(attempts + 1), 500);
        } else {
          logger.debug('Max attempts reached trying to join room');
        }
      }
    };

    // Try to join room immediately
    if (roomId && canJoinRoom) {
      joinRoomWithRetry();
    }

    // Global open handler to (re)join room on every WebSocket (re)connection
    const handleOpen = () => {
      logger.debug('Global WebSocket open handler triggered in Chat');
      const wasConnected = hasConnectedRef.current;
      hasConnectedRef.current = true;
      if (!roomId) return;
      if (wasConnected) {
        // Access may have changed while offline, so always refresh the list.
        void loadRooms();
        void loadUsers();
      }
      if (!canJoinRoom) return;
      const ws = getWebSocket();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'join', roomId }));
        logger.debug(`Sent join message for room ${roomId} from global open handler`);
      }
      if (wasConnected) {
        // Catch up on anything missed while the socket was down.
        void loadMessages(roomId);
      }
    };
    addOpenHandler(handleOpen);

    // Cleanup function
    return () => {
      logger.debug('Chat component unmounting');
      // Remove message handler when component unmounts
      removeMessageHandler(handleRoomSpecificWsMessage);
      // Remove open handler
      removeOpenHandler(handleOpen);
      // Leave the room so the server stops sending room broadcasts
      if (roomId) leaveRoom(roomId);
      // Clear typing timeouts
      const timeouts = typingTimeoutsRef.current;
      timeouts.forEach((timeoutId) => clearTimeout(timeoutId));
      timeouts.clear();
    };
  }, [roomId, user, canJoinRoom, loadMessages, loadRooms, loadUsers]); // Re-run when room or user changes so "typing" handler sees fresh user


  function handleTyping() {
    const ws = getWebSocket();
    if (ws?.readyState === WebSocket.OPEN && roomId) {
      // Проверяем, что пользователь действительно присоединен к комнате
      // Если нет, пробуем присоединиться снова
      if (!(ws as any).currentRoomId || (ws as any).currentRoomId !== roomId) {
        ws.send(JSON.stringify({ type: 'join', roomId }));
        // Update the currentRoomId on the WebSocket instance
        (ws as any).currentRoomId = roomId;
      }
      ws.send(JSON.stringify({ type: 'typing', roomId }));
    }
  }

  // Handle scroll events to show/hide scroll-to-bottom button
  useEffect(() => {
    const messagesContainer = document.querySelector('.chat-messages-wrap');
    
    if (!messagesContainer) {
      // If no container exists (no room selected), hide the button
      setShowScrollButton(false);
      return;
    }

    const handleScroll = () => {
      // Check if user is near the bottom of the chat
      const { scrollTop, scrollHeight, clientHeight } = messagesContainer as HTMLElement;
      const distanceToBottom = scrollHeight - scrollTop - clientHeight;
      
      // Update auto-scroll ref to determine if we should auto-scroll
      shouldAutoScrollRef.current = distanceToBottom < 100; // Consider "near bottom" if within 100px
      
      // Show button only when:
      // 1. Distance to bottom is greater than 100px (user scrolled up significantly)
      // 2. Container is actually scrollable (content is taller than container)
      setShowScrollButton(distanceToBottom > 100 && scrollHeight > clientHeight);

      // Reaching the bottom means the user has read everything, even if they
      // scrolled there manually instead of pressing the button.
      if (distanceToBottom < 40) {
        // All mentions are behind the viewport now; the jump button is done.
        setUnseenMentions(prev => (prev.size === 0 ? prev : new Set()));
        void markRoomAsReadRef.current();
      }

      // Store the current scroll position for the room
      if (roomId) {
        scrollPositions.current[roomId] = scrollTop;
      }
    };

    messagesContainer.addEventListener('scroll', handleScroll);
    
    // Restore scroll position if we have one for this room
    // Delay slightly to ensure DOM has rendered
    setTimeout(() => {
      if (roomId && scrollPositions.current[roomId] !== undefined) {
        messagesContainer.scrollTop = scrollPositions.current[roomId];
        
        // Update the auto scroll ref and button visibility based on restored position
        const { scrollTop, scrollHeight, clientHeight } = messagesContainer as HTMLElement;
        const distanceToBottom = scrollHeight - scrollTop - clientHeight;
        shouldAutoScrollRef.current = distanceToBottom < 100;
        setShowScrollButton(distanceToBottom > 100 && scrollHeight > clientHeight);
      } else {
        // If no saved position, ensure we're at the bottom and update accordingly
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        const { scrollTop, scrollHeight, clientHeight } = messagesContainer as HTMLElement;
        const distanceToBottom = scrollHeight - scrollTop - clientHeight;
        shouldAutoScrollRef.current = distanceToBottom < 100;
        setShowScrollButton(distanceToBottom > 100 && scrollHeight > clientHeight);
      }
    }, 0);
    
    return () => {
      messagesContainer.removeEventListener('scroll', handleScroll);
    };
  }, [roomId]); // Add roomId as a dependency so the effect re-runs when room changes

  // Function to adjust the position of the scroll-to-bottom button based on panel visibility
  const adjustScrollButtonPosition = useCallback(() => {
    requestAnimationFrame(() => {
      const scrollButton = document.querySelector('.scroll-to-bottom-btn') as HTMLElement;
      if (!scrollButton) return;

      // Start with the base position
      let bottomPosition = 80; // Base position for desktop
      
      // Check if we're on mobile and adjust base position accordingly
      if (window.innerWidth <= 678) {
        bottomPosition = 100; // Mobile base position
      }

      // Check if editing-panel is visible - if so, only consider its total height
      // (since selected-files-preview is nested inside it)
      const editingPanel = document.querySelector('.editing-panel') as HTMLElement;
      if (editingPanel && editingPanel.children.length > 0) {
        bottomPosition += editingPanel.offsetHeight;
      } 
      // If not in editing mode, check for selected-files-preview separately
      else {
        const selectedFilesPreview = document.querySelector('.selected-files-preview') as HTMLElement;
        if (selectedFilesPreview && selectedFilesPreview.children.length > 0) {
          bottomPosition += selectedFilesPreview.offsetHeight;
        }
      }

      const replyComposePreview = document.querySelector('.reply-compose-preview') as HTMLElement;
      if (replyComposePreview) {
        bottomPosition += replyComposePreview.offsetHeight;
      }

      // Apply the calculated position
      scrollButton.style.bottom = `${bottomPosition}px`;
    });
  }, []);

  // Effect to update scroll button position when panels appear/disappear
  useEffect(() => {
    // Run the adjustment when components render
    adjustScrollButtonPosition();
    
    // Check if ResizeObserver is available in the browser
    if (!window.ResizeObserver) return;

    const resizeObserver = new ResizeObserver(() => {
      adjustScrollButtonPosition();
    });

    const selectedFilesPreview = document.querySelector('.selected-files-preview');
    const editingPanel = document.querySelector('.editing-panel');
    const replyComposePreview = document.querySelector('.reply-compose-preview');
    
    if (selectedFilesPreview) resizeObserver.observe(selectedFilesPreview);
    if (editingPanel) resizeObserver.observe(editingPanel);
    if (replyComposePreview) resizeObserver.observe(replyComposePreview);

    // Clean up observer on unmount
    return () => {
      resizeObserver.disconnect();
    };
  }, [adjustScrollButtonPosition, selectedFiles.length, editingMessage, replyingTo]);

  // Scroll to bottom function
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    // Reset auto-scroll behavior when user manually scrolls to bottom
    shouldAutoScrollRef.current = true;
    setShowScrollButton(false);
    // All mentions are behind the viewport now; the jump button is done.
    setUnseenMentions(new Set());
    setTimeout(() => {
      void markRoomAsReadRef.current();
    }, 200);
  };

  // Jump to the first unseen mention in the current room. Used by the floating
  // button that appears when a mention arrived while the user was scrolled up.
  const jumpToNextMention = () => {
    if (!roomId || unseenMentions.size === 0) return;

    const firstId = [...unseenMentions].sort((a, b) => a - b)[0];
    if (firstId === undefined) return;
    const messageEl = document.querySelector(
      `[data-message-id="${firstId}"]`
    ) as HTMLElement | null;

    if (messageEl) {
      messageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      messageEl.classList.add('mention-jump-target');
      setTimeout(() => messageEl.classList.remove('mention-jump-target'), 1500);
    }

    setUnseenMentions(prev => {
      const next = new Set(prev);
      next.delete(firstId);
      return next;
    });

    // Auto-scroll resumes once we reach the bottom again; mark room as read
    // after a short delay so the scroll lands first.
    setTimeout(() => {
      void markRoomAsReadRef.current();
    }, 300);
  };

  // Follow new incoming messages when the user is already at the bottom.
  useEffect(() => {
    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
    const prev = prevMessagesRef.current;
    prevMessagesRef.current = {
      roomId,
      lastId: lastMessage?.id ?? null,
      count: messages.length,
    };

    if (skipAutoScrollRef.current) {
      skipAutoScrollRef.current = false;
      return;
    }

    // Only react to messages being appended in the same room. Replacing the
    // whole list (room switch, reconnect) must keep the restored position.
    const isAppended =
      prev.roomId === roomId &&
      messages.length > prev.count &&
      lastMessage != null &&
      lastMessage.id !== prev.lastId;

    if (!isAppended || !roomId || loading || !shouldAutoScrollRef.current) {
      return;
    }

    const messagesContainer = document.querySelector('.chat-messages-wrap') as HTMLElement | null;
    if (!messagesContainer) return;

    // Jump straight to the newest message; smooth scrolling lags behind and
    // leaves the feed above the bottom while new messages keep arriving.
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    setShowScrollButton(false);
    void markRoomAsReadRef.current();
  }, [messages, roomId, loading]);

  useEffect(() => {
    void loadMediaSettings();
    return () => {
      if (mediaRefreshTimeoutRef.current) clearTimeout(mediaRefreshTimeoutRef.current);
    };
  }, [loadMediaSettings]);

  const isUploadEnabled = mediaSettings ? mediaSettings.uploadsEnabled : true;
  const handleMediaUploadInfoClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setUploadInfoModalOpen(true);
  }, []);

  const applyMediaSettingsFilter = useCallback(
    (files: File[]) => {
      if (!mediaSettings) return { accepted: files, rejected: [] as File[] };
      if (!mediaSettings.uploadsEnabled) return { accepted: [] as File[], rejected: files };
      if (isStorageFull) return { accepted: [] as File[], rejected: files };
      if (mediaSettings.unlimited || !mediaSettings.maxFileSize) {
        return { accepted: files, rejected: [] as File[] };
      }
      const accepted = files.filter((file) => file.size <= mediaSettings.maxFileSize!);
      const rejected = files.filter((file) => file.size > mediaSettings.maxFileSize!);
      return { accepted, rejected };
    },
    [mediaSettings, isStorageFull]
  );

  // Scroll to typing indicator when someone is typing, but only if user was at the bottom
  useEffect(() => {
    if (typingUsers.length > 0 && typingIndicatorRef.current && shouldAutoScrollRef.current) {
      typingIndicatorRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [typingUsers]);

  // Function to handle file selection
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const files = Array.from(e.target.files);
      const { accepted, rejected } = applyMediaSettingsFilter(files);
      if (accepted.length > 0) {
        setSelectedFiles((prev) => [...prev, ...accepted]);
      }
      if (rejected.length > 0) {
        if (isStorageFull) {
          setUploadWarning('Хранилище заполнено. Удалите старые файлы или попросите владельца увеличить лимит.');
        } else if (mediaSettings && !mediaSettings.uploadsEnabled) {
          setUploadWarning('Загрузка файлов отключена настройками сервера.');
        } else {
          setUploadWarning(
            `Пропущено файлов: ${rejected.length}. Превышен лимит ${formatBytes(
              mediaSettings?.maxFileSize || 0
            )}.`
          );
        }
      } else {
        setUploadWarning(null);
      }
      e.target.value = '';
    }
  };

  // Function to convert a folder to a ZIP file
  const folderToZip = async (folderEntry: any): Promise<File> => {
    const zip = new JSZip();
    
    // Recursive function to add entries to zip
    const addEntryToZip = async (entry: any, path: string = ''): Promise<void> => {
      if (entry.isFile) {
        const fileEntry = entry as FileSystemFileEntry;
        return new Promise<void>((innerResolve, innerReject) => {
          fileEntry.file(
            (file) => {
              const fullPath = path + file.name;
              zip.file(fullPath, file);
              innerResolve();
            },
            (error) => {
              console.error('Error reading file:', error);
              innerReject(error);
            }
          );
        });
      } else if (entry.isDirectory) {
        const dirEntry = entry as FileSystemDirectoryEntry;
        const reader = dirEntry.createReader();
        
        const entries = await new Promise<FileSystemEntry[]>((resolve, reject) => {
          reader.readEntries((items) => {
            resolve(items);
          }, reject);
        });
        
        const promises = entries.map(subEntry => 
          addEntryToZip(subEntry, path + entry.name + '/')
        );
        await Promise.all(promises);
      }
    };

    await addEntryToZip(folderEntry);
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const zipFile = new File([zipBlob], `${folderEntry.name}.zip`, { type: 'application/zip' });
    return zipFile;
  };

  // Drag and drop handlers
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Получаем элемент, над которым находится курсор после ухода с текущего элемента
    const relatedTarget = e.relatedTarget as HTMLElement | null;
    const chatWrapElement = e.currentTarget as HTMLElement;
    
    // Проверяем, находится ли курсор над элементом, который является потомком области чата
    // или сам является областью чата - если нет, значит мы действительно покидаем область
    if (!chatWrapElement.contains(relatedTarget)) {
      setIsDragOver(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy'; // Show copy cursor effect
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      const files: File[] = [];
      const items = Array.from(e.dataTransfer.items);
      
      for (const item of items) {
        if (item.kind === 'file') {
          // Use type assertion to access webkitGetAsEntry
          const dataTransferItem = item as any;
          const entry = dataTransferItem.webkitGetAsEntry ? dataTransferItem.webkitGetAsEntry() : null;
          
          if (entry) {
            if (entry.isDirectory) {
              // It's a folder, convert it to a zip file
              try {
                const zipFile = await folderToZip(entry);
                files.push(zipFile);
              } catch (error) {
                console.error('Error converting folder to zip:', error);
              }
            } else {
              // Regular file
              files.push(item.getAsFile() as File);
            }
          } else {
            // Fallback to regular file if webkitGetAsEntry is not available
            files.push(item.getAsFile() as File);
          }
        }
      }
      
      if (files.length > 0) {
        const { accepted, rejected } = applyMediaSettingsFilter(files);
        if (accepted.length > 0) {
          setSelectedFiles((prev) => [...prev, ...accepted]);
        }
        if (rejected.length > 0) {
          if (isStorageFull) {
            setUploadWarning('Хранилище заполнено. Удалите старые файлы или попросите владельца увеличить лимит.');
          } else if (mediaSettings && !mediaSettings.uploadsEnabled) {
            setUploadWarning('Загрузка файлов отключена настройками сервера.');
          } else {
            setUploadWarning(
              `Пропущено файлов: ${rejected.length}. Превышен лимит ${formatBytes(
                mediaSettings?.maxFileSize || 0
              )}.`
            );
          }
        } else {
          setUploadWarning(null);
        }
      }
    } else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      // Fallback to regular file handling
      const droppedFiles = Array.from(e.dataTransfer.files);
      const { accepted, rejected } = applyMediaSettingsFilter(droppedFiles);
      if (accepted.length > 0) {
        setSelectedFiles((prev) => [...prev, ...accepted]);
      }
      if (rejected.length > 0) {
        if (mediaSettings && !mediaSettings.uploadsEnabled) {
          setUploadWarning('Загрузка файлов отключена настройками сервера.');
        } else {
          setUploadWarning(
            `Пропущено файлов: ${rejected.length}. Превышен лимит ${formatBytes(
              mediaSettings?.maxFileSize || 0
            )}.`
          );
        }
      } else {
        setUploadWarning(null);
      }
    }
  };

  // Global handlers to reset drag state when drag leaves the entire window
  useEffect(() => {
    const handleGlobalDragEnd = () => {
      setIsDragOver(false);
    };

    // Listen for global drag events to reset the state when dragging stops anywhere
    document.addEventListener('dragend', handleGlobalDragEnd);
    document.addEventListener('drop', handleGlobalDragEnd);

    // Cleanup listeners
    return () => {
      document.removeEventListener('dragend', handleGlobalDragEnd);
      document.removeEventListener('drop', handleGlobalDragEnd);
    };
  }, []);

  // Function to remove a selected file
  const removeSelectedFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  // Function to upload a single file
  const uploadFile = async (file: File, index: number): Promise<any> => {
    try {
      const result = await media.upload(file, (progress) => {
        setUploadProgress(prev => ({
          ...prev,
          [index]: progress
        }));
      });
      return result;
    } catch (error) {
      console.error('Error uploading file:', error);
      throw error;
    }
  };

  // Function to upload all selected files
  const uploadSelectedFiles = async (): Promise<number[]> => {
    if (selectedFiles.length === 0) return [];

    // Initialize progress for all files in a single state update
    setUploadProgress(
      selectedFiles.reduce((acc, _, index) => {
        acc[index] = 0;
        return acc;
      }, {} as Record<number, number>)
    );

    try {
      const uploadPromises = selectedFiles.map((file, index) => uploadFile(file, index));
      const results = await Promise.all(uploadPromises);
      setSelectedFiles([]); // Clear selected files after successful upload
      setUploadProgress({}); // Clear progress
      return results.map((result) => result.id);
    } catch (error) {
      setUploadProgress({});
      setUploadWarning(getUploadErrorMessage(error, mediaSettings?.maxFileSize));
      throw error;
    }
  };

  // Modified handleSend to support both text and media
  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    
    if (!roomId || (!sendText.trim() && selectedFiles.length === 0)) return;
    
    // Ignore a submit that lands within the double-submit window.
    const now = Date.now();
    if (now - lastMessageTimeRef.current < rateLimitDelay) {
      return;
    }
    
    lastMessageTimeRef.current = now;
    
    const text = sendText.trim();
    const hasFiles = selectedFiles.length > 0;
    
    // Prevent sending empty messages when there are no files
    if (!text && !hasFiles) return;
    
    try {
      // Temporarily clear text so UI feels responsive
      setSendText('');
      setUploadWarning(null);
      // Upload files if any
      const mediaIds = hasFiles ? await uploadSelectedFiles() : [];
      
      // Send message with or without media and chosen media position
      const newMessage = await messagesApi.send(
        roomId,
        text,
        mediaIds,
        mediaPositionDraft,
        replyingTo?.id ?? null
      );
      
      // Optimistically add the new message so the author sees it immediately
      setMessages((prev) => {
        if (prev.some((m) => m.id === newMessage.id)) {
          return prev;
        }
        const msgWithRead: Message = { ...newMessage, is_read: 1 };
        return [...prev, msgWithRead];
      });
      
      setReplyingTo(null);
      playSent();
      
      // Ensure we scroll to the bottom after adding the new message
      setTimeout(() => {
        scrollToBottom();
      }, 0);
    } catch (err) {
      setSendText(text);
      const uploadErr = err as Error & { code?: string };
      if (uploadErr?.code === 'MEDIA_FILE_TOO_LARGE' || uploadErr?.code === 'MEDIA_UPLOAD_DISABLED') {
        return;
      }
      if (isRoomAccessError(err)) {
        // Access expired while the room was open — show the unlock panel.
        void loadRooms();
      }
      showToast(err instanceof Error ? err.message : 'Не удалось отправить', 'error');
    }
  }

  // Auto-resize textarea based on content
  const adjustTextareaHeight = useCallback(() => {
    if (textareaRef.current) {
      // Store the current style to restore later
      const currentStyle = {
        height: textareaRef.current.style.height,
        overflowY: textareaRef.current.style.overflowY,
        borderBottom: textareaRef.current.style.borderBottom
      };
      
      try {
        // Temporarily make the textarea invisible but measurable
        textareaRef.current.style.borderBottom = 'none';
        textareaRef.current.style.height = 'auto';
        
        // Calculate the height based on content, but limit to 10 lines
        const lineHeight = 24; // Approximate line height in pixels
        const maxHeight = lineHeight * 10; // 10 lines max
        
        // Calculate scroll height and apply the limit
        const scrollHeight = Math.min(textareaRef.current.scrollHeight, maxHeight);
        
        // Apply the calculated height
        textareaRef.current.style.height = `${scrollHeight}px`;
        
        // Show scrollbar when content exceeds max height
        textareaRef.current.style.overflowY = scrollHeight >= maxHeight ? 'auto' : 'hidden';
        
        // Restore the border after resizing
        textareaRef.current.style.borderBottom = '';
      } catch (error) {
        // If there's an error, restore the original styles
        textareaRef.current.style.height = currentStyle.height;
        textareaRef.current.style.overflowY = currentStyle.overflowY;
        textareaRef.current.style.borderBottom = currentStyle.borderBottom;
      }
    }
  }, []);

  // Effect to adjust textarea height when sendText changes
  useEffect(() => {
    // Use a timeout to ensure the DOM has updated
    const timeoutId = setTimeout(adjustTextareaHeight, 0);
    return () => clearTimeout(timeoutId);
  }, [sendText, adjustTextareaHeight]);

  // Effect to adjust textarea height when switching between editing and non-editing modes
  useEffect(() => {
    const timeoutId = setTimeout(adjustTextareaHeight, 0);
    return () => clearTimeout(timeoutId);
  }, [editingMessage, adjustTextareaHeight]);

  // Check if user can edit a message (only own messages)
  const canEditMessage = (message: Message) => {
    if (!user) return false;
    return message.user_id === user.id;
  };

  // Check if user can delete a message (own + owner/moderator)
  const canDeleteMessage = (message: Message) => {
    if (!user) return false;
    // Owner or moderator can delete any message
    if (user.role === 'owner' || user.role === 'moderator') return true;
    // Author can delete their own message
    return message.user_id === user.id;
  };

  // Toggle message selection - now respecting user permissions
  const toggleMessageSelection = (id: number) => {
    // Find the message by ID to check permissions
    const message = messages.find(msg => msg.id === id);
    
    // Allow selection only if user can delete the message
    if (message && canDeleteMessage(message)) {
      setSelectedMessages(prev => {
        if (prev.includes(id)) {
          return prev.filter(msgId => msgId !== id);
        } else {
          return [...prev, id];
        }
      });
    }
  };

  // Clear all selections
  const clearSelections = () => {
    setSelectedMessages([]);
  };

  // Determine if we're currently in selection mode
  const isSelecting = selectedMessages.length > 0;

  // Show context menu on right-click or long press
  const showContextMenu = (x: number, y: number, message: Message) => {
    if (isSelecting) return; // Don't show context menu during selection
    
    // Calculate position to prevent menu from going off-screen
    let adjustedX = x;
    let adjustedY = y;
    
    // We'll use the max dimensions defined in CSS
    const maxWidth = 300; // max-width from CSS
    const maxHeight = 300; // max-height from CSS
    
    // Adjust X coordinate to stay within screen bounds
    if (adjustedX + maxWidth > window.innerWidth) {
      adjustedX = window.innerWidth - maxWidth - 5; // 5px padding from edge
    }
    
    // Adjust Y coordinate to stay within screen bounds
    if (adjustedY + maxHeight > window.innerHeight) {
      adjustedY = window.innerHeight - maxHeight - 5; // 5px padding from edge
    }
    
    // Ensure the menu doesn't go off the left/top edges
    adjustedX = Math.max(adjustedX, 5);
    adjustedY = Math.max(adjustedY, 5);
    
    setContextMenu({
      visible: true,
      x: adjustedX,
      y: adjustedY,
      message
    });
  };

  // Handle long press for mobile devices
  const handleTouchStart = (e: React.TouchEvent, message: Message) => {
    // Clear any existing timeout
    if (longPressTimeout.current) {
      clearTimeout(longPressTimeout.current);
    }
    
    // Set a new timeout for long press (500ms is standard)
    longPressTimeout.current = setTimeout(() => {
      const touch = e.touches[0];
      if (touch) {
        // Get the coordinates relative to the viewport
        showContextMenu(touch.clientX, touch.clientY, message);
      }
    }, 500);
  };

  // Handle double click for desktop and mobile
  const handleDoubleClick = (e: React.MouseEvent, message: Message) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, message);
  };

  // Handle single click with debounce for double click detection
  const handleSingleClick = (message: Message) => {
    // If we're in selection mode, just toggle the message selection
    if (isSelecting) {
      toggleMessageSelection(message.id);
      return;
    }

    // If there's already a timer (meaning this is the second click), clear it
    if (doubleClickTimer.current) {
      clearTimeout(doubleClickTimer.current);
      doubleClickTimer.current = null;
      return;
    }

    // Otherwise, set a timer to handle the single click
    doubleClickTimer.current = setTimeout(() => {
      // For single click outside of selection mode, we don't do anything
      // (previously this would toggle selection, but now we have double click for context menu)
      doubleClickTimer.current = null;
    }, 300); // 300ms is the typical double click delay
  };

  // Clear timeout when touch ends
  const handleTouchEnd = () => {
    if (longPressTimeout.current) {
      clearTimeout(longPressTimeout.current);
      longPressTimeout.current = null;
    }
  };

  // Hide context menu
  const hideContextMenu = () => {
    setContextMenu({ visible: false, x: 0, y: 0, message: null });
  };

  // Select all messages that the user has permission to delete
  const selectAllMessages = () => {
    // Filter messages to only include those the user can edit/delete
    const selectableMessageIds = messages
      .filter(message => canDeleteMessage(message))
      .map(m => m.id);
    
    // Select all selectable message IDs that aren't already selected
    const unselectedIds = selectableMessageIds.filter(id => !selectedMessages.includes(id));
    
    setSelectedMessages(prev => [...prev, ...unselectedIds]);
  };

  // Delete selected messages - now delete one by one instead of batch
  const deleteSelectedMessages = async () => {
    if (selectedMessages.length === 0) return;

    setConfirmModal({
      isOpen: true,
      title: 'Удалить сообщения?',
      message: `Вы уверены, что хотите удалить ${selectedMessages.length} сообщений?`,
      confirmText: 'Удалить',
      cancelText: 'Отмена',
      variant: 'danger',
      onConfirm: async () => {
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));
        try {
          const deletePromises = selectedMessages.map(msgId =>
            messagesApi.delete(msgId, roomId!)
          );

          await Promise.all(deletePromises);
          setMessages((prev) => prev.filter((msg) => !selectedMessages.includes(msg.id)));
          clearSelections();
          setTimeout(updateScrollButtonVisibility, 0);
        } catch (error) {
          console.error('Error deleting messages:', error);
          showToast('Ошибка при удалении сообщений', 'error');
        }
      }
    });
  };

  // Create a function that only clears selected messages but doesn't exit selection mode
  const clearSelectedMessagesOnly = () => {
    // Since we now only select messages the user has permission to interact with,
    // we can simply clear all selections
    setSelectedMessages([]);
  };

  // Handle editing message
  const startEditingMessage = (message: Message | null) => {
    if (!message) return;
    setReplyingTo(null);
    setEditingMessage({ 
      id: message.id, 
      body: message.body, 
      originalBody: message.body,
      media: message.media || [],
      mediaPosition: message.mediaPosition || 'below'  // Store the original media position
    });
    // Set the original media when editing starts
    setOriginalMediaOnEditStart([...(message.media || [])]);
    setContextMenu({ visible: false, x: 0, y: 0, message: null });
    
    // Set the media position draft to the message's current position, or default to 'below'
    setMediaPositionDraft(message.mediaPosition || 'below');
    
    // Clear any previously selected files for new uploads during editing
    setSelectedFiles([]);
  };
  // Save edited message
  const saveEditedMessage = async () => {
    if (!editingMessage || !roomId) return;
    
    // Check if there's content to save (text or media files)
    const hasText = editingMessage.body.trim() !== '';
    const hasOriginalMedia = editingMessage.media && editingMessage.media.length > 0;
    const hasNewFiles = selectedFiles.length > 0;
    
    // If there's no content at all, warn the user
    if (!hasText && !hasOriginalMedia && !hasNewFiles) {
      showToast('Сообщение должно содержать текст или медиафайлы', 'error');
      return;
    }
    
    // Check if anything actually changed compared to when editing started
    const hasTextChanged = editingMessage.body.trim() !== editingMessage.originalBody.trim();
    
    // Check if media changed by comparing the original media (when editing started) 
    // with the current state (remaining original media + new files)
    const originalMediaIds = (originalMediaOnEditStart || []).map(m => m.id);
    const currentMediaIds = (editingMessage.media || []).map(m => m.id);
    const hasMediaChanged = JSON.stringify(originalMediaIds.sort()) !== JSON.stringify(currentMediaIds.sort()) || 
                           selectedFiles.length > 0;
                           
    // Check if media position changed compared to the original message
    const hasMediaPositionChanged = mediaPositionDraft !== editingMessage.mediaPosition;

    // If nothing has changed, skip saving
    if (!hasTextChanged && !hasMediaChanged && !hasMediaPositionChanged) {
      setEditingMessage(null);
      setSelectedFiles([]);
      return;
    }
    
    try {
      // Upload any new files that were selected during editing
      const mediaIds = selectedFiles.length > 0 ? await uploadSelectedFiles() : [];
      
      // Combine existing media IDs with new ones
      const allMediaIds = [
        ...(editingMessage.media || []).map(m => m.id),
        ...mediaIds
      ];

      const updated = await messagesApi.edit(editingMessage.id, roomId, editingMessage.body, allMediaIds, mediaPositionDraft);
      
      // Optimistically update the message locally
      setMessages((prev) =>
        prev.map((msg) => (msg.id === updated.id ? updated : msg))
      );
      
      setEditingMessage(null);
      // Reset the original media tracking
      setOriginalMediaOnEditStart(null);
      setSelectedFiles([]);
    } catch (error) {
      console.error('Error editing message:', error);
      showToast('Ошибка при редактировании сообщения', 'error');
    }
  };

  // Using the custom hook for message input behavior
  const { handleKeyDown } = useMessageInputBehavior({
    sendText,
    setSendText,
    handleSend,
    saveEditedMessage,
    isEditing: !!editingMessage,
    editingText: editingMessage?.body,
    setEditingText: editingMessage ? (text) => setEditingMessage({ ...editingMessage, body: text }) : undefined,
  });

  // Update the height of the editing textarea when the editing message changes
  useEffect(() => {
    if (editingMessage && editMessageTextareaRef.current) {
      // Trigger height adjustment after setting the value
      setTimeout(() => {
        if (editMessageTextareaRef.current) {
          editMessageTextareaRef.current.style.height = 'auto';
          
          const lineHeight = 24;
          const maxHeight = lineHeight * 10; // 10 lines max like the main input
          
          const scrollHeight = Math.min(editMessageTextareaRef.current.scrollHeight, maxHeight);
          editMessageTextareaRef.current.style.height = `${scrollHeight}px`;
          
          editMessageTextareaRef.current.style.overflowY = editMessageTextareaRef.current.scrollHeight > maxHeight ? 'auto' : 'hidden';
        }
      }, 0);
    }
  }, [editingMessage]);

  // Handle cancelling message editing
  const cancelEditing = () => {
    setEditingMessage(null);
    setSelectedFiles([]);
    setOriginalMediaOnEditStart(null); // Reset the original media tracking
    
    // Return focus to the main input field and adjust its height
    if (textareaRef.current) {
      textareaRef.current.focus();
      // Trigger height adjustment after returning to the main input
      setTimeout(() => {
        adjustTextareaHeight();
      }, 0);
    }
  };

  const startReplyingTo = (message: Message) => {
    if (editingMessage) {
      cancelEditing();
    }
    setReplyingTo(message);
    hideContextMenu();
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const scrollToMessage = (messageId: number) => {
    const element = document.querySelector(
      `[data-message-id="${messageId}"]`
    ) as HTMLElement | null;

    if (!element) {
      showToast('Исходное сообщение не загружено', 'error');
      return;
    }

    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.classList.add('chat-message-highlight');
    setTimeout(() => {
      element.classList.remove('chat-message-highlight');
    }, 1600);
  };

  // Handle deleting a single message
  const deleteSingleMessage = async (messageId: number) => {
    setConfirmModal({
      isOpen: true,
      title: 'Удалить сообщение?',
      message: 'Вы уверены, что хотите удалить это сообщение?',
      confirmText: 'Удалить',
      cancelText: 'Отмена',
      variant: 'danger',
      onConfirm: async () => {
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));
        try {
          await messagesApi.delete(messageId, roomId!);
          setMessages((prev) => prev.filter((msg) => msg.id !== messageId));
          setContextMenu({ visible: false, x: 0, y: 0, message: null });
          setTimeout(updateScrollButtonVisibility, 0);
        } catch (error) {
          console.error('Error deleting message:', error);
          showToast('Ошибка при удалении сообщения', 'error');
        }
      }
    });
  };
  
  // Function to download all media files from a message as a ZIP archive
  const downloadAllMediaFromMessage = async (message: Message) => {
    if (!message.media || message.media.length === 0) {
      return;
    }
    
    try {
      const zip = new JSZip();
      const promises: Promise<void>[] = [];
      
      message.media.forEach(mediaFile => {
        const promise = fetch(`/api/media/${mediaFile.encrypted_filename}`)
          .then(response => response.blob())
          .then(blob => {
            // Add the file to the ZIP archive with the original filename
            zip.file(mediaFile.original_name, blob);
          })
          .catch(error => {
            console.error(`Ошибка при загрузке файла ${mediaFile.original_name}:`, error);
          });
        
        promises.push(promise);
      });
      
      // Wait for all files to be downloaded and added to the ZIP
      await Promise.all(promises);

      // Generate the ZIP file and trigger the download
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const fileName = `media_${message.id}_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.zip`;
      saveAs(zipBlob, fileName);

      hideContextMenu();
    } catch (error) {
      console.error('Ошибка при создании ZIP-архива:', error);
      showToast('Ошибка при создании ZIP-архива', 'error');
    }
  };

  // Clear selections when room changes
  useEffect(() => {
    clearSelections();
  }, [roomId]);

  if (roomList.length === 0 && !loading) {
    return (
      <div className="chat-empty-muted">
        Нет комнат. Создайте комнату в разделе «Админка».
      </div>
    );
  }

  return (
    <div className={`chat-page${roomId ? ' has-room' : ''}`}>
      <div className="chat-rooms">
        <div className="chat-rooms-header">
          <span className="chat-rooms-title">
            <span className="chat-rooms-title-inner">
              <span className="icon-inline" aria-hidden>
                <IconHome />
              </span>
              Комнаты
            </span>
          </span>
          <button
            type="button"
            className="chat-rooms-users-button secondary"
            onClick={toggleUserList}
            aria-label="Пользователи в комнате"
          >
            <span className="icon-inline" aria-hidden>
              <IconUsers />
            </span>
          </button>
        </div>
        <div className="chat-rooms-list">
          {roomList.map((r) => (
            <Link
              key={r.id}
              to={`/chat/${r.id}`}
              className={`chat-room-link${roomId === r.id ? ' active' : ''} ${mentionedRooms.has(r.id) && roomId !== r.id ? 'room-mention-flash' : ''}`}
              onClick={() => {
                // Clear mentions for this room when entering it
                setMentionedRooms(prev => {
                  const newSet = new Set(prev);
                  newSet.delete(r.id); // Remove the current room from mentioned set
                  return newSet;
                });
                
                // Reload rooms when changing rooms to ensure latest state
                loadRooms();
              }}
            >
              <span className="chat-room-link-name">
                <Marquee>
                  {r.name}
                </Marquee>
              </span>
              <div className="chat-room-indicators">
                {r.locked && (
                  <span
                    className="chat-room-lock"
                    title={
                      r.password_required
                        ? 'Комната защищена паролем'
                        : r.member_only
                          ? 'Доступ только по приглашению'
                          : 'Комната заблокирована'
                    }
                  >
                    <span className="icon-inline" aria-hidden>
                      <IconLock />
                    </span>
                  </span>
                )}
                {mentionedRooms.has(r.id) && roomId !== r.id && (
                  <span className="chat-room-mention-indicator-noflash">@</span>
                )}
                {r.unread_count != null && r.unread_count > 0 && (
                  <span className="chat-room-unread-badge">
                    {r.unread_count > 99 ? '99+' : r.unread_count}
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
        {isTabletInRange && (
          <TabletBottomNav showAdmin={user?.role === 'owner' || user?.role === 'moderator'} />
        )}
      </div>
      <div className="chat-main">
        <div className="chat-main-content">
          {roomId ? (
            !roomsLoaded ? (
              <div className="chat-center-muted">Загрузка…</div>
            ) : activeRoomMissing ? (
              <div className="chat-locked-panel">
                <div className="chat-locked-icon" aria-hidden>
                  <IconLock />
                </div>
                <h2 className="chat-locked-title">Комната недоступна</h2>
                <p className="chat-locked-text">
                  Комната не найдена или у вас нет доступа к ней.
                </p>
                <Link to="/chat" className="chat-locked-back secondary">
                  К списку комнат
                </Link>
              </div>
            ) : activeRoomLocked ? (
              <div className="chat-locked-panel">
                <div className="chat-locked-icon" aria-hidden>
                  <IconLock />
                </div>
                <h2 className="chat-locked-title">{activeRoom?.name}</h2>
                {activeRoom?.password_required ? (
                  <>
                    <p className="chat-locked-text">
                      Комната защищена паролем. Введите его, чтобы войти.
                    </p>
                    <form className="chat-unlock-form" onSubmit={handleUnlockRoom}>
                      <div className="chat-unlock-row">
                        <input
                          type="password"
                          value={unlockPassword}
                          onChange={(e) => setUnlockPassword(e.target.value)}
                          placeholder="Пароль комнаты"
                          autoComplete="current-password"
                          autoFocus
                        />
                        <button type="submit" disabled={unlocking || !unlockPassword}>
                          {unlocking ? 'Проверка…' : 'Войти'}
                        </button>
                      </div>
                      <label className="chat-unlock-remember">
                        <span>Запоминать пароль:</span>
                        <select
                          value={
                            unlockRememberMinutes === null
                              ? UNLOCK_REMEMBER_NEVER
                              : String(unlockRememberMinutes)
                          }
                          onChange={(e) =>
                            handleUnlockRememberChange(
                              e.target.value === UNLOCK_REMEMBER_NEVER
                                ? null
                                : Number(e.target.value)
                            )
                          }
                        >
                          {UNLOCK_REMEMBER_OPTIONS.map((option) => (
                            <option
                              key={option.label}
                              value={
                                option.value === null
                                  ? UNLOCK_REMEMBER_NEVER
                                  : String(option.value)
                              }
                            >
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </form>
                  </>
                ) : (
                  <p className="chat-locked-text">
                    Доступ к этой комнате есть только у приглашённых пользователей.
                  </p>
                )}
                <Link to="/chat" className="chat-locked-back secondary">
                  К списку комнат
                </Link>
              </div>
            ) : (
            <>
              <div className="chat-header-desktop">
                <Marquee>
                  {roomList.find((r) => r.id === roomId)?.name ?? 'Чат'}
                </Marquee>
                {canLockRoom && (
                  <button
                    type="button"
                    className="chat-header-lock"
                    onClick={handleLockRoom}
                    disabled={lockingRoom}
                    title={
                      isPrivilegedUser
                        ? 'Заблокировать комнату для всех'
                        : 'Заблокировать комнату'
                    }
                    aria-label={
                      isPrivilegedUser
                        ? 'Заблокировать комнату для всех'
                        : 'Заблокировать комнату'
                    }
                  >
                    <span className="icon-inline" aria-hidden>
                      <IconLock />
                    </span>
                  </button>
                )}
              </div>
              <div 
                className={`chat-messages-wrap ${isDragOver ? 'drag-over' : ''}`}
                onDragEnter={handleDragEnter}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                {loading ? (
                  <div className="chat-loading-muted">Загрузка…</div>
                ) : (
                  messages.map((m, idx) => {
                    // Check if the current message is from the same user as the previous one
                    // and sent within a minute (60,000 ms)
                    const prevMessage = messages[idx - 1];
                    const shouldHideAuthor = idx > 0 && 
                      prevMessage && 
                      prevMessage.user_id === m.user_id &&
                      prevMessage.created_at && 
                      m.created_at &&
                      (new Date(m.created_at).getTime() - new Date(prevMessage.created_at).getTime()) < 60000;
                    
                    const isSelected = selectedMessages.includes(m.id);
                    const isEditable = editingMessage && editingMessage.id === m.id;
                    const showNewMessagesDivider =
                      firstUnreadMessageId != null && m.id === firstUnreadMessageId;
                    
                    return (
                      <div key={m.id} className="chat-message-wrapper">
                        {showNewMessagesDivider && (
                          <div className="new-messages-divider">
                            Новые сообщения
                          </div>
                        )}
                        <div
                        data-message-id={m.id}
                        className={`chat-message ${shouldHideAuthor ? 'grouped-message' : 'has-author'} ${isSelected ? 'selected' : ''} ${(canEditMessage(m) || canDeleteMessage(m)) ? 'editable' : ''} ${mentionedMessages.has(m.id) ? 'mention-flash' : ''}`}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          showContextMenu(e.clientX, e.clientY, m);
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSingleClick(m);
                        }}
                        onDoubleClick={(e) => handleDoubleClick(e, m)}
                        // Добавляем touch-события для поддержки долгого нажатия на мобильных устройствах
                        onTouchStart={(e) => handleTouchStart(e, m)}
                        onTouchEnd={handleTouchEnd}
                        onTouchMove={handleTouchEnd}
                        onMouseDown={handleTouchEnd} // Также очищаем таймер при клике мышью
                      >
                        {/* During editing, still show the original message content with an indicator */}
                        <>
                          {!shouldHideAuthor && (
                            <div className="chat-message-header">
                              <div className="chat-message-author-wrapper">
                                <span className={`user-status-indicator ${onlineUserIds.has(m.user_id) ? 'online' : 'offline'}`} 
                                      title={onlineUserIds.has(m.user_id) ? 'Онлайн' : 'Оффлайн'}>
                                  •
                                </span>
                                <Marquee className="chat-message-author" animationDuration={8}>
                                  {allUsers.find(u => u.id === m.user_id)?.login || m.login}
                                </Marquee>
                                {user && m.user_id === user.id && (
                                  <span className="chat-message-you-label" title="Это ваше сообщение">
                                    Вы
                                  </span>
                                )}
                              </div>
                              <span className="chat-message-time">
                                {new Date(m.created_at).toLocaleString()}
                                {m.updated_at && m.updated_at !== m.created_at && (
                                  <span title="Редактировалось"> ✎</span>
                                )}
                                {/* Display role label if user is moderator or owner and it's not the current user */}
                                {user && allUsers.length > 0 && (() => {
                                  const userRole = getUserRoleById(m.user_id, allUsers);
                                  const isCurrentUser = user.id === m.user_id;
                                  
                                  if ((userRole === 'moderator' || userRole === 'owner') && !isCurrentUser) {
                                    return (
                                      <span className="user-role-label user-role-label-extra">
                                        {userRole === 'moderator' ? 'Модератор' : 'Владелец'}
                                      </span>
                                    );
                                  }
                                  return null;
                                })()}
                                
                                {isEditable && (
                                  <span className="editing-indicator" title="Сообщение редактируется">
                                    &nbsp;(редактируется)
                                  </span>
                                )}
                              </span>
                            </div>
                          )}
                          {shouldHideAuthor && (
                            <div className="chat-message-time-alone">
                              {new Date(m.created_at).toLocaleString()}
                              {m.updated_at && m.updated_at !== m.created_at && (
                                <span title="Редактировалось"> ✎</span>
                              )}
                              
                              {isEditable && (
                                <span className="editing-indicator" title="Сообщение редактируется">
                                  &nbsp;(редактируется)
                                </span>
                              )}
                            </div>
                          )}
                          {m.replyTo && (
                            <button
                              type="button"
                              className={`chat-reply-quote${m.replyTo.deleted ? ' chat-reply-quote--deleted' : ''}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (m.replyTo?.id) {
                                  scrollToMessage(m.replyTo.id);
                                }
                              }}
                              disabled={!m.replyTo.id}
                              title={m.replyTo.deleted ? 'Исходное сообщение удалено' : 'Перейти к сообщению'}
                            >
                              <span className="chat-reply-quote-author">
                                {m.replyTo.deleted ? 'Сообщение удалено' : m.replyTo.login}
                              </span>
                              <span className="chat-reply-quote-text">
                                {formatReplyPreview(m.replyTo.body)}
                              </span>
                            </button>
                          )}
                          <div className="chat-message-body">
                            <MarkdownMessage
                              content={m.body}
                              media={m.media}
                              mediaPosition={m.mediaPosition ?? 'below'}
                            />
                          </div>
                          
                          {isSelected && (
                            <div className="message-selected-indicator">✓</div>
                          )}
                          {/* Add selection indicator for messages that can be selected */}
                          {isSelecting && !canDeleteMessage(m) && (
                            <div className="message-not-selectable-indicator">○</div>
                          )}
                        </>
                      </div>
                      </div>
                    );
                  })
                )}
                {formatTypingUsers(typingUsers) && (
                  <div ref={typingIndicatorRef} className="chat-typing-indicator">
                    <Marquee animationDuration={8}>{formatTypingUsers(typingUsers)}</Marquee> печатает…
                  </div>
                )}
                <div ref={messagesEndRef} />
                {/* Floating scroll to bottom button */}
                {showScrollButton && (
                  <button 
                    className="scroll-to-bottom-btn"
                    onClick={scrollToBottom}
                    aria-label="Прокрутить к последнему сообщению"
                  >
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                      <path d="M12 5v14M19 12l-7 7-7-7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                )}
                {unseenMentions.size > 0 && (
                  <button
                    className="jump-to-mention-btn"
                    onClick={jumpToNextMention}
                    aria-label={`Перейти к ${unseenMentions.size} непрочитанным упоминаниям`}
                    title={`Вас упомянули: ${unseenMentions.size}`}
                  >
                    <span className="mention-badge">{unseenMentions.size}</span>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      <circle cx="9" cy="7" r="4" strokeWidth="2" />
                      <path d="M23 21v-2a4 4 0 0 0-3-3.87" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M16 3.13A4 4 0 0 1 12.5 3C13 3 13 3 13 3" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                )}
              </div>
              
              {/* Context Menu */}
              {contextMenu.visible && contextMenu.message && (
                <div ref={contextMenuRef} className="context-menu">
                  {/* Кнопка копирования сообщения */}
                  <button 
                    className="context-menu-item"
                    onClick={() => {
                      if (contextMenu.message) {
                        // Проверяем, что мы в безопасном контексте перед доступом к Clipboard API
                        if (navigator.clipboard && window.isSecureContext) {
                          navigator.clipboard.writeText(contextMenu.message.body);
                        } else {
                          // Резервный вариант для небезопасных контекстов
                          const textArea = document.createElement('textarea');
                          textArea.value = contextMenu.message.body;
                          document.body.appendChild(textArea);
                          textArea.focus();
                          textArea.select();
                          try {
                            document.execCommand('copy');
                          } catch (err) {
                            console.error('Failed to copy text: ', err);
                          }
                          document.body.removeChild(textArea);
                        }
                      }
                      hideContextMenu();
                    }}
                  >
                    Копировать
                  </button>

                  <button
                    className="context-menu-item"
                    onClick={() => {
                      if (contextMenu.message) {
                        startReplyingTo(contextMenu.message);
                      } else {
                        hideContextMenu();
                      }
                    }}
                  >
                    Ответить
                  </button>
                  
                  {/* Кнопка загрузки всех медиафайлов, если они есть в сообщении */}
                  {contextMenu.message && contextMenu.message.media && contextMenu.message.media.length > 0 && (
                    <button 
                      className="context-menu-item"
                      onClick={() => {
                        if (contextMenu.message) {
                          downloadAllMediaFromMessage(contextMenu.message);
                        }
                      }}
                    >
                      Сохранить всё
                    </button>
                  )}
                  
                  {/* Редактировать можно только свои сообщения */}
                  {canEditMessage(contextMenu.message) && (
                    <button 
                      className="context-menu-item"
                      onClick={() => startEditingMessage(contextMenu.message)}
                    >
                      Редактировать
                    </button>
                  )}
                  
                  {/* Выделять могут только те, кто может удалять сообщения */}
                  {canDeleteMessage(contextMenu.message) && (
                    <button 
                      className="context-menu-item"
                      onClick={() => {
                        if (contextMenu.message) {
                          toggleMessageSelection(contextMenu.message.id);
                        }
                        hideContextMenu();
                      }}
                    >
                      {contextMenu.message && selectedMessages.includes(contextMenu.message.id) ? 'Снять выбор' : 'Выбрать'}
                    </button>
                  )}
                  
                  {/* Удалять могут владелец/модератор или автор */}
                  {canDeleteMessage(contextMenu.message) && (
                    <button 
                      className="context-menu-item danger-text-only"
                      onClick={() => {
                        if (contextMenu.message) {
                          deleteSingleMessage(contextMenu.message.id);
                        }
                        hideContextMenu();
                      }}
                    >
                      Удалить
                    </button>
                  )}
                </div>
              )}
              
              {/* Mobile Selection Controls */}
              {isSelecting && (
                <div className="mobile-selection-controls">
                  <div className="mobile-selection-actions">
                    <button onClick={selectAllMessages}>Выбрать все</button>
                    <button onClick={clearSelectedMessagesOnly}>Снять выбор</button>
                    <button className="danger" onClick={deleteSelectedMessages}>
                      Удалить ({selectedMessages.length})
                    </button>
                  </div>
                </div>
              )}
              
              {/* Editing panel - shown when editing a message */}
              {editingMessage && (
                <div className="editing-panel">
                  <div className="editing-panel-header">
                    <span>Редактирование: {editingMessage.originalBody.substring(0, 10)}{editingMessage.originalBody.length > 10 ? '...' : ''}</span>
                    <button onClick={cancelEditing}>Отмена</button>
                  </div>
                  
                  {/* Selected files preview for editing - showing both original and new files */}
                  {(selectedFiles.length > 0 || (editingMessage.media && editingMessage.media.length > 0)) && (
                    <div className="selected-files-preview">
                      {/* Media position toggle */}
                      <div className="media-position-toggle">
                        <button
                          type="button"
                          className={`media-position-button ${mediaPositionDraft === 'above' ? 'active' : ''}`}
                          onClick={() => setMediaPositionDraft('above')}
                          title="Показывать медиа над текстом сообщения"
                        >
                          Медиа сверху
                        </button>
                        <button
                          type="button"
                          className={`media-position-button ${mediaPositionDraft === 'below' ? 'active' : ''}`}
                          onClick={() => setMediaPositionDraft('below')}
                          title="Показывать медиа под текстом сообщения"
                        >
                          Медиа снизу
                        </button>
                      </div>
                      
                      <div className="selected-files-header">
                        <h4>Файлы сообщения:</h4>
                        <div className="clear-buttons-container">
                        {isUploadEnabled && !isStorageFull && (
                          <label htmlFor="edit-file-upload" className="edit-add-file">
                            <Marquee>Добавить файл</Marquee>
                          </label>
                        )}
                        {editingMessage.media && editingMessage.media.length > 0 && (
                          <button 
                            type="button" 
                            className="clear-all-files"
                            onClick={() => {
                              // Remove all original media by setting editingMessage.media to an empty array
                              setEditingMessage({...editingMessage, media: []});
                            }}
                          >
                            <Marquee>Очистить оригинальные</Marquee>
                          </button>
                        )}
                        {selectedFiles.length > 0 && (
                          <button 
                            type="button" 
                            className="clear-all-files"
                            onClick={() => setSelectedFiles([])}
                          >
                            <Marquee>Очистить новые</Marquee>
                          </button>
                        )}
                        </div>
                      </div>
                      
                      <div className="selected-files-grid">
                        {/* Render original media files */}
                        {editingMessage.media && editingMessage.media.length > 0 && editingMessage.media.map((mediaFile) => {
                          // Determine file type and show appropriate preview
                          let previewElement;
                          if (mediaFile.mime_type.startsWith('image/')) {
                            // For images, show a thumbnail
                            previewElement = (
                              <div className="file-preview">
                                <img 
                                  src={`/api/media/${mediaFile.encrypted_filename}`} 
                                  alt={mediaFile.original_name} 
                                />
                              </div>
                            );
                          } else if (mediaFile.mime_type.startsWith('video/')) {
                            // For videos, show a placeholder with a play icon
                            previewElement = (
                              <div className="file-preview video-preview">
                                <div className="video-placeholder">
                                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <polygon points="23 7 16 12 23 17 23 7"></polygon>
                                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
                                  </svg>
                                </div>
                              </div>
                            );
                          } else if (mediaFile.mime_type.startsWith('audio/')) {
                            // For audio, show a music note icon
                            previewElement = (
                              <div className="file-preview audio-preview">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M9 18V5l12-2v13"></path>
                                  <circle cx="6" cy="18" r="3"></circle>
                                  <circle cx="18" cy="16" r="3"></circle>
                                </svg>
                              </div>
                            );
                          } else {
                            // For other files, show the first 3 letters of the extension
                            const ext = mediaFile.original_name.split('.').pop()?.substring(0, 3) || 'FILE';
                            previewElement = (
                              <div className="file-preview other">
                                {ext.toUpperCase()}
                              </div>
                            );
                          }
                          
                          // Format file size for display
                          const formattedSize = mediaFile.file_size > 1024 * 1024 
                            ? `${(mediaFile.file_size / (1024 * 1024)).toFixed(1)} MB` 
                            : `${(mediaFile.file_size / 1024).toFixed(1)} KB`;
                          
                          return (
                            <div 
                              key={`original-${mediaFile.id}`} 
                              className="selected-file-item"
                            >
                              {previewElement}
                              <div 
                                className="file-name" 
                                title={`${mediaFile.original_name} (${formattedSize})`}
                              >
                                {mediaFile.original_name.length > 15 ? `${mediaFile.original_name.substring(0, 15)}...` : mediaFile.original_name}
                              </div>
                              <div className="file-size">
                                {formattedSize}
                              </div>
                              <button 
                                type="button" 
                                className="remove-file-btn"
                                onClick={() => {
                                  // Remove this specific original media file
                                  const updatedMedia = editingMessage.media?.filter(m => m.id !== mediaFile.id) || [];
                                  setEditingMessage({...editingMessage, media: updatedMedia});
                                }}
                              >
                                ×
                              </button>
                            </div>
                          );
                        })}
                        
                        {/* Render newly selected files */}
                        {selectedFiles.map((file, index) => {
                          const previewElement = <LocalFilePreview file={file} />;
                          
                          // Format file size for display
                          const formattedSize = file.size > 1024 * 1024 
                            ? `${(file.size / (1024 * 1024)).toFixed(1)} MB` 
                            : `${(file.size / 1024).toFixed(1)} KB`;
                          
                          return (
                            <div 
                              key={`new-${index}`} 
                              className="selected-file-item"
                            >
                              {previewElement}
                              <div 
                                className="file-name" 
                                title={`${file.name} (${formattedSize})`}
                              >
                                {file.name.length > 15 ? `${file.name.substring(0, 15)}...` : file.name}
                              </div>
                              <div className="file-size">
                                {formattedSize}
                              </div>
                              {uploadProgress[index] !== undefined && (
                                <div className="upload-progress">
                                  <div
                                    className="progress-bar-fill"
                                    ref={(el) => {
                                      if (el) el.style.setProperty('--progress', String(uploadProgress[index] ?? 0));
                                    }}
                                  />
                                </div>
                              )}
                              
                              <button 
                                type="button" 
                                className="remove-file-btn"
                                onClick={() => removeSelectedFile(index)}
                              >
                                ×
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
              
                            {/* Selected files preview - moved above the form, but only when not editing */}
                            {!editingMessage && selectedFiles.length > 0 && (
                <div className="selected-files-preview">
                  {/* Media position toggle */}
                  <div className="media-position-toggle">
                    <button
                      type="button"
                      className={`media-position-button ${mediaPositionDraft === 'above' ? 'active' : ''}`}
                      onClick={() => setMediaPositionDraft('above')}
                      title="Показывать медиа над текстом сообщения"
                    >
                      Медиа сверху
                    </button>
                    <button
                      type="button"
                      className={`media-position-button ${mediaPositionDraft === 'below' ? 'active' : ''}`}
                      onClick={() => setMediaPositionDraft('below')}
                      title="Показывать медиа под текстом сообщения"
                    >
                      Медиа снизу
                    </button>
                  </div>
                  
                  <div className="selected-files-header">
                    <h4>Выбранные файлы:</h4>
                    <button 
                      type="button" 
                      className="clear-all-files"
                      onClick={() => setSelectedFiles([])}
                    >
                      Очистить все
                    </button>
                  </div>
                  <div className="selected-files-grid">
                    {selectedFiles.map((file, index) => {
                      const previewElement = <LocalFilePreview file={file} />;
                      
                      // Format file size for display
                      const formattedSize = file.size > 1024 * 1024 
                        ? `${(file.size / (1024 * 1024)).toFixed(1)} MB` 
                        : `${(file.size / 1024).toFixed(1)} KB`;
                      
                      return (
                        <div 
                          key={index} 
                          className="selected-file-item"
                        >
                          {previewElement}
                          <div 
                            className="file-name" 
                            title={`${file.name} (${formattedSize})`}
                          >
                            {file.name.length > 15 ? `${file.name.substring(0, 15)}...` : file.name}
                          </div>
                          <div className="file-size">
                            {formattedSize}
                          </div>
                          {uploadProgress[index] !== undefined && (
                            <div className="upload-progress">
                              <div
                                className="progress-bar-fill"
                                ref={(el) => {
                                  if (el) el.style.setProperty('--progress', String(uploadProgress[index] ?? 0));
                                }}
                              />
                            </div>
                          )}
                          <button 
                            type="button" 
                            className="remove-file-btn"
                            onClick={() => removeSelectedFile(index)}
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              
              {replyingTo && !editingMessage && (
                <div className="reply-compose-preview">
                  <div className="reply-compose-info">
                    <span className="reply-compose-label">
                      Ответ на сообщение <strong>{replyingTo.login}</strong>
                    </span>
                    <span className="reply-compose-text">
                      {formatReplyPreview(replyingTo.body)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="reply-compose-cancel"
                    onClick={() => setReplyingTo(null)}
                    aria-label="Отменить ответ"
                  >
                    ×
                  </button>
                </div>
              )}

              {renderUploadWarning()}
              
              <form onSubmit={(e) => {
                e.preventDefault();
                if (editingMessage) {
                  saveEditedMessage();
                } else {
                  handleSend(e);
                }
              }} className={`chat-form${isSelecting ? ' chat-form-hidden' : ' chat-form-flex'}`}>
                {/* Attachment button */}
                <div className="attachment-button-wrapper">
                  {isUploadEnabled && !isStorageFull && (
                    <>
                      <label
                        htmlFor="file-upload"
                        className="attach-button"
                        title={getStorageLimitLabel()}
                      >
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l9.19-9.19" />
                        </svg>
                      </label>
                      <input
                        id="file-upload"
                        type="file"
                        multiple
                        onChange={handleFileSelect}
                        className="visually-hidden-input"
                      />
                    </>
                  )}
                  {isUploadEnabled && isStorageFull && (
                    <span className="attach-button attach-button-disabled" title="Хранилище заполнено">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l9.19-9.19" />
                      </svg>
                    </span>
                  )}
                </div>
                <span
                  className={`media-upload-info ${!isUploadEnabled || isStorageFull ? 'media-upload-info-disabled' : ''}`}
                  title={getStorageLimitLabel()}
                  onClick={handleMediaUploadInfoClick}
                  role="button"
                  aria-label="Показать информацию о лимитах медиа"
                >
                  ?
                </span>
                
                {/* File input for editing message */}
                <input
                  id="edit-file-upload"
                  type="file"
                  multiple
                  disabled={!isUploadEnabled || isStorageFull}
                  onChange={(e) => {
                    if (e.target.files && e.target.files.length > 0) {
                      const files = Array.from(e.target.files);
                      const { accepted, rejected } = applyMediaSettingsFilter(files);
                      
                      // Upload each file and add to the editing message
                      accepted.forEach(file => {
                        media.upload(file).then((result: any) => {
                          const newMediaFile: MediaFile = {
                            id: result.id,
                            original_name: result.original_name,
                            encrypted_filename: result.encrypted_filename,
                            mime_type: result.mime_type,
                            file_size: result.file_size
                          };
                          
                          setEditingMessage(prev => {
                            if (!prev) return prev;
                            return {
                              ...prev,
                              media: [...(prev.media || []), newMediaFile]
                            };
                          });
                        }).catch(error => {
                          console.error('Error uploading file for editing:', error);
                          setUploadWarning(getUploadErrorMessage(error, mediaSettings?.maxFileSize));
                        });
                      });
                      if (rejected.length > 0) {
                        if (isStorageFull) {
                          setUploadWarning('Хранилище заполнено. Удалите старые файлы или попросите владельца увеличить лимит.');
                        } else if (mediaSettings && !mediaSettings.uploadsEnabled) {
                          setUploadWarning('Загрузка файлов отключена настройками сервера.');
                        } else {
                          setUploadWarning(
                            `Пропущено файлов: ${rejected.length}. Превышен лимит ${formatBytes(
                              mediaSettings?.maxFileSize || 0
                            )}.`
                          );
                        }
                      } else {
                        setUploadWarning(null);
                      }
                      e.target.value = '';
                    }
                  }}
                  className="visually-hidden-input"
                />
                
                <textarea
                  ref={textareaRef}
                  value={editingMessage ? editingMessage.body : sendText}
                  onChange={(e) => {
                    if (editingMessage) {
                      setEditingMessage({...editingMessage, body: e.target.value});
                      // Adjust height when editing message text changes
                      setTimeout(() => {
                        if (editMessageTextareaRef.current) {
                          editMessageTextareaRef.current.style.height = 'auto';
                          
                          const lineHeight = 24;
                          const maxHeight = lineHeight * 10;
                          
                          const scrollHeight = Math.min(editMessageTextareaRef.current.scrollHeight, maxHeight);
                          editMessageTextareaRef.current.style.height = `${scrollHeight}px`;
                          
                          editMessageTextareaRef.current.style.overflowY = editMessageTextareaRef.current.scrollHeight > maxHeight ? 'auto' : 'hidden';
                        } else {
                          // If we're still in the main textarea (not editing), adjust normally
                          adjustTextareaHeight();
                        }
                      }, 0);
                    } else {
                      setSendText(e.target.value);
                      adjustTextareaHeight();
                    }
                  }}
                  onInput={() => {
                    if (!editingMessage) {
                      handleTyping();
                      adjustTextareaHeight();
                    }
                  }}
                  onPaste={() => {
                    // Adjust height after paste event (with slight delay to ensure content is processed)
                    setTimeout(adjustTextareaHeight, 10);
                  }}
                  placeholder={editingMessage ? "Редактировать сообщение…" : "Сообщение…"}
                  autoComplete="off"
                  autoFocus
                  rows={1}
                  onKeyDown={handleKeyDown}
                  className="chat-form-textarea"
                />
                
                <button 
                  type="submit" 
                  disabled={
                    !!(!roomId || 
                      (!editingMessage && !sendText.trim() && selectedFiles.length === 0) ||
                      (editingMessage && !editingMessage.body.trim() && 
                       (!editingMessage.media || editingMessage.media.length === 0) && 
                       selectedFiles.length === 0))
                  }>
                  <span className="send-text">{editingMessage ? 'Сохранить' : 'Отправить'}</span>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </form>
              
              {/* Removed the old selected files preview */}
            </>
            )
          ) : (
            <div className="chat-center-muted">
              {user?.role === 'owner'
                ? 'Выберите комнату или создайте новую, чтобы начать общаться'
                : 'Выберите комнату, чтобы начать общаться'}
            </div>
          )}
        </div>
        {isUserListOpen && (
          <aside className="chat-users-panel" ref={userPanelRef}>
            <div className="chat-users-panel-header">
              <span>Пользователи</span>
              <button
                type="button"
                className="chat-users-panel-close secondary"
                onClick={closeUserList}
              >
                ✕
              </button>
            </div>
            <div className="chat-users-panel-list">
              {allUsers.map((u) => {
                const isOnline = onlineUserIds.has(u.id);
                const statusClass = isOnline ? 'online' : 'offline';
                return (
                  <button
                    key={u.id}
                    type="button"
                    className="chat-users-panel-item"
                    onClick={() => {
                      if (!user || !textareaRef.current) return;
                      
                      // Don't add own nickname if clicking on yourself
                      if (u.id === user.id) {
                        return;
                      }
                      
                      const insert = `@${u.login} `;
                      const el = textareaRef.current;
                      const start = el.selectionStart ?? el.value.length;
                      const end = el.selectionEnd ?? el.value.length;
                      const value = el.value;
                      const nextValue =
                        value.slice(0, start) + insert + value.slice(end);
                      el.value = nextValue;
                      setSendText(nextValue);
                      el.focus();
                      const caretPos = start + insert.length;
                      el.selectionStart = caretPos;
                      el.selectionEnd = caretPos;
                      
                      // Close the user list panel after mentioning a user
                      closeUserList();
                    }}
                  >
                    <div className="chat-users-panel-item-main">
                      <span className="chat-users-panel-login">{u.login}</span>
                      <span className={`chat-users-panel-status ${statusClass}`}>
                        {isOnline ? 'онлайн' : 'оффлайн'}
                      </span>
                    </div>
                    <span className="chat-users-panel-role">
                      {u.role === 'owner'
                        ? 'Владелец'
                        : u.role === 'moderator'
                        ? 'Модератор'
                        : 'Участник'}
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>
        )}
      </div>

      <ConfirmModal
        isOpen={confirmModal.isOpen}
        title={confirmModal.title}
        message={confirmModal.message}
        confirmText={confirmModal.confirmText}
        cancelText={confirmModal.cancelText}
        variant={confirmModal.variant}
        onConfirm={confirmModal.onConfirm}
        onCancel={() => setConfirmModal((prev) => ({ ...prev, isOpen: false }))}
      />

      <InfoModal
        isOpen={uploadInfoModalOpen}
        title="Лимиты загрузки медиа"
        message={
          <div className="upload-info-list">
            <div className="upload-info-item">
              <span className="upload-info-label">Статус:</span>
              <span className={`upload-info-value ${isUploadEnabled ? 'upload-enabled' : 'upload-disabled'}`}>
                {isUploadEnabled ? 'Загрузка включена' : 'Загрузка отключена'}
              </span>
            </div>
            <div className="upload-info-item">
              <span className="upload-info-label">Максимальный размер файла:</span>
              <span className="upload-info-value">
                {!mediaSettings
                  ? 'Загрузка...'
                  : !mediaSettings.uploadsEnabled
                  ? 'Недоступно'
                  : mediaSettings.unlimited
                  ? 'Без ограничений'
                  : formatBytes(mediaSettings.maxFileSize || 0)}
              </span>
            </div>
            <div className="upload-info-item">
              <span className="upload-info-label">Хранилище:</span>
              <span className={`upload-info-value ${storageUsage.maxStorageSize === null || storageUsage.maxStorageSize === 0 ? 'upload-unlimited' : ''}`}>
                {storageUsage.maxStorageSize === null || storageUsage.maxStorageSize === 0
                  ? 'Без ограничений'
                  : `${formatBytes(storageUsage.totalBytes)} из ${formatBytes(storageUsage.maxStorageSize)}`}
              </span>
              {storageUsage.maxStorageSize !== null && storageUsage.maxStorageSize > 0 && (
                <progress
                  className={`upload-storage-bar${
                    storageUsagePercent >= 90 ? ' danger' : storageUsagePercent >= 80 ? ' warning' : ''
                  }`}
                  max={100}
                  value={storageUsagePercent}
                  aria-label="Использование хранилища"
                />
              )}
            </div>
          </div>
        }
        onClose={() => setUploadInfoModalOpen(false)}
      />
    </div>
  );
}

