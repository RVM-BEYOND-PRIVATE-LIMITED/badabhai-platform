import React from 'react';

/** Checkbox with a marigold fill and a Phosphor check on select. */
export function Checkbox({ label, className = '', ...rest }) {
  return (
    <label className={['bb-choice', 'bb-choice--checkbox', className].filter(Boolean).join(' ')}>
      <input type="checkbox" {...rest} />
      <span className="bb-choice__box"><i className="ph-bold ph-check" aria-hidden="true" /></span>
      {label != null && <span className="bb-choice__label">{label}</span>}
    </label>
  );
}
