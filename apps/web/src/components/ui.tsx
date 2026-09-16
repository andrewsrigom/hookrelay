import { useEffect, useRef, type ReactNode } from 'react';
import { X, Check, Clock3, LoaderCircle, AlertCircle } from 'lucide-react';
import type { DeliveryStatus } from '../../../../packages/core/model.js';

export const statusNames: Record<DeliveryStatus, string> = {
  queued: 'Queued',
  processing: 'Sending',
  retrying: 'Retrying',
  delivered: 'Delivered',
  failed: 'Failed',
};

export function StatusBadge({ status }: { status: DeliveryStatus }) {
  const Icon =
    status === 'delivered'
      ? Check
      : status === 'failed'
        ? AlertCircle
        : status === 'processing'
          ? LoaderCircle
          : Clock3;
  return (
    <span className={`badge ${status}`}>
      <Icon size={12} aria-hidden="true" />
      {statusNames[status]}
    </span>
  );
}

export function time(value: number) {
  return new Date(value).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function dateTime(value: number) {
  return new Date(value).toLocaleString('en-US', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function shortId(id: string) {
  return `${id.slice(0, 4)}${id.slice(4, 12)}`;
}

export function Modal({
  title,
  children,
  onClose,
  wide = false,
  canClose = true,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  canClose?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => {
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      className={`modal ${wide ? 'wide' : ''}`}
      ref={dialog}
      aria-labelledby="modal-title"
      onCancel={(event) => {
        event.preventDefault();
        if (canClose) {
          onClose();
        }
      }}
      onClick={(event) => {
        if (canClose && event.target === event.currentTarget) {
          const box = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          ) {
            onClose();
          }
        }
      }}
    >
      <div className="modal-heading">
        <h2 id="modal-title">{title}</h2>
        <button className="icon-button" onClick={onClose} disabled={!canClose} aria-label="Close">
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function Empty({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
