import React from 'react';

/** Controlled OTP entry — N single-digit cells with auto-advance and backspace nav. */
export function OtpInput({ length = 4, value = '', onChange, autoFocus = false }) {
  const refs = React.useRef([]);
  const chars = Array.from({ length }, (_, i) => value[i] || '');

  const setChar = (i, c) => {
    const next = chars.slice();
    next[i] = c;
    onChange && onChange(next.join(''));
  };

  const handleChange = (i, e) => {
    const v = e.target.value.replace(/\D/g, '');
    if (!v) { setChar(i, ''); return; }
    setChar(i, v[v.length - 1]);
    if (i < length - 1 && refs.current[i + 1]) refs.current[i + 1].focus();
  };

  const handleKey = (i, e) => {
    if (e.key === 'Backspace' && !chars[i] && i > 0) refs.current[i - 1].focus();
  };

  return (
    <div className="bb-otp" role="group" aria-label="One-time passcode">
      {chars.map((c, i) => (
        <input
          key={i}
          ref={(el) => (refs.current[i] = el)}
          className={`bb-otp__cell ${c ? 'bb-otp__cell--filled' : ''}`}
          inputMode="numeric"
          maxLength={1}
          value={c}
          autoFocus={autoFocus && i === 0}
          onChange={(e) => handleChange(i, e)}
          onKeyDown={(e) => handleKey(i, e)}
        />
      ))}
    </div>
  );
}
