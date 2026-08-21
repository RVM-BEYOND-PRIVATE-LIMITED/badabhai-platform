import React from 'react';

/** Tab bar — underline (page sections) or segmented (filters / role views). */
export function Tabs({
  tabs = [],
  value,
  onChange,
  variant = 'underline',
  className = '',
  ...rest
}) {
  const cls = ['bb-tabs', `bb-tabs--${variant}`, className].filter(Boolean).join(' ');

  return (
    <div className={cls} role="tablist" {...rest}>
      {tabs.map((t) => {
        const active = value === t.id;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            className={`bb-tab ${active ? 'bb-tab--active' : ''}`}
            onClick={() => onChange && onChange(t.id)}
          >
            {t.icon && <i className={`${active ? 'ph-fill' : 'ph'} ph-${t.icon}`} aria-hidden="true" />}
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
