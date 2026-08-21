import React from 'react';

/** The BadaBhai logo — chat-lift mark + Baloo 2 wordmark. Mark SVG is inlined (no asset path). */
export function BadaBhaiLogo({
  variant = 'full',
  theme = 'paper',
  size = 32,
  className = '',
  ...rest
}) {
  const mark = (
    <svg viewBox="0 0 512 512" width={size} height={size} className="bb-logo__mark" aria-hidden="true">
      <rect width="512" height="512" rx="128" fill="#E0371C" />
      <path d="M150 124h212a40 40 0 0 1 40 40v132a40 40 0 0 1-40 40H252l-78 62a12 12 0 0 1-19.4-9.4V336h-4.6a40 40 0 0 1-40-40V164a40 40 0 0 1 40-40Z" fill="#FFFFFF" />
      <path d="M196 268l60-58 60 58" stroke="#0E7A4F" strokeWidth="32" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );

  return (
    <span
      className={['bb-logo', `bb-logo--${theme}`, className].filter(Boolean).join(' ')}
      role="img"
      aria-label="BadaBhai"
      {...rest}
    >
      {variant !== 'wordmark' && mark}
      {variant !== 'mark' && (
        <span className="bb-logo__word" style={{ fontSize: Math.round(size * 0.92) }}>
          <span className="bb-logo__a">Bada</span><span className="bb-logo__b">Bhai</span>
        </span>
      )}
    </span>
  );
}
