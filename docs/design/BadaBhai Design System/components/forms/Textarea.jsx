import React from 'react';

let _id = 0;

/** Multi-line text input. Same shell as Input; vertically resizable. */
export function Textarea({
  label,
  hint,
  error,
  optional = false,
  rows = 4,
  id,
  className = '',
  ...rest
}) {
  const taId = id || `bb-textarea-${++_id}`;
  const cls = ['bb-input', 'bb-textarea', error ? 'bb-input--error' : '', className]
    .filter(Boolean).join(' ');

  return (
    <div className="bb-field">
      {label && (
        <label className="bb-field__label" htmlFor={taId}>
          {label}{optional && <span className="bb-field__opt"> · optional</span>}
        </label>
      )}
      <textarea id={taId} className={cls} rows={rows} {...rest} />
      {error ? (
        <span className="bb-field__error"><i className="ph ph-warning-circle" aria-hidden="true" />{error}</span>
      ) : hint ? (
        <span className="bb-field__hint">{hint}</span>
      ) : null}
    </div>
  );
}
