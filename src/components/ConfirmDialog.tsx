import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from './ui/Modal';

interface Props {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export const ConfirmDialog: React.FC<Props> = ({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onClose,
}) => (
  <Modal
    open={open}
    onClose={onClose}
    title={title}
    description={message}
    size="sm"
    labelledBy="confirm-title"
    footer={
      <>
        <button className="btn btn-ghost" onClick={onClose}>
          {cancelLabel}
        </button>
        <button
          className={`btn ${destructive ? 'btn-danger' : 'btn-primary'}`}
          onClick={onConfirm}
          data-autofocus
        >
          {destructive && <AlertTriangle size={15} />}
          {confirmLabel}
        </button>
      </>
    }
  >
    <div className={`confirm-illustration ${destructive ? 'danger' : ''}`} aria-hidden="true">
      <AlertTriangle size={22} />
    </div>
  </Modal>
);
