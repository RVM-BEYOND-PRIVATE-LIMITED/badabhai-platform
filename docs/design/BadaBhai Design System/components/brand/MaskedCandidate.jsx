import React from 'react';

/** Payer-side candidate row — masked until unlocked for ₹40. The product's core privacy motif. */
export function MaskedCandidate({
  name = 'Candidate',
  trade,
  experience,
  location,
  verified = true,
  masked = true,
  price = '₹40',
  matchLabel,
  onUnlock,
  className = '',
  ...rest
}) {
  const initials = name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  return (
    <div className={['bb-candidate', masked ? 'bb-candidate--masked' : '', className].filter(Boolean).join(' ')} {...rest}>
      <span
        className={`bb-avatar ${masked ? 'bb-avatar--masked' : 'bb-avatar--brand'}`}
        style={{ width: 52, height: 52, fontSize: 20 }}
      >
        <span className="bb-avatar__initials">{masked ? '••' : (initials || '?')}</span>
        {verified && <span className="bb-avatar__seal"><i className="ph-fill ph-seal-check" aria-hidden="true" /></span>}
      </span>

      <div className="bb-candidate__body">
        <div className="bb-candidate__name">
          <span className="bb-candidate__name-text">{masked ? 'Ramesh K.' : name}</span>
          {verified && <i className="ph-fill ph-seal-check" style={{ color: 'var(--success)', fontSize: 16 }} aria-label="Verified" />}
        </div>
        <div className="bb-candidate__meta">
          {trade && <span><i className="ph ph-wrench" aria-hidden="true" />{trade}</span>}
          {experience && <span><i className="ph ph-medal" aria-hidden="true" />{experience}</span>}
          {location && <span><i className="ph ph-map-pin" aria-hidden="true" />{location}</span>}
        </div>
      </div>

      <div className="bb-candidate__action">
        {matchLabel && <span className="bb-badge bb-badge--success">{matchLabel}</span>}
        {masked ? (
          <button className="bb-btn bb-btn--primary" onClick={onUnlock}>
            <i className="ph ph-lock-key-open" aria-hidden="true" /><span>{price}</span>
          </button>
        ) : (
          <span className="bb-candidate__unlocked"><i className="ph-fill ph-lock-key-open" aria-hidden="true" />Unlocked</span>
        )}
      </div>
    </div>
  );
}
