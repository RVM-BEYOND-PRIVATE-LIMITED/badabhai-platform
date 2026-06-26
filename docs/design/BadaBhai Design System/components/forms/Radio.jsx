import React from 'react';

/** Radio with a marigold dot. Group with a shared `name`. */
export function Radio({ label, className = '', ...rest }) {
  return (
    <label className={['bb-choice', 'bb-choice--radio', className].filter(Boolean).join(' ')}>
      <input type="radio" {...rest} />
      <span className="bb-choice__box"><span className="bb-choice__dot" aria-hidden="true" /></span>
      {label != null && <span className="bb-choice__label">{label}</span>}
    </label>
  );
}
