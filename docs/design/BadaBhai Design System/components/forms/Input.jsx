import React from 'react';

let _id = 0;

/** Text input with label, hint/error, and optional leading/trailing Phosphor icons. */
export function Input({
  label,
  hint,
  error,
  iconLeft,
  iconRight,
  optional = false,
  id,
  className = '',
  ...rest
}) {
  const inputId = id || `bb-input-${++_id}`;
  const cls = [
    'bb-input',
    iconLeft ? 'bb-input--has-left' : '',
    iconRight ? 'bb-input--has-right' : '',
    error ? 'bb-input--error' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div className="bb-field">
      {label && (
        <label className="bb-field__label" htmlFor={inputId}>
          {label}{optional && <span className="bb-field__opt"> · optional</span>}
        </label>
      )}
      <div className="bb-input-wrap">
        {iconLeft && (
          <span className="bb-input__icon bb-input__icon--left">
            <i className={`ph ph-${iconLeft}`} aria-hidden="true" />
          </span>
        )}
        <input id={inputId} className={cls} {...rest} />
        {iconRight && (
          <span className="bb-input__icon bb-input__icon--right">
            <i className={`ph ph-${iconRight}`} aria-hidden="true" />
          </span>
        )}
      </div>
      {error ? (
        <span className="bb-field__error"><i className="ph ph-warning-circle" aria-hidden="true" />{error}</span>
      ) : hint ? (
        <span className="bb-field__hint">{hint}</span>
      ) : null}
    </div>
  );
}
