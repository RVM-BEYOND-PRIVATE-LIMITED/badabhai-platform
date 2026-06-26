import React from 'react';

/** Small status pill — VERIFIED, PAUSED, “2 left”, trade tags. */
export function Badge({
  tone = 'neutral',
  variant = 'soft',
  upper = false,
  icon,
  className = '',
  children,
  ...rest
}) {
  const cls = [
    'bb-badge',
    `bb-badge--${tone}`,
    variant !== 'soft' ? `bb-badge--${variant}` : '',
    upper ? 'bb-badge--upper' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <span className={cls} {...rest}>
      {icon && <i className={`ph-fill ph-${icon}`} aria-hidden="true" />}
      {children}
    </span>
  );
}
