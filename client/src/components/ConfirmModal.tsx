import React, { useState } from 'react';

interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  variant?: 'danger' | 'warning' | 'info';
}

const ConfirmModal: React.FC<ConfirmModalProps> = ({
  isOpen,
  title,
  message,
  confirmText = 'Подтвердить',
  cancelText = 'Отмена',
  onConfirm,
  onCancel,
  variant = 'danger'
}) => {
  const [isClosing, setIsClosing] = useState(false);

  const handleClose = () => {
    if (isClosing) return;
    setIsClosing(true);
    onCancel();
    setTimeout(() => {
      setIsClosing(false);
    }, 200);
  };

  const handleConfirm = () => {
    if (isClosing) return;
    setIsClosing(true);
    onConfirm();
    setTimeout(() => {
      setIsClosing(false);
    }, 200);
  };

  if (!isOpen) return null;

  return (
    <div className={`modal-overlay ${isClosing ? 'modal-overlay-exit' : 'modal-overlay-enter'}`} onClick={handleClose}>
      <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-modal-header">
          <h3>{title}</h3>
          <button className="confirm-modal-close" onClick={handleClose}>&times;</button>
        </div>
        <div className="confirm-modal-body">
          <p>{message}</p>
        </div>
        <div className="confirm-modal-footer">
          <button className="btn btn-secondary" onClick={handleClose}>
            {cancelText}
          </button>
          <button className={`btn btn-${variant}`} onClick={handleConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmModal;
