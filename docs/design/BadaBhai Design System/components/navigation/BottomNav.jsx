import React from 'react';

/** Worker-app bottom tab bar. Active tab is marigold with a filled icon. */
export function BottomNav({ items = [], value, onChange, className = '', ...rest }) {
  return (
    <nav className={['bb-bottomnav', className].filter(Boolean).join(' ')} {...rest}>
      {items.map((it) => {
        const active = value === it.id;
        return (
          <button
            key={it.id}
            className={`bb-bottomnav__item ${active ? 'bb-bottomnav__item--active' : ''}`}
            onClick={() => onChange && onChange(it.id)}
            aria-current={active ? 'page' : undefined}
          >
            <i className={`${active ? 'ph-fill' : 'ph'} ph-${it.icon}`} aria-hidden="true" />
            {it.badge != null && <span className="bb-bottomnav__badge">{it.badge}</span>}
            <span>{it.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
