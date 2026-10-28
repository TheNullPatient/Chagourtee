import { useState, useEffect } from 'react';
import { useAuth } from '../AuthContext';
import { profile, verification } from '../api';
import { useNavigate } from 'react-router-dom';
import { errorTranslations } from '../localization/errors';
import { IconHourglass } from '../components/icons/Icons';

export default function VerificationWaiting() {
  const { user, refresh } = useAuth();
  const [verificationCode, setVerificationCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [commentLoading, setCommentLoading] = useState(true);
  const [commentSaving, setCommentSaving] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [commentSuccess, setCommentSuccess] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let active = true;
    profile
      .getRegistrationComment()
      .then((data) => {
        if (active) setComment(data.comment ?? '');
      })
      .catch(() => {
        // The field stays empty if the comment cannot be loaded.
      })
      .finally(() => {
        if (active) setCommentLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      refresh();
    }, 10000);
    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    if (user?.verified) {
      navigate('/');
    }
  }, [user, navigate]);

  const handleUseCode = async () => {
    if (!verificationCode.trim()) {
      setError('Введите код для верификации');
      return;
    }

    setError(null);
    setSuccess(null);

    try {
      await verification.useCode(verificationCode);
      setSuccess('Верификация прошла успешно! Перенаправление...');
      await refresh();
      setTimeout(() => {
        navigate('/');
      }, 1000);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка при верификации';
      setError(errorTranslations[message] || message);
    }
  };

  const handleSaveComment = async () => {
    setCommentSaving(true);
    setCommentError(null);
    setCommentSuccess(null);
    try {
      const data = await profile.updateRegistrationComment(comment);
      setComment(data.comment ?? '');
      setCommentSuccess('Комментарий сохранён');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка сохранения';
      setCommentError(errorTranslations[message] || message);
    } finally {
      setCommentSaving(false);
    }
  };

  return (
    <div className="page-content page-content--max-800">
      <div className="verify-page-stack">
        <div className="card card-verify-danger">
          <h3 className="verify-title-danger">
            <span className="icon-inline" aria-hidden>
              <IconHourglass />
            </span>
            Ожидание верификации
          </h3>
          <p className="settings-lead muted-text">
            Ваш аккаунт ожидает подтверждения от владельца сервера. Вы можете использовать одноразовый код для
            мгновенной верификации, если он у вас есть.
          </p>

          <div className="verify-section">
            <h4>Использовать одноразовый код</h4>
            <div className="verify-code-row">
              <input
                type="text"
                value={verificationCode}
                onChange={(e) => setVerificationCode(e.target.value)}
                placeholder="Введите код верификации"
                className="verify-code-input"
              />
              <button type="button" onClick={handleUseCode} className="verify-code-btn">
                Применить код
              </button>
            </div>
            {error && <p className="error error-margin-top">{error}</p>}
            {success && <p className="success-margin-top">{success}</p>}
          </div>

          <div className="verify-section">
            <h4>Комментарий для владельца</h4>
            <p className="muted-text verify-comment-lead">
              Расскажите, кто вас пригласил и как с вами связаться. Комментарий увидит только владелец или
              модератор при рассмотрении заявки.
            </p>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value.slice(0, 500))}
              placeholder="Например: меня пригласил Alex, пишите в Telegram @alex"
              maxLength={500}
              rows={4}
              disabled={commentLoading || commentSaving}
            />
            <div className="verify-comment-footer">
              <span className="verify-comment-counter">{comment.length}/500</span>
              <button
                type="button"
                onClick={handleSaveComment}
                disabled={commentLoading || commentSaving}
                className="verify-comment-save"
              >
                {commentSaving ? 'Сохранение…' : 'Сохранить комментарий'}
              </button>
            </div>
            {commentError && <p className="error error-margin-top">{commentError}</p>}
            {commentSuccess && <p className="success-margin-top">{commentSuccess}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
