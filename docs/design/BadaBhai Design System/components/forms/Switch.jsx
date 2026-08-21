import React from 'react';

/** Toggle switch — turns verified-green when on. For on/off settings. */
export function Switch({ label, className = '', ...rest }) {
  return (
    <label className={['bb-switch', className].filter(Boolean).join(' ')}>
      <input type="checkbox" role="switch" {...rest} />
      <span className="bb-switch__track"><span className="bb-switch__thumb" /></span>
      {label != null && <span className="bb-switch__label">{label}</span>}
    </label>
  );
}
