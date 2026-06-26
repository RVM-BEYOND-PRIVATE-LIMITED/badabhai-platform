import React from 'react';

const DEFAULT_ICON = { success: 'check-circle', danger: 'warning-circle', brand: 'sparkle', neutral: 'info' };

/** Toast notification on a dark ink surface. Present in a stack at a screen corner. */
export function Toast({
  tone = 'neutral',
  icon,
  title,
  children,
  onClose,
  className = '',
  ...rest
}) {
  const cls = ['bb-toast', tone !== 'neutral' ? `bb-toast--${tone}` : '', className]
    .filter(Boolean).join(' ');

  return (
    <div className={cls} role="status" {...rest}>
      <i className={`ph-fill ph-${icon || DEFAULT_ICON[tone]} bb-toast__icon`} aria-hidden="true" />
      <div className="bb-toast__content">
        {title && <div className="bb-toast__title">{title}</div>}
        {children && <div className="bb-toast__msg">{children}</div>}
      </div>
      {onClose && (
        <button className="bb-toast__close" aria-label="Dismiss" onClick={onClose}>
          <i className="ph ph-x" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
