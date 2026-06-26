import React from 'react';

/** Selectable pill — trade filters, skills, languages. Marigold when selected. */
export function Chip({
  selected = false,
  icon,
  onRemove,
  className = '',
  children,
  ...rest
}) {
  const cls = ['bb-chip', selected ? 'bb-chip--selected' : '', className]
    .filter(Boolean).join(' ');

  return (
    <button type="button" className={cls} aria-pressed={selected} {...rest}>
      {icon && <i className={`ph ph-${icon}`} aria-hidden="true" />}
      <span>{children}</span>
      {onRemove && (
        <span
          className="bb-chip__remove"
          role="button"
          aria-label="Remove"
          onClick={(e) => { e.stopPropagation(); onRemove(e); }}
        >
          <i className="ph ph-x" aria-hidden="true" />
        </span>
      )}
    </button>
  );
}
