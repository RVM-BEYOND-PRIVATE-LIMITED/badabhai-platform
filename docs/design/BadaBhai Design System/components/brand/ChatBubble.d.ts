import * as React from 'react';

export interface ChatBubbleProps {
  /** Who is speaking. `bot` = bada bhai (left), `user` = worker (right). @default 'bot' */
  from?: 'bot' | 'user';
  /** Message text (ignored when `voice`). */
  children?: React.ReactNode;
  /** Timestamp under the bubble. */
  time?: string;
  /** Render as an async voice note (≤2 min) instead of text. */
  voice?: boolean;
  /** Voice-note duration label. @default '0:12' */
  duration?: string;
  /** Show the bada-bhai mark on bot messages. @default true */
  showAvatar?: boolean;
}

/**
 * Chat message bubble — the first screen of the worker app is a chat window.
 * @startingPoint section="Brand" subtitle="Chat-first message bubbles" viewport="440x360"
 */
export declare function ChatBubble(props: ChatBubbleProps): JSX.Element;
