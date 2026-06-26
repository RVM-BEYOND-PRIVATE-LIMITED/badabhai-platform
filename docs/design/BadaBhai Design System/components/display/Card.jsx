import React from 'react';

/** Surface container — the warm white card on paper that holds most content. */
export function Card({
  variant = 'default',
  padding = 'md',
  interactive = false,
  as: Tag = 'div',
  className = '',
  children,
  ...rest
}) {
  const cls = [
    'bb-card',
    variant !== 'default' ? `bb-card--${variant}` : '',
    padding !== 'md' ? `bb-card--pad-${padding}` : '',
    interactive ? 'bb-card--interactive' : '',
    className,
  ].filter(Boolean).join(' ');

  return <Tag className={cls} {...rest}>{children}</Tag>;
}
