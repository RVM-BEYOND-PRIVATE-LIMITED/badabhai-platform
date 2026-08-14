import React from 'react';

/** Linear progress — resume completion, profile strength, vacancy-quota fill. */
export function ProgressBar({
  value = 0,
  label,
  showValue = false,
  tone = 'brand',
  thick = false,
  className = '',
  ...rest
}) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const cls = [
    'bb-progress',
    tone !== 'brand' ? `bb-progress--${tone}` : '',
    thick ? 'bb-progress--thick' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div className={cls} {...rest}>
      {(label || showValue) && (
        <div className="bb-progress__head">
          <span>{label}</span>
          {showValue && <span className="bb-progress__pct">{pct}%</span>}
        </div>
      )}
      <div className="bb-progress__track">
        <div
          className="bb-progress__fill"
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
    </div>
  );
}
