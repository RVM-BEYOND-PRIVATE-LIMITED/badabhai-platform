import React from 'react';

/** Worker avatar with initials fallback, optional blur mask and a verified seal. */
export function Avatar({
  src,
  name = '',
  size = 44,
  masked = false,
  verified = false,
  brand = false,
  className = '',
  ...rest
}) {
  const initials = name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const cls = [
    'bb-avatar',
    masked ? 'bb-avatar--masked' : '',
    brand ? 'bb-avatar--brand' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <span className={cls} style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }} {...rest}>
      {src
        ? <img className="bb-avatar__img" src={src} alt={name} />
        : <span className="bb-avatar__initials">{initials || '?'}</span>}
      {verified && (
        <span className="bb-avatar__seal"><i className="ph-fill ph-seal-check" aria-hidden="true" /></span>
      )}
    </span>
  );
}
