import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../AuthContext';
import type { Room, Invite, User, MediaStorageSettings } from '../api';
import { rooms as roomsApi, invites as invitesApi, verification as verificationApi, users as usersApi, serverSettings as serverSettingsApi, media } from '../api';
import { useServerName } from '../ServerNameContext';
import { initializeWebSocket, addMessageHandler, removeMessageHandler } from '../websocket';
import { useToast } from '../ToastContext';
import ConfirmModal from '../components/ConfirmModal';
import { errorTranslations } from '../localization/errors';
import { useAdminChrome } from '../AdminChromeContext';
import { TabletBottomNav } from '../components/TabletBottomNav';
import {
  IconDatabase,
  IconHash,
  IconHome,
  IconHourglass,
  IconMonitor,
  IconPencil,
  IconPlus,
  IconShield,
  IconSparkles,
  IconTicket,
  IconTrash,
  IconUser,
} from '../components/icons/Icons';

// Function to translate error messages
function translateErrorMessage(errorMsg: string): string {
  return errorTranslations[errorMsg] || errorMsg;
}

function formatBytes(value: number): string {
  if (value === 0) return '0 Б';
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(2)} ГиБ`;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} МиБ`;
  if (value >= 1024) return `${(value / 1024).toFixed(2)} КиБ`;
  return `${value} Б`;
}

type PendingUser = { id: number; login: string; created_at: string; };
type UserWithDate = User & { created_at: string; };

type AdminSectionId = 'invites' | 'server' | 'media' | 'rooms' | 'verification' | 'users';

const ADMIN_OWNER_SECTIONS: { id: AdminSectionId; label: string }[] = [
  { id: 'invites', label: 'Инвайты' },
  { id: 'server', label: 'Имя сервера' },
  { id: 'media', label: 'Медиа-хранилище' },
  { id: 'rooms', label: 'Комнаты' },
  { id: 'verification', label: 'Верификация' },
  { id: 'users', label: 'Пользователи' },
];

const ADMIN_MODERATOR_SECTIONS: { id: AdminSectionId; label: string }[] = [{ id: 'invites', label: 'Инвайты' }];

export default function Admin() {
  const { user } = useAuth();
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
  
  const [rooms, setRooms] = useState<Room[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [pending, setPending] = useState<PendingUser[]>([]);
  const [users, setUsers] = useState<UserWithDate[]>([]);
  const [lastInviteUrl, setLastInviteUrl] = useState<string | null>(null);
  const [inviteOpts, setInviteOpts] = useState({ maxUses: '', expiresInHours: '' });
  const [verificationEnabled, setVerificationEnabled] = useState(false);
  const [codes, setCodes] = useState<{id: number, created_by_login: string, used: number, created_at: string, expires_at: string}[]>([]);
  const [customCode, setCustomCode] = useState<string>('');
  const { rawName, displayName, setRawNameLocal } = useServerName();
  const [serverNameInput, setServerNameInput] = useState<string>(rawName ?? '');
  const [serverNameSaving, setServerNameSaving] = useState(false);
  const [mediaStorageSettings, setMediaStorageSettings] = useState<MediaStorageSettings | null>(null);
  const [uploadLimitMode, setUploadLimitMode] = useState<'unlimited' | 'disabled' | 'custom'>('unlimited');
  const [uploadLimitInput, setUploadLimitInput] = useState<string>('');
  const [storageLimitUnlimited, setStorageLimitUnlimited] = useState(true);
  const [storageLimitInput, setStorageLimitInput] = useState<string>('');
  const [storageCleanupStrategy, setStorageCleanupStrategy] = useState<'block' | 'delete_oldest'>('block');
  const [orphanCleanupEnabled, setOrphanCleanupEnabled] = useState(true);
  const [orphanCleanupIntervalMinutes, setOrphanCleanupIntervalMinutes] = useState<string>('60');
  const [orphanCleanupGraceMinutes, setOrphanCleanupGraceMinutes] = useState<string>('10');
  const [storageSettingsSaving, setStorageSettingsSaving] = useState(false);
  const [isTabletInRange, setIsTabletInRange] = useState(
    () => window.matchMedia('(min-width: 678px) and (max-width: 876px)').matches
  );

  // State for renaming
  const [renamingRoomId, setRenamingRoomId] = useState<number | null>(null);
  const [renamingInputValue, setRenamingInputValue] = useState('');

  // State for room creation modal
  const [showCreateRoomModal, setShowCreateRoomModal] = useState(false);
  const [newRoomNameInput, setNewRoomNameInput] = useState('');

  const load = useCallback(async () => {
    try {
      // Load invites for everyone
      const iRes = await invitesApi.list();
      setInvites(iRes.invites);
      
      // Load other data only for owners
      if (user?.role === 'owner') {
        const [rRes, pRes, uRes] = await Promise.all([
          roomsApi.list(),
          verificationApi.pending(),
          usersApi.list(),
        ]);
        setRooms(rRes.rooms);
        setPending(pRes.pending);
        setUsers(uRes.users);
      }
    } catch (err) {
      showToast(err instanceof Error ? translateErrorMessage(err.message) : 'Ошибка загрузки', 'error');
    }
  }, [user, showToast]);

  useEffect(() => {
    setServerNameInput(rawName ?? '');
  }, [rawName]);

  useEffect(() => {
    if (user?.role !== 'owner' && user?.role !== 'moderator') return;
    
    // Load verification settings only for owners
    if (user.role === 'owner') {
      verificationApi.settings()
        .then(data => setVerificationEnabled(!!data.enabled))
        .catch(err => DEBUG_MODE && console.error('Error fetching verification settings:', err));

      media.getStorageSettings()
        .then((data) => {
          setMediaStorageSettings(data);
          // -1 or null means unlimited
          if (data.maxFileSize === null || data.maxFileSize === -1) {
            setUploadLimitMode('unlimited');
            setUploadLimitInput('');
          } else if (data.maxFileSize === 0) {
            // 0 means uploads disabled
            setUploadLimitMode('disabled');
            setUploadLimitInput('');
          } else {
            // Specific limit set
            setUploadLimitMode('custom');
            setUploadLimitInput(String(data.maxFileSize));
          }
          // 0, -1, or null means unlimited for storage
          if (data.maxStorageSize === null || data.maxStorageSize === 0 || data.maxStorageSize === -1) {
            setStorageLimitUnlimited(true);
            setStorageLimitInput('');
          } else {
            setStorageLimitUnlimited(false);
            setStorageLimitInput(String(data.maxStorageSize));
          }
          setStorageCleanupStrategy(data.cleanupStrategy);
          setOrphanCleanupEnabled(data.orphanCleanupEnabled);
          setOrphanCleanupIntervalMinutes(String(data.orphanCleanupIntervalMinutes));
          setOrphanCleanupGraceMinutes(String(data.orphanCleanupGraceMinutes));
        })
        .catch((err) => DEBUG_MODE && console.error('Error loading media storage settings:', err));
      
      // Load users
      usersApi.list().then((data) => {
        setUsers(data.users);
      }).catch(err => DEBUG_MODE && console.error('Error loading users:', err));
      
      // Load pending verifications
      verificationApi.pending().then((data) => {
        setPending(data.pending);
      }).catch(err => DEBUG_MODE && console.error('Error loading pending verifications:', err));
      
      // Load verification codes
      verificationApi.listCodes().then((data) => {
        setCodes(data.codes);
      }).catch(err => DEBUG_MODE && console.error('Error loading verification codes:', err));
    }

    load();
  }, [user, load]);

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 678px) and (max-width: 876px)');
    const onChange = () => setIsTabletInRange(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const adminSections = useMemo(
    () => (user?.role === 'owner' ? ADMIN_OWNER_SECTIONS : ADMIN_MODERATOR_SECTIONS),
    [user?.role]
  );
  const [activeSection, setActiveSection] = useState<AdminSectionId>('invites');
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const { setAdminChrome } = useAdminChrome();

  const selectAdminSection = useCallback((id: AdminSectionId) => {
    setActiveSection(id);
    setMobilePanelOpen(true);
  }, []);

  const goBackAdminMobile = useCallback(() => {
    setMobilePanelOpen(false);
  }, []);

  const adminSectionTitle = useMemo(
    () => adminSections.find((s) => s.id === activeSection)?.label ?? 'Админка',
    [adminSections, activeSection]
  );

  useEffect(() => {
    if (user?.role === 'moderator' && activeSection !== 'invites') {
      setActiveSection('invites');
    }
  }, [user?.role, activeSection]);

  useEffect(() => {
    setAdminChrome({
      sectionTitle: adminSectionTitle,
      panelOpen: mobilePanelOpen,
      onBack: goBackAdminMobile,
    });
    return () => setAdminChrome(null);
  }, [adminSectionTitle, mobilePanelOpen, goBackAdminMobile, setAdminChrome]);

  // WebSocket realtime updates for admin data
  useEffect(() => {
    if (!user || (user.role !== 'owner' && user.role !== 'moderator')) return;

    const handleWsMessage = (data: any) => {
      switch (data.type) {
        case 'room_created':
          if (user.role === 'owner' && data.room) {
            setRooms(prev => {
              if (prev.some(r => r.id === data.room.id)) return prev;
              return [...prev, data.room];
            });
          }
          break;

        case 'room_updated':
          if (user.role === 'owner' && data.room) {
            setRooms(prev =>
              prev.map(r => (r.id === data.room.id ? { ...r, ...data.room } : r))
            );
          }
          break;

        case 'room_deleted':
          if (user.role === 'owner' && typeof data.roomId === 'number') {
            setRooms(prev => prev.filter(r => r.id !== data.roomId));
          }
          break;

        case 'room_messages_cleared':
          // Админке не нужно состояние сообщений по комнатам, можно игнорировать
          break;

        case 'invites_changed':
          // Перезагружаем только инвайты
          invitesApi.list()
            .then(res => setInvites(res.invites))
            .catch(() => {});
          break;

        case 'verification_codes_changed':
          if (user.role === 'owner') {
            verificationApi.listCodes()
              .then(res => setCodes(res.codes))
              .catch(() => {});
          }
          break;

        case 'verification_settings_updated':
          if (user.role === 'owner') {
            // Новое поле settings предпочтительно, но поддерживаем и enabled
            const enabled = typeof data.enabled === 'boolean'
              ? data.enabled
              : !!data.settings?.enabled;
            setVerificationEnabled(enabled);
          }
          break;

        case 'user_role_changed':
        case 'user_updated':
        case 'user_verification_changed':
        case 'user_deleted_admin':
          if (user.role === 'owner') {
            // Обновляем список пользователей и ожидающих
            usersApi.list()
              .then(res => setUsers(res.users))
              .catch(() => {});
            verificationApi.pending()
              .then(res => setPending(res.pending))
              .catch(() => {});
          }
          break;

        case 'user_verified':
        case 'user_rejected':
          if (user.role === 'owner') {
            // Эти события уже приходят конкретному пользователю, но для админки обновим списки
            usersApi.list()
              .then(res => setUsers(res.users))
              .catch(() => {});
            verificationApi.pending()
              .then(res => setPending(res.pending))
              .catch(() => {});
          }
          break;

        case 'server_settings_updated':
          if (user.role === 'owner' && data.settings) {
            const name = data.settings.server_name ?? null;
            setRawNameLocal(name);
            setServerNameInput(name ?? '');
          }
          break;

        default:
          break;
      }
    };

    initializeWebSocket();
    addMessageHandler(handleWsMessage);

    return () => {
      removeMessageHandler(handleWsMessage);
    };
  }, [user, setRawNameLocal]);

  // Helper function for copying text to clipboard with fallback
  const copyToClipboard = async (text: string) => {
    try {
      if (!navigator.clipboard) {
        throw new Error('Clipboard API not supported');
      }
      await navigator.clipboard.writeText(text);
    } catch (err) {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'absolute';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      try {
        const successful = document.execCommand('copy');
        if (!successful) {
          throw new Error('Fallback copy failed');
        }
      } catch (fallbackErr) {
        console.error('Fallback copy failed:', fallbackErr);
        throw fallbackErr;
      } finally {
        document.body.removeChild(textarea);
      }
    }
  };

  // Functions for invites (available to both owners and moderators)
  async function createInvite(e: React.FormEvent) {
    e.preventDefault();
    try {
      const inv = await invitesApi.create({
        maxUses: inviteOpts.maxUses ? Number(inviteOpts.maxUses) : undefined,
        expiresInHours: inviteOpts.expiresInHours ? Number(inviteOpts.expiresInHours) : undefined,
      });
      await load();
      const baseUrl = import.meta.env.VITE_APP_PUBLIC_URL || location.origin;
      const url = `${baseUrl.replace(/\/$/, '')}/register?invite=${inv.id}`;
      setLastInviteUrl(url);
      showToast('Инвайт создан. Ссылка скопирована в буфер.', 'success');

      // Use the new copyToClipboard helper
      await copyToClipboard(url);
    } catch (err) {
      showToast(err instanceof Error ? translateErrorMessage(err.message) : 'Ошибка', 'error');
    }
  }


  async function deleteInvite(id: string) {
    try {
      await invitesApi.delete(id);
      await load();
      showToast('Инвайт удалён', 'success');
    } catch (err) {
      showToast(err instanceof Error ? translateErrorMessage(err.message) : 'Ошибка', 'error');
    }
  }

  // Functions for other sections (only for owners)
  async function createRoom(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (user?.role !== 'owner') {
      showToast('Только владелец может создавать комнаты', 'error');
      return;
    }

    const trimmedName = newRoomNameInput.trim();

    if (!trimmedName) {
      showToast('Введите название комнаты', 'error');
      return;
    }

    if (trimmedName.length > 32) {
      showToast('Название комнаты не может превышать 32 символа', 'error');
      return;
    }

    try {
      await roomsApi.create(trimmedName);
      setNewRoomNameInput('');
      setShowCreateRoomModal(false);
      showToast('Комната создана', 'success');
    } catch (err) {
      showToast(err instanceof Error ? translateErrorMessage(err.message) : 'Ошибка', 'error');
    }
  }

  async function saveServerName(e: React.FormEvent) {
    if (user?.role !== 'owner') {
      showToast('Только владелец может изменять имя сервера', 'error');
      return;
    }
    
    e.preventDefault();
    const trimmed = serverNameInput.trim();
    
    // Apply 32 character limit
    if (trimmed.length > 32) {
      showToast('Имя сервера слишком длинное (максимум 32 символа)', 'error');
      return;
    }
    
    setServerNameSaving(true);
    try {
      const res = await serverSettingsApi.update(trimmed);
      setRawNameLocal(res.server_name ?? null);
      showToast('Имя сервера обновлено', 'success');
    } catch (err) {
      showToast(err instanceof Error ? translateErrorMessage(err.message) : 'Ошибка при сохранении имени сервера', 'error');
    } finally {
      setServerNameSaving(false);
    }
  }

  async function saveMediaStorageSettings(e: React.FormEvent) {
    e.preventDefault();
    if (user?.role !== 'owner') {
      showToast('Только владелец может изменять настройки хранилища', 'error');
      return;
    }

    // Calculate actual values based on mode
    const parsedUploadLimit =
      uploadLimitMode === 'unlimited' ? -1 :
      uploadLimitMode === 'disabled' ? 0 :
      (uploadLimitInput === '' ? 52428800 : Number(uploadLimitInput));
    const parsedLimit = storageLimitUnlimited ? 0 : Number(storageLimitInput);
    const parsedCleanupInterval = Number(orphanCleanupIntervalMinutes);
    const parsedCleanupGrace = Number(orphanCleanupGraceMinutes);

    // Validate custom file limit
    if (uploadLimitMode === 'custom' && (!Number.isFinite(parsedUploadLimit) || parsedUploadLimit <= 0)) {
      showToast('Лимит файла должен быть числом > 0 (в байтах)', 'error');
      return;
    }
    // Validate custom storage limit
    if (!storageLimitUnlimited) {
      if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
        showToast('Лимит хранилища должен быть числом > 0 (в байтах)', 'error');
        return;
      }
    }

    // Validate that storage limit is not less than current usage (unless unlimited)
    if (!storageLimitUnlimited && parsedLimit > 0 && mediaStorageSettings && parsedLimit < mediaStorageSettings.totalBytes) {
      showToast(
        `Лимит хранилища (${formatBytes(parsedLimit)}) меньше текущего объёма (${formatBytes(mediaStorageSettings.totalBytes)}). Освободите место или увеличьте лимит.`,
        'error'
      );
      return;
    }
    if (!Number.isFinite(parsedCleanupInterval) || parsedCleanupInterval < 1) {
      showToast('Интервал очистки должен быть >= 1 минуты', 'error');
      return;
    }
    if (!Number.isFinite(parsedCleanupGrace) || parsedCleanupGrace < 1) {
      showToast('Safety-окно должно быть >= 1 минуты', 'error');
      return;
    }

    setStorageSettingsSaving(true);
    try {
      const saved = await media.updateStorageSettings({
        maxFileSize: parsedUploadLimit,
        maxStorageSize: parsedLimit,
        cleanupStrategy: storageCleanupStrategy,
        orphanCleanupEnabled,
        orphanCleanupIntervalMinutes: parsedCleanupInterval,
        orphanCleanupGraceMinutes: parsedCleanupGrace,
      });
      setMediaStorageSettings(saved);
      // Update UI state based on saved values
      if (saved.maxFileSize === null || saved.maxFileSize === -1) {
        setUploadLimitMode('unlimited');
        setUploadLimitInput('');
      } else if (saved.maxFileSize === 0) {
        setUploadLimitMode('disabled');
        setUploadLimitInput('');
      } else {
        setUploadLimitMode('custom');
        setUploadLimitInput(String(saved.maxFileSize));
      }
      if (saved.maxStorageSize === null || saved.maxStorageSize === 0 || saved.maxStorageSize === -1) {
        setStorageLimitUnlimited(true);
        setStorageLimitInput('');
      } else {
        setStorageLimitUnlimited(false);
        setStorageLimitInput(String(saved.maxStorageSize));
      }
      setOrphanCleanupEnabled(saved.orphanCleanupEnabled);
      setOrphanCleanupIntervalMinutes(String(saved.orphanCleanupIntervalMinutes));
      setOrphanCleanupGraceMinutes(String(saved.orphanCleanupGraceMinutes));
      showToast('Настройки медиа-хранилища обновлены', 'success');
    } catch (err) {
      showToast(err instanceof Error ? translateErrorMessage(err.message) : 'Ошибка сохранения', 'error');
    } finally {
      setStorageSettingsSaving(false);
    }
  }

  async function deleteRoom(id: number) {
    if (user?.role !== 'owner') {
      showToast('Только владелец может удалять комнаты', 'error');
      return;
    }

    setConfirmModal({
      isOpen: true,
      title: 'Удалить комнату?',
      message: 'Удалить комнату и все сообщения?',
      confirmText: 'Удалить',
      cancelText: 'Отмена',
      variant: 'danger',
      onConfirm: async () => {
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));
        try {
          await roomsApi.delete(id);
          showToast('Комната удалена', 'success');
        } catch (err) {
          showToast(err instanceof Error ? translateErrorMessage(err.message) : 'Ошибка', 'error');
        }
      }
    });
  }

  async function clearRoomMessages(id: number) {
    if (user?.role !== 'owner') {
      showToast('Только владелец может очищать сообщения в комнатах', 'error');
      return;
    }

    setConfirmModal({
      isOpen: true,
      title: 'Очистить сообщения?',
      message: 'Очистить все сообщения в комнате?',
      confirmText: 'Очистить',
      cancelText: 'Отмена',
      variant: 'danger',
      onConfirm: async () => {
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));
        try {
          await roomsApi.clearMessages(id);
          showToast('Сообщения в комнате очищены', 'success');
        } catch (err) {
          showToast(err instanceof Error ? translateErrorMessage(err.message) : 'Ошибка', 'error');
        }
      }
    });
  }

  async function approve(userId: number) {
    if (user?.role !== 'owner') {
      showToast('Только владелец может верифицировать пользователей', 'error');
      return;
    }
    
    try {
      await verificationApi.approve(userId);
      showToast('Пользователь верифицирован', 'success');
      // Обновление будет происходить через WebSocket, так что не нужно вызывать load() здесь
    } catch (err) {
      showToast(err instanceof Error ? translateErrorMessage(err.message) : 'Ошибка', 'error');
    }
  }

  async function reject(userId: number) {
    if (user?.role !== 'owner') {
      showToast('Только владелец может отклонять пользователей', 'error');
      return;
    }

    setConfirmModal({
      isOpen: true,
      title: 'Отклонить пользователя?',
      message: 'Отклонить и удалить пользователя?',
      confirmText: 'Отклонить',
      cancelText: 'Отмена',
      variant: 'danger',
      onConfirm: async () => {
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));
        try {
          await usersApi.delete(userId, 'Ваша заявка на верификацию была отклонена');
          showToast('Пользователь отклонён', 'success');
        } catch (err) {
          showToast(err instanceof Error ? translateErrorMessage(err.message) : 'Ошибка', 'error');
        }
      }
    });
  }

  async function changeUserRole(userId: number, role: 'owner' | 'moderator' | 'member') {
    if (user?.role !== 'owner') {
      showToast('Только владелец может изменять роли пользователей', 'error');
      return;
    }
    
    try {
      await usersApi.changeRole(userId, role);
      showToast('Роль изменена', 'success');
      // Обновление будет происходить через WebSocket, так что не нужно вызывать load() здесь
    } catch (err) {
      showToast(err instanceof Error ? translateErrorMessage(err.message) : 'Ошибка', 'error');
    }
  }

  const handleVerificationToggle = () => {
    if (user?.role !== 'owner') {
      showToast('Только владелец может изменять настройки верификации', 'error');
      return;
    }

    if (verificationEnabled) {
      // Disabling verification
      if (pending.length > 0) {
        setConfirmModal({
          isOpen: true,
          title: 'Отключить верификацию?',
          message: `Есть ${pending.length} пользователей ожидающих подтверждения. Сначала обработайте их в разделе "Верификация".`,
          confirmText: 'Всё равно отключить',
          cancelText: 'Отмена',
          variant: 'warning',
          onConfirm: async () => {
            setConfirmModal((prev) => ({ ...prev, isOpen: false }));
            await disableVerification();
          }
        });
      } else {
        disableVerification();
      }
    } else {
      // Enabling verification
      enableVerification();
    }
  };

  const disableVerification = async () => {
    try {
      const response = await verificationApi.updateSettings(false);
      setVerificationEnabled(response.enabled);
      showToast('Система верификации отключена', 'success');
    } catch (error) {
      DEBUG_MODE && console.error('Failed to disable verification:', error);
      showToast('Ошибка при отключении верификации', 'error');
    }
  };

  const enableVerification = async () => {
    try {
      const response = await verificationApi.updateSettings(true);
      setVerificationEnabled(response.enabled);
      showToast('Система верификации включена', 'success');
    } catch (error) {
      DEBUG_MODE && console.error('Failed to enable verification:', error);
      showToast('Ошибка при включении верификации', 'error');
    }
  };

  const createVerificationCode = async () => {
    if (user?.role !== 'owner') {
      showToast('Только владелец может создавать коды верификации', 'error');
      return;
    }
    
    try {
      // Fixed: only pass the customCode as the single argument
      const newCode = await verificationApi.createCode(customCode || undefined);
      
      // Creating a temporary object with all the fields for the UI
      const fullCode = {
        id: newCode.id,
        created_by_login: "Вы", // Placeholder - in real app, we'd fetch this info separately
        used: 0,
        created_at: new Date().toISOString(),
        expires_at: newCode.expires_at
      };
      setCodes([fullCode, ...codes]);

      // Use the new copyToClipboard helper
      await copyToClipboard(newCode.code);

      setCustomCode(''); // Очищаем поле ввода после успешного создания
      showToast('Код верификации создан и скопирован в буфер', 'success');
    } catch (error) {
      DEBUG_MODE && console.error('Failed to create verification code:', error);
      showToast('Ошибка при создании кода: ' + (error as Error).message, 'error');
    }
  };


  const deleteVerificationCode = async (id: number) => {
    if (user?.role !== 'owner') {
      showToast('Только владелец может удалять коды верификации', 'error');
      return;
    }
    
    try {
      await verificationApi.deleteCode(id);
      setCodes(codes.filter(code => code.id !== id));
      showToast('Код удален', 'success');
    } catch (error) {
      DEBUG_MODE && console.error('Failed to delete verification code:', error);
      showToast('Ошибка при удалении кода', 'error');
    }
  };

  // Add a new state for tracking the reason for deletion
  const [deletingUserId, setDeletingUserId] = useState<number | null>(null);
  const [deletionReason, setDeletionReason] = useState<string>('Account removed by administrator');

  // Add a new function to handle user deletion with reason
  const handleDeleteUserWithReason = async (userId: number) => {
    if (user?.role !== 'owner') {
      showToast('Только владелец может удалять пользователей', 'error');
      return;
    }
    
    setDeletingUserId(userId);
    setDeletionReason('Account removed by administrator'); // Reset to default reason
  };

  // Add a new function to confirm user deletion with reason
  const confirmDeleteUser = async () => {
    if (user?.role !== 'owner') {
      showToast('Только владелец может удалять пользователей', 'error');
      setDeletingUserId(null);
      return;
    }

    if (deletingUserId !== null) {
      setConfirmModal({
        isOpen: true,
        title: 'Удалить пользователя?',
        message: `Вы уверены, что хотите удалить пользователя? Причина: ${deletionReason}`,
        confirmText: 'Удалить',
        cancelText: 'Отмена',
        variant: 'danger',
        onConfirm: async () => {
          setConfirmModal((prev) => ({ ...prev, isOpen: false }));
          try {
            await usersApi.delete(deletingUserId, deletionReason);
            await refreshUsers();
            showToast('Пользователь удален', 'success');
          } catch (err) {
            showToast(err instanceof Error ? translateErrorMessage(err.message) : 'Ошибка при удалении пользователя', 'error');
          } finally {
            setDeletingUserId(null);
            setDeletionReason('');
          }
        }
      });
    }
  };

  // Add a new function to refresh users list
  const refreshUsers = async () => {
    if (user?.role !== 'owner') {
      showToast('Только владелец может обновлять список пользователей', 'error');
      return;
    }
    
    try {
      const uRes = await usersApi.list();
      setUsers(uRes.users);
    } catch (err) {
      showToast(err instanceof Error ? translateErrorMessage(err.message) : 'Ошибка загрузки', 'error');
    }
  };

  async function renameRoom(id: number, name: string) {
    if (user?.role !== 'owner') {
      showToast('Только владелец может переименовывать комнаты', 'error');
      return;
    }
    
    if (!name.trim()) {
      showToast('Введите название комнаты', 'error');
      return;
    }
    
    if (name.length > 32) {
      showToast('Название комнаты не может превышать 32 символа', 'error');
      return;
    }
    
    try {
      await roomsApi.update(id, name.trim());
      showToast('Комната переименована', 'success');
      setRenamingRoomId(null);
      setRenamingInputValue(''); // Reset renaming input value
      // Обновление будет происходить через WebSocket, так что не нужно вызывать load() здесь
    } catch (err) {
      showToast(err instanceof Error ? translateErrorMessage(err.message) : 'Ошибка', 'error');
    }
  }

  return (
    <div className={`admin-page page-content page-content--admin admin-page-tablet${mobilePanelOpen ? ' has-panel' : ''}`}>
      <div className="nav-sidebar">
        <div className="nav-sidebar-header">Админка</div>
        <div className="nav-sidebar-list">
          {adminSections.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`nav-sidebar-item${activeSection === s.id ? ' active' : ''}`}
              onClick={() => selectAdminSection(s.id)}
            >
              <span className="nav-sidebar-item-name">{s.label}</span>
            </button>
          ))}
        </div>
        {isTabletInRange && <TabletBottomNav showAdmin />}
      </div>

      <div className="admin-main">
        <div className="admin-main-heading-desktop">{adminSectionTitle}</div>
        <div className="admin-panel-inner">
          {activeSection === 'invites' && (
            <div className="card">
        <h3 className="admin-card-title">
          <span className="icon-inline" aria-hidden>
            <IconTicket />
          </span>
          Инвайты
        </h3>
        <form onSubmit={createInvite} className="admin-form-stack admin-form-stack--mb-lg">
          <input
            type="number"
            min={1}
            value={inviteOpts.maxUses}
            onChange={(e) => setInviteOpts((o) => ({ ...o, maxUses: e.target.value }))}
            placeholder="Макс. использований (необязательно)"
          />
          <input
            type="number"
            min={1}
            value={inviteOpts.expiresInHours}
            onChange={(e) => setInviteOpts((o) => ({ ...o, expiresInHours: e.target.value }))}
            placeholder="Срок в часах (необязательно)"
          />
          <button type="submit" className="admin-btn-block">
            <span className="icon-inline" aria-hidden>
              <IconPlus />
            </span>{' '}
            Создать инвайт
          </button>
        </form>
        {lastInviteUrl && (
          <div className="admin-invite-highlight">
            <div className="admin-muted-label">Ссылка для приглашения:</div>
            <a href={lastInviteUrl} target="_blank" rel="noreferrer" className="admin-invite-link">
              {lastInviteUrl}
            </a>
            {import.meta.env.VITE_APP_PUBLIC_URL && (
              <div className="admin-hint-small">По настройке VITE_APP_PUBLIC_URL</div>
            )}
          </div>
        )}
        {invites.length === 0 ? (
          <p className="admin-empty-hint">Нет активных инвайтов</p>
        ) : (
          <div className="admin-list-col">
            {invites.map((inv) => (
              <div key={inv.id} className="admin-row-card">
                <code className="admin-code-badge">{inv.id}</code>
                <span className="admin-flex-meta">
                  {inv.uses_count}
                  {inv.max_uses != null ? `/${inv.max_uses}` : ''} ·{' '}
                  {inv.expires_at ? new Date(inv.expires_at).toLocaleString() : 'без срока'}
                </span>
                <button type="button" className="danger admin-btn-sm" onClick={() => deleteInvite(inv.id)} aria-label="Удалить инвайт">
                  <span className="icon-inline" aria-hidden>
                    <IconTrash />
                  </span>
                </button>
              </div>
            ))}
          </div>
        )}
            </div>
          )}

          {activeSection === 'server' && user?.role === 'owner' && (
          <div className="card">
            <h3 className="admin-card-title">
              <span className="icon-inline" aria-hidden>
                <IconMonitor />
              </span>
              Имя сервера
            </h3>
            <p className="admin-lead">
              Текущее отображение: <strong>{displayName}</strong>
            </p>
            <form onSubmit={saveServerName} className="admin-form-stack admin-form-stack--mb-sm">
              <input
                type="text"
                value={serverNameInput}
                onChange={(e) => setServerNameInput(e.target.value.slice(0, 32))}
                placeholder="Например: Мой сервер"
                maxLength={32}
              />
              <button type="submit" disabled={serverNameSaving} className="admin-btn-inline">
                {serverNameSaving ? 'Сохранение…' : 'Сохранить имя сервера'}
              </button>
            </form>
            <p className="admin-hint-tiny">
              Пример: <strong>Мой сервер</strong>
            </p>
          </div>
          )}

          {activeSection === 'media' && user?.role === 'owner' && (
          <div className="card">
            <h3 className="admin-card-title">
              <span className="icon-inline" aria-hidden>
                <IconDatabase />
              </span>
              Медиа-хранилище
            </h3>
            <form onSubmit={saveMediaStorageSettings} className="admin-form-stack">
              <label className="admin-label-col">
                <span className="admin-label-text">
                  Лимит одного файла
                </span>
                <select
                  className="admin-settings-select"
                  value={uploadLimitMode}
                  onChange={(e) => setUploadLimitMode(e.target.value as 'unlimited' | 'disabled' | 'custom')}
                >
                  <option value="unlimited">Без ограничений</option>
                  <option value="disabled">Отправка отключена</option>
                  <option value="custom">Установить лимит</option>
                </select>
                {uploadLimitMode === 'custom' && (
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={uploadLimitInput}
                    onChange={(e) => setUploadLimitInput(e.target.value)}
                    placeholder="52428800"
                    style={{ marginTop: '0.5rem' }}
                  />
                )}
              </label>

              <label className="admin-label-col">
                <span className="admin-label-text">
                  Лимит хранилища (в байтах)
                </span>
                <div className="admin-label-row admin-toggle-row">
                  <label className="admin-toggle-switch">
                    <input
                      type="checkbox"
                      checked={storageLimitUnlimited}
                      onChange={(e) => setStorageLimitUnlimited(e.target.checked)}
                    />
                    <span className="admin-toggle-slider"></span>
                  </label>
                  <span className="admin-label-text">Без ограничений</span>
                </div>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={storageLimitInput}
                  onChange={(e) => setStorageLimitInput(e.target.value)}
                  placeholder="Установите Лимит..."
                  disabled={storageLimitUnlimited}
                />
              </label>

              <label className="admin-label-col">
                <span className="admin-label-text">Политика при превышении квоты</span>
                <select
                  className="admin-settings-select"
                  value={storageCleanupStrategy}
                  onChange={(e) => setStorageCleanupStrategy(e.target.value as 'block' | 'delete_oldest')}
                >
                  <option value="block">block (блокировать новые загрузки)</option>
                  <option value="delete_oldest">delete_oldest (удалять самые старые файлы)</option>
                </select>
              </label>

              <div className="admin-label-row admin-toggle-row">
                <label className="admin-toggle-switch">
                  <input
                    type="checkbox"
                    checked={orphanCleanupEnabled}
                    onChange={(e) => setOrphanCleanupEnabled(e.target.checked)}
                  />
                  <span className="admin-toggle-slider"></span>
                </label>
                <span className="admin-label-text">Включить автоочистку orphaned-файлов</span>
              </div>

              <label className="admin-label-col">
                <span className="admin-label-text">
                  Интервал автоочистки (минуты)
                </span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={orphanCleanupIntervalMinutes}
                  onChange={(e) => setOrphanCleanupIntervalMinutes(e.target.value)}
                />
              </label>

              <label className="admin-label-col">
                <span className="admin-label-text">
                  Safety-окно перед удалением orphaned-файла (минуты)
                </span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={orphanCleanupGraceMinutes}
                  onChange={(e) => setOrphanCleanupGraceMinutes(e.target.value)}
                />
              </label>

              <button type="submit" disabled={storageSettingsSaving} className="admin-btn-inline">
                {storageSettingsSaving ? 'Сохранение…' : 'Сохранить настройки хранилища'}
              </button>
            </form>

            {mediaStorageSettings && (
              <div className="admin-storage-footnote">
                <div>
                  Использовано: {formatBytes(mediaStorageSettings.totalBytes)} ({mediaStorageSettings.filesCount} файлов)
                  {!storageLimitUnlimited && storageLimitInput && Number(storageLimitInput) > 0 && (
                    <> из {formatBytes(Number(storageLimitInput))}</>
                  )}
                </div>
                {!storageLimitUnlimited && storageLimitInput && Number(storageLimitInput) > 0 && mediaStorageSettings.totalBytes > 0 && (
                  <div className="admin-storage-percent">
                    Хранилище заполнено примерно на {((mediaStorageSettings.totalBytes / Number(storageLimitInput)) * 100).toFixed(2)}%
                  </div>
                )}
              </div>
            )}
          </div>
          )}

          {activeSection === 'rooms' && user?.role === 'owner' && (
          <div className="card">
            <h3 className="admin-card-title">
              <span className="icon-inline" aria-hidden>
                <IconHome />
              </span>
              Комнаты
            </h3>
            <button
              type="button"
              onClick={() => { setNewRoomNameInput(''); setShowCreateRoomModal(true); }}
              className="admin-btn-create-room"
              title="Создать комнату"
            >
              <span className="icon-inline" aria-hidden>
                <IconPlus />
              </span>{' '}
              Создать комнату
            </button>
            {rooms.length === 0 ? (
              <p className="admin-empty-hint">Нет комнат</p>
            ) : (
              <div className="admin-list-col">
                {rooms.map((r) => (
                  <div key={r.id} className="admin-row-card">
                    <span className="admin-room-title">{r.name}</span>
                    <div className="admin-room-actions">
                      {r.name === 'main' ? (
                        <button
                          type="button"
                          onClick={() => clearRoomMessages(r.id)}
                          className="admin-btn-room admin-btn-room--warn"
                          title="Очистить сообщения"
                        >
                          <span className="icon-inline" aria-hidden>
                            <IconSparkles />
                          </span>
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => { setRenamingRoomId(r.id); setRenamingInputValue(r.name); }}
                            className="admin-btn-room admin-btn-room--accent"
                            title="Переименовать"
                          >
                            <span className="icon-inline" aria-hidden>
                              <IconPencil />
                            </span>
                          </button>
                          <button
                            type="button"
                            className="admin-btn-room admin-btn-room--danger danger"
                            onClick={() => deleteRoom(r.id)}
                            title="Удалить"
                          >
                            <span className="icon-inline" aria-hidden>
                              <IconTrash />
                            </span>
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          )}

      {activeSection === 'verification' && user?.role === 'owner' && (
        <>
          <div className="card">
            <h3 className="admin-card-title">
              <span className="icon-inline" aria-hidden>
                <IconShield />
              </span>
              Настройка верификации
            </h3>
            <div className="admin-toggle-row">
              <label className="admin-toggle-switch">
                <input
                  type="checkbox"
                  checked={verificationEnabled}
                  onChange={handleVerificationToggle}
                />
                <span className="admin-toggle-slider"></span>
              </label>
              <span className="admin-label-text">
                {verificationEnabled ? 'Система верификации включена' : 'Система верификации отключена'}
              </span>
            </div>

            {verificationEnabled && (
              <div className="admin-info-box">
                <p>При включенной системе все новые пользователи будут ожидать верификации.</p>
                <p>
                  Вы можете использовать одноразовые коды для автоматической верификации или проверять кодовые слова
                  вручную для пользователей.
                </p>
              </div>
            )}
          </div>

          {verificationEnabled && pending.length > 0 && (
            <div className="card">
              <h3 className="admin-card-title">
                <span className="icon-inline" aria-hidden>
                  <IconShield />
                </span>
                Верификация (ожидают: {pending.length})
              </h3>
              <div className="admin-list-col--lg">
                {pending.map((u) => (
                  <div key={u.id} className="admin-pending-card">
                    <div className="admin-pending-login">
                      <span className="icon-inline" aria-hidden>
                        <IconUser />
                      </span>
                      {u.login}
                    </div>
                    <div className="admin-form-stack">
                      <div className="admin-actions-row">
                        <button type="button" onClick={() => approve(u.id)} className="admin-btn-grow">
                          Подтвердить
                        </button>
                        <button type="button" className="danger admin-btn-grow" onClick={() => reject(u.id)}>
                          Отклонить
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Card for verification codes if verification is enabled */}
          {verificationEnabled && (
            <div className="card">
              <h3 className="admin-card-title">
                <span className="icon-inline" aria-hidden>
                  <IconHash />
                </span>
                Одноразовые коды верификации
              </h3>
              <div className="admin-code-create-block">
                <input
                  type="text"
                  placeholder="Введите свой код (необязательно)"
                  value={customCode}
                  onChange={(e) => setCustomCode(e.target.value)}
                  className="admin-code-input"
                />
                <button type="button" onClick={createVerificationCode} className="admin-btn-block">
                  <span className="icon-inline" aria-hidden>
                    <IconPlus />
                  </span>{' '}
                  Создать одноразовый код
                </button>
              </div>

              {codes.length === 0 ? (
                <p className="admin-empty-hint admin-margin-0">Нет активных кодов</p>
              ) : (
                <div className="admin-form-stack">
                  {codes.map((code) => (
                    <div key={code.id} className="admin-code-row">
                      <div>
                        <div className="text-bold">ID: {code.id}</div>
                        <div className="text-sm-muted">Создан: {new Date(code.created_at).toLocaleString()}</div>
                      </div>
                      <div className="admin-code-row-meta">
                        <div>Статус: {code.used ? 'Использован' : 'Доступен'}</div>
                        <div className="text-sm-muted">Срок до: {new Date(code.expires_at).toLocaleString()}</div>
                      </div>
                      <button
                        type="button"
                        className="admin-code-delete"
                        onClick={() => {
                          setConfirmModal({
                            isOpen: true,
                            title: 'Удалить код?',
                            message: 'Удалить этот код?',
                            confirmText: 'Удалить',
                            cancelText: 'Отмена',
                            variant: 'danger',
                            onConfirm: () => {
                              setConfirmModal((prev) => ({ ...prev, isOpen: false }));
                              deleteVerificationCode(code.id);
                            }
                          });
                        }}
                      >
                        Удалить
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

          {activeSection === 'users' && user?.role === 'owner' && (
          <div className="card">
            <h3 className="admin-card-title">
              <span className="icon-inline" aria-hidden>
                <IconUser />
              </span>
              Пользователи
            </h3>
            {users.length === 0 ? (
              <p className="admin-empty-hint">Нет пользователей</p>
            ) : (
              <div className="admin-list-col--lg">
                {users.map((u) => (
                  <div key={u.id} className="admin-user-card">
                    <div className="admin-user-row">
                      <div className="admin-user-main">
                        <div className="admin-user-login">{u.login}</div>
                        <div className="admin-user-status">
                          {u.verified ? (
                            'Верифицирован'
                          ) : (
                            <span className="admin-user-status-pending">
                              <span className="icon-inline" aria-hidden>
                                <IconHourglass />
                              </span>{' '}
                              Ожидает
                            </span>
                          )}
                        </div>
                      </div>
                      <select
                        value={u.role}
                        onChange={(e) => changeUserRole(u.id, e.target.value as 'owner' | 'moderator' | 'member')}
                        disabled={u.role === 'owner'}
                        className="admin-user-role-select"
                      >
                        <option value="owner">Владелец</option>
                        <option value="moderator">Модератор</option>
                        <option value="member">Участник</option>
                      </select>
                      {u.role !== 'owner' && (
                        <button
                          type="button"
                          className="danger admin-user-delete"
                          onClick={() => handleDeleteUserWithReason(u.id)}
                        >
                          <span className="icon-inline" aria-hidden>
                            <IconTrash />
                          </span>{' '}
                          Удалить
                        </button>
                      )}
                    </div>

                    {!u.verified && u.role === 'member' && verificationEnabled && (
                      <div className="admin-user-verify-row">
                        <button type="button" onClick={() => approve(u.id)} className="admin-btn-grow">
                          Подтвердить
                        </button>
                        <button type="button" className="danger admin-btn-grow" onClick={() => reject(u.id)}>
                          Отклонить
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          )}

        </div>
      </div>
      
      {/* Add the modal for deletion reason if needed */}
      {deletingUserId !== null && user?.role === 'owner' && (
        <div className="admin-modal-overlay">
          <div className="admin-modal-dialog">
            <h3 className="admin-modal-title">Причина удаления</h3>

            <div className="admin-modal-field">
              <label className="form-label">Укажите причину удаления:</label>
              <textarea
                value={deletionReason}
                onChange={(e) => setDeletionReason(e.target.value)}
                className="admin-modal-textarea"
              />
            </div>

            <div className="admin-modal-actions">
              <button type="button" className="secondary" onClick={() => setDeletingUserId(null)}>
                Отмена
              </button>
              <button type="button" onClick={confirmDeleteUser} className="danger">
                Удалить
              </button>
            </div>
          </div>
        </div>
      )}

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

      {/* Create Room Modal */}
      {showCreateRoomModal && (
        <div className="admin-modal-overlay" onClick={() => setShowCreateRoomModal(false)}>
          <div className="admin-modal-dialog" onClick={(e) => e.stopPropagation()}>
            <h3 className="admin-modal-title">Создать комнату</h3>
            <div className="admin-modal-field">
              <label className="form-label">Название комнаты:</label>
              <input
                type="text"
                value={newRoomNameInput}
                onChange={(e) => setNewRoomNameInput(e.target.value.slice(0, 32))}
                placeholder="Например: General"
                maxLength={32}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    createRoom();
                  } else if (e.key === 'Escape') {
                    setShowCreateRoomModal(false);
                  }
                }}
              />
            </div>
            <div className="admin-modal-actions">
              <button type="button" className="secondary" onClick={() => setShowCreateRoomModal(false)}>
                Отмена
              </button>
              <button type="button" onClick={() => createRoom()}>
                Создать комнату
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rename Room Modal */}
      {renamingRoomId !== null && (
        <div className="admin-modal-overlay" onClick={() => { setRenamingRoomId(null); setRenamingInputValue(''); }}>
          <div className="admin-modal-dialog" onClick={(e) => e.stopPropagation()}>
            <h3 className="admin-modal-title">Переименовать комнату</h3>
            <div className="admin-modal-field">
              <label className="form-label">Новое название:</label>
              <input
                type="text"
                value={renamingInputValue}
                onChange={(e) => setRenamingInputValue(e.target.value.slice(0, 32))}
                placeholder="Новое название комнаты"
                maxLength={32}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    renameRoom(renamingRoomId, renamingInputValue);
                  } else if (e.key === 'Escape') {
                    setRenamingRoomId(null);
                    setRenamingInputValue('');
                  }
                }}
              />
            </div>
            <div className="admin-modal-actions">
              <button type="button" className="secondary" onClick={() => { setRenamingRoomId(null); setRenamingInputValue(''); }}>
                Отмена
              </button>
              <button type="button" onClick={() => renameRoom(renamingRoomId, renamingInputValue)}>
                Сохранить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const DEBUG_MODE = import.meta.env.DEV || false;