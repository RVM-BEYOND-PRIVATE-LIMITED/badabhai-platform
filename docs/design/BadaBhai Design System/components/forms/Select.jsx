import React from 'react';

let _id = 0;

/** Native select, restyled with a marigold focus ring and a Phosphor chevron. */
export function Select({
  label,
  hint,
  error,
  optional = false,
  id,
  className = '',
  children,
  ...rest
}) {
  const sid = id || `bb-select-${++_id}`;
  const cls = ['bb-input', 'bb-select', error ? 'bb-input--error' : '', className]
    .filter(Boolean).join(' ');

  return (
    <div className="bb-field">
      {label && (
        <label className="bb-field__label" htmlFor={sid}>
          {label}{optional && <span className="bb-field__opt"> · optional</span>}
        </label>
      )}
      <div className="bb-select-wrap">
        <select id={sid} className={cls} {...rest}>{children}</select>
        <span className="bb-select__chevron"><i className="ph ph-caret-down" aria-hidden="true" /></span>
      </div>
      {error ? (
        <span className="bb-field__error"><i className="ph ph-warning-circle" aria-hidden="true" />{error}</span>
      ) : hint ? (
        <span className="bb-field__hint">{hint}</span>
      ) : null}
    </div>
  );
}
