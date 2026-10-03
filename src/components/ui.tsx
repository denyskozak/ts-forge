import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
export function Mark({ small = false }: { small?: boolean }) {
  return (
    <svg
      className={small ? 'forge-mark small' : 'forge-mark'}
      viewBox="0 0 40 44"
      fill="none"
      aria-hidden="true"
    >
      <path d="M22 2 4 25h13L14 42l22-27H22l4-13h-4Z" fill="currentColor" />
      <path d="m18 24 8-9H15l-6 8h9Z" fill="#111214" opacity=".35" />
    </svg>
  );
}
export function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Button({
  children,
  onClick,
  disabled = false,
  primary = false,
  className = '',
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  className?: string;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`${primary ? 'primary' : 'button'} ${className}`}
    >
      {children}
    </button>
  );
}
export function PageHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="page-header">
      <div className="eyebrow">{eyebrow}</div>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal-header">
        <h3>{title}</h3>
        <button className="icon-button" title="Close dialog" onClick={onClose}>
          <X size={19} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
