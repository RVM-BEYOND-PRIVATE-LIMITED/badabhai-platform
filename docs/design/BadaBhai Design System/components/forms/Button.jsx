import React from 'react';

/**
 * BadaBhai primary action button.
 * Marigold `primary` is the one CTA per screen; everything else is quieter.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  block = false,
  iconLeft,
  iconRight,
  loading = false,
  disabled = false,
  type = 'button',
  className = '',
  children,
  ...rest
}) {
  const cls = [
    'bb-btn',
    `bb-btn--${variant}`,
    size !== 'md' ? `bb-btn--${size}` : '',
    block ? 'bb-btn--block' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <button type={type} className={cls} disabled={disabled || loading} {...rest}>
      {loading && <span className="bb-btn__spinner" aria-hidden="true" />}
      {!loading && iconLeft && <i className={`ph ph-${iconLeft}`} aria-hidden="true" />}
      {children != null && <span>{children}</span>}
      {!loading && iconRight && <i className={`ph ph-${iconRight}`} aria-hidden="true" />}
    </button>
  );
}
