import { useLocation } from 'react-router-dom';
import { useAuth } from '../AuthContext';

function readDecodedParam(value: string | null): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export default function AccountRejected() {
  const location = useLocation();
  const { logout } = useAuth();
  const params = new URLSearchParams(location.search);
  const message =
    readDecodedParam(params.get('message')) || 'Ваша заявка на верификацию была отклонена';

  const handleGoToLogin = () => {
    logout();
  };

  return (
    <div className="account-status-page">
      <div className="account-status-card">
        <div className="account-status-icon-wrap">
          <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="rgb(239, 68, 68)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
        </div>

        <h1 className="account-status-title">Аккаунт отклонен</h1>

        <p className="account-status-text">{message}</p>

        <div className="account-status-actions">
          <button type="button" onClick={handleGoToLogin}>
            Перейти на страницу входа
          </button>
        </div>
      </div>
    </div>
  );
}
