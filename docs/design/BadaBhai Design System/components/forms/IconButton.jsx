import React from 'react';

/** Square icon-only button. Always pass `label` for accessibility (worker app pairs icons with text labels elsewhere). */
export function IconButton({
  icon,
  label,
  variant = 'ghost',
  size = 'md',
  className = '',
  ...rest
}) {
  const cls = [
    'bb-iconbtn',
    variant !== 'ghost' ? `bb-iconbtn--${variant}` : '',
    size !== 'md' ? `bb-iconbtn--${size}` : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <button type="button" className={cls} aria-label={label} title={label} {...rest}>
      <i className={`ph ph-${icon}`} aria-hidden="true" />
    </button>
  );
}
