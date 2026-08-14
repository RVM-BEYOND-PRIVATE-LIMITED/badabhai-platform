import React from 'react';

/** Dashboard metric tile — label, big mono value, optional delta. Payer side. */
export function StatTile({
  label,
  value,
  icon,
  delta,
  deltaDir = 'up',
  className = '',
  ...rest
}) {
  const arrow = deltaDir === 'up' ? 'trend-up' : deltaDir === 'down' ? 'trend-down' : 'minus';
  return (
    <div className={['bb-stat', className].filter(Boolean).join(' ')} {...rest}>
      <div className="bb-stat__head">
        <span className="bb-stat__label">{label}</span>
        {icon && <span className="bb-stat__icon"><i className={`ph ph-${icon}`} aria-hidden="true" /></span>}
      </div>
      <div className="bb-stat__value">{value}</div>
      {delta != null && (
        <div className={`bb-stat__delta bb-stat__delta--${deltaDir}`}>
          <i className={`ph-bold ph-${arrow}`} aria-hidden="true" />{delta}
        </div>
      )}
    </div>
  );
}
