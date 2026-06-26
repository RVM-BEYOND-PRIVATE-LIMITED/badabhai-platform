import React from 'react';
import { BadaBhaiLogo } from './BadaBhaiLogo.jsx';

const WAVE = [10, 16, 8, 20, 12, 18, 7, 22, 9, 15, 11, 17, 8];

/** A single chat message — the heart of the chat-first worker app. Bot = bada bhai. */
export function ChatBubble({
  from = 'bot',
  children,
  time,
  voice = false,
  duration = '0:12',
  showAvatar = true,
  className = '',
}) {
  const isUser = from === 'user';
  return (
    <div className={`bb-chat bb-chat--${isUser ? 'user' : 'bot'} ${className}`.trim()}>
      {!isUser && showAvatar && (
        <span className="bb-chat__avatar"><BadaBhaiLogo variant="mark" size={28} /></span>
      )}
      <div>
        <div className="bb-chat__bubble">
          {voice ? (
            <div className="bb-chat__voice">
              <span className="bb-chat__play"><i className="ph-fill ph-play" aria-hidden="true" /></span>
              <span className="bb-chat__wave">
                {WAVE.map((h, i) => <i key={i} style={{ height: h }} />)}
              </span>
              <span className="bb-chat__dur">{duration}</span>
            </div>
          ) : children}
        </div>
        {time && <span className="bb-chat__time">{time}</span>}
      </div>
    </div>
  );
}
