import { useNavigate } from 'react-router-dom';
import logoImage from '../assets/Images/Chagourtee_512px.png';
import { helpLinks } from '../constants/help';
import { IconAlertTriangle } from '../components/icons/Icons';
import { clearRedirectFlag, consumeConnectionError } from '../api';

export type ConnectionErrorReason = 'network_unreachable' | 'server_unavailable' | 'timeout' | 'api_error' | 'websocket_error';

export default function ConnectionError() {
  const navigate = useNavigate();
  const { reason, details: errorDetails } = consumeConnectionError();

  const handleRetry = () => {
    clearRedirectFlag();
    window.location.href = '/';
  };

  const handleGoLogin = () => {
    navigate('/login');
  };

  const getTitle = () => {
    switch (reason) {
      case 'network_unreachable':
        return 'Нет соединения с сервером';
      case 'server_unavailable':
        return 'Сервер недоступен';
      case 'timeout':
        return 'Превышено время ожидания';
      case 'websocket_error':
        return 'Ошибка подключения WebSocket';
      default:
        return 'Ошибка подключения';
    }
  };

  const getMessage = () => {
    switch (reason) {
      case 'network_unreachable':
        return 'Не удалось установить соединение с сервером Chagourtee. Проверьте подключение к сети и убедитесь, что сервер запущен.';
      case 'server_unavailable':
        return 'Сервер Chagourtee не отвечает. Возможно, он временно недоступен или был остановлен.';
      case 'timeout':
        return 'Сервер не ответил в течение ожидаемого времени. Попробуйте повторить запрос позже.';
      case 'websocket_error':
        return 'Не удалось установить WebSocket-соединение, необходимое для работы чата.';
      default:
        return 'Произошла ошибка при попытке подключиться к серверу.';
    }
  };

  return (
    <div className="full-page-error">
      <div className="full-page-error-inner">
        <div className="full-page-error-card">
          <img src={logoImage} alt="" className="full-page-error-logo" />
          <div className="icon-inline full-page-error-icon full-page-error-icon--danger">
            <IconAlertTriangle title="Ошибка подключения" />
          </div>
          <h1 className="full-page-error-title">{getTitle()}</h1>
          <p className="full-page-error-text">
            {getMessage()}
          </p>

          {errorDetails && (
            <div className="error-500-details">
              <p className="error-500-details-title">Детали ошибки:</p>
              <p className="error-500-details-row">
                <strong>Тип ошибки:</strong> {reason || 'неизвестно'}
              </p>
              <p className="error-500-details-row">
                <strong>Описание:</strong> {errorDetails}
              </p>
              <p className="error-500-details-foot">Эти данные будут автоматически удалены после закрытия этой страницы.</p>
            </div>
          )}

          <div className="error-500-help">
            <h3>Что можно сделать?</h3>
            <ul>
              <li>Проверьте подключение к интернету</li>
              <li>Убедитесь, что сервер Chagourtee запущен</li>
              <li>Попробуйте обновить страницу через несколько секунд</li>
              <li>Если проблема повторяется, сообщите администратору сервера</li>
            </ul>
          </div>

          <div className="full-page-error-actions">
            <button type="button" onClick={handleRetry}>
              Попробовать снова
            </button>
            <button type="button" className="secondary" onClick={handleGoLogin}>
              На страницу входа
            </button>
          </div>
          <div className="help-links muted-text">
            <a href={helpLinks.docs} target="_blank" rel="noreferrer">
              Документация
            </a>
            ·
            <a href={helpLinks.issues} target="_blank" rel="noreferrer">
              Сообщить о проблеме
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
