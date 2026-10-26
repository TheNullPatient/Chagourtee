import React, { useState } from 'react';

interface InfoModalProps {
  isOpen: boolean;
  title: string;
  message: string | React.ReactNode;
  onClose: () => void;
  closeText?: string;
}

const InfoModal: React.FC<InfoModalProps> = ({
  isOpen,
  title,
  message,
  onClose,
  closeText = 'Закрыть'
}) => {
  const [isClosing, setIsClosing] = useState(false);

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(() => {
      setIsClosing(false);
      onClose();
    }, 200);
  };

  if (!isOpen) return null;

  return (
    <div className={`modal-overlay ${isClosing ? 'modal-overlay-exit' : 'modal-overlay-enter'}`} onClick={handleClose}>
      <div className="info-modal" onClick={(e) => e.stopPropagation()}>
        <div className="info-modal-header">
          <h3>{title}</h3>
          <button className="info-modal-close" onClick={handleClose}>&times;</button>
        </div>
        <div className="info-modal-body">
          {typeof message === 'string' ? <p>{message}</p> : message}
        </div>
        <div className="info-modal-footer">
          <button className="btn btn-secondary" onClick={handleClose}>
            {closeText}
          </button>
        </div>
      </div>
    </div>
  );
};

export default InfoModal;
