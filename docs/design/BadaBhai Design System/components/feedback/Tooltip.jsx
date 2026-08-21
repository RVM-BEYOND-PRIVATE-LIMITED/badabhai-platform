import React from 'react';

/** Hover/focus tooltip on a dark ink bubble. Wraps a single trigger element. */
export function Tooltip({ label, placement = 'top', children }) {
  return (
    <span className="bb-tooltip-wrap" tabIndex={0}>
      {children}
      <span className={`bb-tooltip bb-tooltip--${placement}`} role="tooltip">{label}</span>
    </span>
  );
}
