import { Outlet, NavLink, useLocation, useParams, Link } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { useState, useEffect } from 'react';
import { rooms as roomsApi } from './api';
import { useServerName } from './ServerNameContext';
import Marquee from './components/Marquee';
import { useUserListPanel } from './UserListPanelContext';
import logoImage from './assets/Images/Chagourtee_512px.png';
import VersionModal from './components/VersionModal';
import DisconnectionBanner from './components/DisconnectionBanner';
import { IconAdmin, IconArrowLeft, IconChat, IconLock, IconSettings, IconUsers } from './components/icons/Icons';
import { SettingsChromeProvider, useSettingsChrome } from './SettingsChromeContext';
import { AdminChromeProvider, useAdminChrome } from './AdminChromeContext';
import { ChatChromeProvider, useChatChrome } from './ChatChromeContext';

function LayoutInner() {
  const { user } = useAuth();
  const location = useLocation();
  const params = useParams();
  const [loadedRoom, setLoadedRoom] = useState<{ id: number; name: string | null } | null>(null);
  const { displayName, serverTagline } = useServerName();
  const { isOpen: isUserListOpen, open: openUserList } = useUserListPanel();
  const { chrome: settingsChrome } = useSettingsChrome();
  const { chrome: adminChrome } = useAdminChrome();
  const { lockAction } = useChatChrome();

  const [isMobile, setIsMobile] = useState(window.innerWidth <= 678);
  const [isTabletInRange, setIsTabletInRange] = useState(window.innerWidth >= 678 && window.innerWidth <= 876);
  const [isVersionModalOpen, setIsVersionModalOpen] = useState(false);

  const isInSpecificRoom = location.pathname.startsWith('/chat/') && params.roomId;
  const roomId = params.roomId ? Number(params.roomId) : null;

  useEffect(() => {
    const handleResize = () => {
      const width = window.innerWidth;
      setIsMobile(width <= 678);
      setIsTabletInRange(width >= 678 && width <= 876);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  useEffect(() => {
    if (!roomId) return;

    let cancelled = false;
    roomsApi
      .list()
      .then(({ rooms }) => {
        if (cancelled) return;
        const room = rooms.find((r) => r.id === roomId);
        setLoadedRoom({ id: roomId, name: room?.name || null });
      })
      .catch(() => {
        if (!cancelled) setLoadedRoom({ id: roomId, name: null });
      });

    return () => {
      cancelled = true;
    };
  }, [roomId]);

  const roomName = loadedRoom && loadedRoom.id === roomId ? loadedRoom.name : null;

  const getPageTitle = () => {
    if (location.pathname === '/settings' && settingsChrome) {
      return isMobile && !settingsChrome.panelOpen ? 'Настройки' : settingsChrome.sectionTitle;
    }
    if (location.pathname === '/admin' && adminChrome) {
      return isMobile && !adminChrome.panelOpen ? 'Админка' : adminChrome.sectionTitle;
    }
    if (location.pathname === '/chat') {
      return isMobile ? 'Комнаты' : '';
    }
    if (location.pathname.startsWith('/chat/')) {
      if (params.roomId && roomName) return roomName;
      return 'Чат';
    }
    if (location.pathname === '/settings') return 'Настройки';
    if (location.pathname === '/admin') return 'Админка';
    return 'Chagourtee';
  };

  const showBackButton = location.pathname.startsWith('/chat/') && params.roomId;
  const showSettingsBack = location.pathname === '/settings' && isMobile && settingsChrome?.panelOpen;
  const showAdminBack = location.pathname === '/admin' && isMobile && adminChrome?.panelOpen;

  const hideLayoutBottomNav =
    (location.pathname.startsWith('/chat') && isTabletInRange) ||
    (location.pathname.startsWith('/chat') && !isMobile) ||
    (isTabletInRange &&
      (location.pathname.startsWith('/settings') || location.pathname.startsWith('/admin'))) ||
    (isMobile && isInSpecificRoom) ||
    (isMobile && location.pathname === '/settings' && settingsChrome?.panelOpen) ||
    (isMobile && location.pathname === '/admin' && adminChrome?.panelOpen);

  const compactMobileHeader =
    isMobile &&
    (isInSpecificRoom ||
      (location.pathname === '/settings' && settingsChrome?.panelOpen) ||
      (location.pathname === '/admin' && adminChrome?.panelOpen));

  return (
    <div className="layout-root">
      <nav className="layout-header-top">
        {showSettingsBack && (
          <a
            href="#"
            className="chat-back touch-target chat-back-link"
            onClick={(e) => { e.preventDefault(); settingsChrome?.onBack(); }}
            aria-label="Назад к разделам настроек"
          >
            <span className="icon-inline" aria-hidden>
              <IconArrowLeft />
            </span>
          </a>
        )}
        {showAdminBack && (
          <a
            href="#"
            className="chat-back touch-target chat-back-link"
            onClick={(e) => { e.preventDefault(); adminChrome?.onBack(); }}
            aria-label="Назад к разделам админки"
          >
            <span className="icon-inline" aria-hidden>
              <IconArrowLeft />
            </span>
          </a>
        )}
        {showBackButton && !showSettingsBack && !showAdminBack && (
          <Link to="/chat" className="chat-back touch-target chat-back-link" aria-label="Назад к списку комнат">
            <span className="icon-inline" aria-hidden>
              <IconArrowLeft />
            </span>
          </Link>
        )}
        <div className="layout-header-inner">
          <span>
            <Marquee>{getPageTitle()}</Marquee>
          </span>
          {!compactMobileHeader ? (
            <div className="layout-header-meta-row">
              <span className="layout-header-meta-text">
                <Marquee animationDuration={15}>{displayName}</Marquee>
              </span>
              <span
                className="layout-header-meta-text layout-header-meta-text--clickable"
                onClick={() => setIsVersionModalOpen(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setIsVersionModalOpen(true);
                  }
                }}
                role="button"
                tabIndex={0}
                title="Информация о приложении"
              >
                {serverTagline}
              </span>
            </div>
          ) : (
            <div />
          )}
        </div>
        {!compactMobileHeader ? (
          <div
            className="layout-header-logo-wrap"
            onClick={() => setIsVersionModalOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setIsVersionModalOpen(true);
              }
            }}
            role="button"
            tabIndex={0}
            title="Информация о приложении"
          >
            <img src={logoImage} alt="Chagourtee" className="layout-header-logo" />
          </div>
        ) : null}
        {location.pathname.startsWith('/chat/') && lockAction && (
          <button
            type="button"
            className="layout-lock-button secondary"
            onClick={lockAction.onLock}
            title={lockAction.title}
            aria-label={lockAction.title}
            disabled={lockAction.busy}
          >
            <span className="icon-inline">
              <IconLock />
            </span>
          </button>
        )}
        {location.pathname.startsWith('/chat/') && (
          <button
            type="button"
            className="layout-users-button secondary"
            onClick={() => {
              if (!isUserListOpen) {
                openUserList();
              }
            }}
            aria-label="Список пользователей"
          >
            <span className="icon-inline">
              <IconUsers />
            </span>
          </button>
        )}
      </nav>
      <aside className="layout-sidebar">
        <nav className="layout-sidebar-nav">
          <NavLink to="/chat" end className={({ isActive }) => `layout-nav-link${isActive ? ' active' : ''}`}>
            <span className="icon-inline">
              <IconChat />
            </span>
            Чаты
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `layout-nav-link${isActive ? ' active' : ''}`}>
            <span className="icon-inline">
              <IconSettings />
            </span>
            Настройки
          </NavLink>
          {(user?.role === 'owner' || user?.role === 'moderator') && (
            <NavLink to="/admin" className={({ isActive }) => `layout-nav-link${isActive ? ' active' : ''}`}>
              <span className="icon-inline">
                <IconAdmin />
              </span>
              Админка
            </NavLink>
          )}
        </nav>
        <div className="layout-sidebar-footer">
          <div className="layout-sidebar-user">
            <Marquee animationDuration={10}>{user?.login}</Marquee>
          </div>
          {!user?.verified && <div className="layout-sidebar-pending">Ожидает верификации</div>}
          <div className="layout-sidebar-meta">
            <Marquee>{displayName}</Marquee>
          </div>
          <div className="layout-sidebar-tagline">{serverTagline}</div>
        </div>

        <div
          className="layout-sidebar-logo-block"
          onClick={() => setIsVersionModalOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setIsVersionModalOpen(true);
            }
          }}
          role="button"
          tabIndex={0}
        >
          <img src={logoImage} alt="Chagourtee" className="layout-sidebar-logo" />
        </div>
      </aside>
      <main className="layout-main">
        <Outlet />
      </main>
      {hideLayoutBottomNav ? null : (
        <nav className="layout-nav-bottom">
          <NavLink to="/chat" end className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="icon-inline">
              <IconChat />
            </span>
            Чаты
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="icon-inline">
              <IconSettings />
            </span>
            Настройки
          </NavLink>
          {(user?.role === 'owner' || user?.role === 'moderator') && (
            <NavLink to="/admin" className={({ isActive }) => (isActive ? 'active' : '')}>
              <span className="icon-inline">
                <IconAdmin />
              </span>
              Админка
            </NavLink>
          )}
        </nav>
      )}

      <VersionModal isOpen={isVersionModalOpen} onClose={() => setIsVersionModalOpen(false)} />
    </div>
  );
}

export default function Layout() {
  return (
    <div className="layout-root-with-banner">
      <DisconnectionBanner />
      <SettingsChromeProvider>
        <AdminChromeProvider>
          <ChatChromeProvider>
            <LayoutInner />
          </ChatChromeProvider>
        </AdminChromeProvider>
      </SettingsChromeProvider>
    </div>
  );
}
