import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../AuthContext';
import { profile } from '../api';
import { canAccessAdminPanel } from '../api';
import Marquee from '../components/Marquee';
import { TabletBottomNav } from '../components/TabletBottomNav';
import ConfirmModal from '../components/ConfirmModal';
import {
  IconAutoTheme,
  IconHourglass,
  IconLock,
  IconLogout,
  IconMic,
  IconMoon,
  IconPencil,
  IconSun,
} from '../components/icons/Icons';
import { useSettingsChrome } from '../SettingsChromeContext';
import { applyThemePreference, getStoredThemePreference, type ThemePreference } from '../theme';

type SectionId = 'profile' | 'appearance' | 'media';

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'profile', label: 'Профиль' },
  { id: 'appearance', label: 'Оформление' },
  { id: 'media', label: 'Аудио и видео' },
];

export default function Settings() {
  const { user, refresh, logout } = useAuth();
  const { setSettingsChrome } = useSettingsChrome();
  const [activeSection, setActiveSection] = useState<SectionId>('profile');
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const [isTabletInRange, setIsTabletInRange] = useState(
    () => window.matchMedia('(min-width: 678px) and (max-width: 876px)').matches
  );
  const [confirmLogoutOpen, setConfirmLogoutOpen] = useState(false);

  const [themePref, setThemePref] = useState<ThemePreference>(() => getStoredThemePreference());

  const [passCurrent, setPassCurrent] = useState('');
  const [passNew, setPassNew] = useState('');
  const [passError, setPassError] = useState<string | null>(null);
  const [passOk, setPassOk] = useState(false);
  const [loginPassword, setLoginPassword] = useState('');
  const [loginNew, setLoginNew] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginOk, setLoginOk] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
      if (getStoredThemePreference() === 'auto') {
        applyThemePreference('auto');
      }
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 678px) and (max-width: 876px)');
    const onChange = () => setIsTabletInRange(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const selectSection = useCallback((id: SectionId) => {
    setActiveSection(id);
    setMobilePanelOpen(true);
  }, []);

  const goBackMobile = useCallback(() => {
    setMobilePanelOpen(false);
  }, []);

  const setTheme = useCallback((pref: ThemePreference) => {
    setThemePref(pref);
    applyThemePreference(pref);
  }, []);

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPassError(null);
    try {
      await profile.changePassword(passCurrent, passNew);
      setPassOk(true);
      setPassCurrent('');
      setPassNew('');
    } catch (err) {
      setPassError(err instanceof Error ? err.message : 'Ошибка');
    }
  }

  async function handleChangeLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError(null);
    try {
      await profile.changeLogin(loginPassword, loginNew);
      setLoginOk(true);
      setLoginPassword('');
      setLoginNew('');
      await refresh();
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Ошибка');
    }
  }

  const handleLogout = async () => {
    try {
      await logout();
      window.location.href = '/login';
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  const getRoleDisplayName = (role: string) => {
    switch (role) {
      case 'owner':
        return 'Владелец';
      case 'moderator':
        return 'Модератор';
      case 'member':
        return 'Участник';
      default:
        return role;
    }
  };

  const sectionTitle = SECTIONS.find((s) => s.id === activeSection)?.label ?? 'Настройки';

  useEffect(() => {
    setSettingsChrome({
      sectionTitle,
      panelOpen: mobilePanelOpen,
      onBack: goBackMobile,
    });
    return () => setSettingsChrome(null);
  }, [sectionTitle, mobilePanelOpen, goBackMobile, setSettingsChrome]);

  const pageClass = `settings-page page-content page-content--settings${mobilePanelOpen ? ' has-panel' : ''}`;
  const showAdminTab = canAccessAdminPanel(user);

  return (
    <>
    <div className={pageClass}>
      <div className="nav-sidebar">
        <div className="nav-sidebar-header">Настройки</div>
        <div className="nav-sidebar-list">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`nav-sidebar-item${activeSection === s.id ? ' active' : ''}`}
              onClick={() => selectSection(s.id)}
            >
              <span className="nav-sidebar-item-name">{s.label}</span>
            </button>
          ))}
        </div>
        {isTabletInRange && <TabletBottomNav showAdmin={!!showAdminTab} />}
      </div>

      <div className="settings-main">
        <div className="settings-main-heading-desktop">{sectionTitle}</div>
        <div className="settings-panel-inner">
          {activeSection === 'profile' && (
            <>
              <div className="card">
                <h3 className="settings-section-title">
                  <span className="icon-inline" aria-hidden>
                    <IconLogout />
                  </span>
                  Выйти из аккаунта
                </h3>
                <div className="form-gap-1">
                  <p className="muted-text settings-lead">
                    Вы вошли как{' '}
                    <strong>
                      <Marquee>{user?.login}</Marquee>
                    </strong>
                  </p>
                  <p className="muted-text settings-lead">
                    Роль:{' '}
                    <strong>
                      <span className="user-role-label">{getRoleDisplayName(user?.role || '')}</span>
                    </strong>
                  </p>
                  <button type="button" onClick={() => setConfirmLogoutOpen(true)} className="danger btn-align-start">
                    Выйти
                  </button>
                </div>
              </div>

              {!user?.verified && (
                <div className="card card--danger-left">
                  <h3 className="settings-section-title">
                    <span className="icon-inline" aria-hidden>
                      <IconHourglass />
                    </span>
                    Ожидание верификации
                  </h3>
                  <p className="muted-text settings-lead">
                    Ваш аккаунт ожидает подтверждения от владельца сервера. Как только администратор подтвердит вашу
                    учётную запись, вы получите доступ ко всем функциям.
                  </p>
                </div>
              )}

              <div className="card">
                <h3 className="settings-section-title">
                  <span className="icon-inline" aria-hidden>
                    <IconLock />
                  </span>
                  Сменить пароль
                </h3>
                <form onSubmit={handleChangePassword} className="form-stack">
                  <div>
                    <label className="form-label">Текущий пароль</label>
                    <input
                      type="password"
                      value={passCurrent}
                      onChange={(e) => setPassCurrent(e.target.value)}
                      placeholder="Введите текущий пароль"
                      required
                    />
                  </div>
                  <div>
                    <label className="form-label">Новый пароль</label>
                    <input
                      type="password"
                      value={passNew}
                      onChange={(e) => setPassNew(e.target.value)}
                      placeholder="Минимум 8 символов"
                      minLength={8}
                      maxLength={72}
                      required
                    />
                  </div>
                  {passError && <p className="error error-margin-0">{passError}</p>}
                  {passOk && <p className="text-success">Пароль изменён.</p>}
                  <button type="submit" className="btn-align-start">
                    Сохранить
                  </button>
                </form>
              </div>

              <div className="card">
                <h3 className="settings-section-title">
                  <span className="icon-inline" aria-hidden>
                    <IconPencil />
                  </span>
                  Сменить логин
                </h3>
                <form onSubmit={handleChangeLogin} className="form-stack">
                  <div>
                    <label className="form-label">Пароль</label>
                    <input
                      type="password"
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      placeholder="Подтвердите паролем"
                      required
                    />
                  </div>
                  <div>
                    <label className="form-label">Новый логин</label>
                    <input
                      type="text"
                      value={loginNew}
                      onChange={(e) => setLoginNew(e.target.value.slice(0, 32))}
                      placeholder="Минимум 2 символа"
                      minLength={2}
                      maxLength={32}
                      pattern="[a-zA-Z0-9]{2,32}"
                      title="Логин должен содержать от 2 до 32 символов, только латинские буквы и цифры"
                      required
                    />
                  </div>
                  {loginError && <p className="error error-margin-0">{loginError}</p>}
                  {loginOk && <p className="text-success">Логин изменён.</p>}
                  <button type="submit" className="btn-align-start">
                    Сохранить
                  </button>
                </form>
              </div>
            </>
          )}

          {activeSection === 'appearance' && (
            <div className="card">
              <h3 className="settings-section-title">
                <span className="icon-inline" aria-hidden>
                  <IconSun />
                </span>
                Тема оформления
              </h3>
              <p className="muted-text settings-appearance-intro">
                Выберите светлую, тёмную тему или системную (авто).
              </p>
              <div className="theme-toggle-group" role="group" aria-label="Тема">
                <button
                  type="button"
                  className={`theme-toggle-btn${themePref === 'auto' ? ' active' : ''}`}
                  onClick={() => setTheme('auto')}
                >
                  <span className="icon-inline">
                    <IconAutoTheme />
                  </span>{' '}
                  Авто
                </button>
                <button
                  type="button"
                  className={`theme-toggle-btn${themePref === 'light' ? ' active' : ''}`}
                  onClick={() => setTheme('light')}
                >
                  <span className="icon-inline">
                    <IconSun />
                  </span>{' '}
                  Светлая
                </button>
                <button
                  type="button"
                  className={`theme-toggle-btn${themePref === 'dark' ? ' active' : ''}`}
                  onClick={() => setTheme('dark')}
                >
                  <span className="icon-inline">
                    <IconMoon />
                  </span>{' '}
                  Тёмная
                </button>
              </div>
            </div>
          )}

          {activeSection === 'media' && (
            <div className="card">
              <h3 className="settings-section-title">
                <span className="icon-inline" aria-hidden>
                  <IconMic />
                </span>
                Аудио и видео
              </h3>
              <p className="av-placeholder">
                Настройки микрофона, камеры и громкости появятся здесь с выходом голосового чата.
              </p>
              <div className="form-stack settings-media-placeholder-fields">
                <div>
                  <label className="form-label">Устройство ввода (зарезервировано)</label>
                  <input type="text" disabled placeholder="По умолчанию" />
                </div>
                <div>
                  <label className="form-label">Камера (зарезервировано)</label>
                  <input type="text" disabled placeholder="По умолчанию" />
                </div>
                <div>
                  <label className="form-label">Громкость воспроизведения</label>
                  <input type="range" disabled min={0} max={100} defaultValue={80} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>

    <ConfirmModal
      isOpen={confirmLogoutOpen}
      title="Выйти из аккаунта?"
      message="Вы уверены, что хотите выйти?"
      confirmText="Выйти"
      cancelText="Отмена"
      variant="danger"
      onConfirm={handleLogout}
      onCancel={() => setConfirmLogoutOpen(false)}
    />
    </>
  );
}
