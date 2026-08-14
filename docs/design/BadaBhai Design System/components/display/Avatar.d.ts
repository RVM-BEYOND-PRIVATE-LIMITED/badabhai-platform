import * as React from 'react';

export interface AvatarProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Image URL; falls back to initials from `name`. */
  src?: string;
  /** Full name — drives the initials fallback and alt text. */
  name?: string;
  /** Pixel diameter. @default 44 */
  size?: number;
  /** Blur the photo (locked / pre-unlock candidate). */
  masked?: boolean;
  /** Show the verified seal overlay. */
  verified?: boolean;
  /** Use the marigold gradient placeholder instead of grey. */
  brand?: boolean;
}

/** Circular worker avatar — supports the masked (blurred) and verified states. */
export declare function Avatar(props: AvatarProps): JSX.Element;
