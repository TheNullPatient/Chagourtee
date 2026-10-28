import { useState, useEffect } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { auth, verification } from '../api';
import { useAuth } from '../AuthContext';
import { useServerName } from '../ServerNameContext';
import { errorTranslations } from '../localization/errors';
import logoImage from '../assets/Images/Chagourtee_512px.png';
import Marquee from '../components/Marquee';

export default function Register() {
  const [searchParams] = useSearchParams();
  const inviteId = searchParams.get('invite') ?? '';
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [verificationEnabled, setVerificationEnabled] = useState(false);
  const { setUser, refresh } = useAuth();
  const navigate = useNavigate();
  const { displayName } = useServerName();

  useEffect(() => {
    verification
      .status()
      .then((data) => setVerificationEnabled(!!data.enabled))
      .catch((err) => console.error('Failed to load verification settings:', err));

    if (!inviteId) setError('Укажите инвайт в ссылке (например: /register?invite=xxx)');
  }, [inviteId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteId) return;
    setError(null);
    setLoading(true);
    try {
      const { user } = await auth.register({
        inviteId,
        login: login.trim(),
        password,
        comment: comment.trim() || undefined,
      });
      setUser(user);
      await refresh();
      // Unverified users are redirected to the verification waiting screen
      // by the route guard on /chat.
      navigate('/', { replace: true });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Ошибка регистрации';
      const translatedError = errorTranslations[errorMessage] || errorMessage;
      setError(translatedError);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page-outer">
      <div className="auth-page-inner">
        <div className="auth-card">
          <div className="auth-logo-wrap">
            <img src={logoImage} alt="Chagourtee" className="auth-logo auth-logo--large" />
          </div>

          <h1 className="auth-title auth-register-title">Регистрация</h1>
          <p className="auth-subtitle">
            Создайте аккаунт на <Marquee animationDuration={15}>{displayName}</Marquee>
          </p>
          <form onSubmit={handleSubmit} className="form-stack">
            <div>
              <label className="form-label">Логин</label>
              <input
                type="text"
                value={login}
                onChange={(e) => setLogin(e.target.value.slice(0, 32))}
                autoComplete="username"
                minLength={2}
                maxLength={32}
                pattern="[a-zA-Z0-9]{2,32}"
                title="Логин должен содержать от 2 до 32 символов, только латинские буквы и цифры"
                placeholder="Минимум 2 символа"
                required
              />
            </div>
            <div>
              <label className="form-label">Пароль</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                minLength={6}
                placeholder="Минимум 6 символов"
                required
              />
            </div>
            {verificationEnabled && (
              <div>
                <label className="form-label">Комментарий для владельца</label>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value.slice(0, 500))}
                  placeholder="Например: кто вас пригласил и как с вами связаться"
                  maxLength={500}
                  rows={3}
                />
                <p className="register-comment-hint">
                  Необязательно. Владелец увидит комментарий при рассмотрении заявки.
                  <span className="register-comment-counter">{comment.length}/500</span>
                </p>
              </div>
            )}
            {error && <p className="error error-margin-0">{error}</p>}
            <button type="submit" disabled={loading || !inviteId} className="btn-block-mt">
              {loading ? 'Регистрация…' : 'Зарегистрироваться'}
            </button>
          </form>
          <p className="auth-footer">
            Уже есть аккаунт? <Link to="/login">Войти</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
