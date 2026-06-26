import React from 'react';

/** Modal dialog (centered) or bottom sheet. Controlled via `open`. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  sheet = false,
  closeOnScrim = true,
}) {
  React.useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && onClose) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={`bb-scrim ${sheet ? 'bb-scrim--sheet' : ''}`}
      onClick={closeOnScrim ? (e) => { if (e.target === e.currentTarget && onClose) onClose(); } : undefined}
    >
      <div className={`bb-dialog ${sheet ? 'bb-dialog--sheet' : ''}`} role="dialog" aria-modal="true">
        {(title || onClose) && (
          <div className="bb-dialog__head">
            {title && <h3 className="bb-dialog__title">{title}</h3>}
            {onClose && (
              <button className="bb-iconbtn" aria-label="Close" onClick={onClose}>
                <i className="ph ph-x" aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        {children && <div className="bb-dialog__body">{children}</div>}
        {footer && <div className="bb-dialog__foot">{footer}</div>}
      </div>
    </div>
  );
}
