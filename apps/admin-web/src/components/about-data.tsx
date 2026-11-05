import type { ReactNode } from "react";
import { ACTION_ICON, Icon } from "@badabhai/icons";

/**
 * The collapsed "About this data" section (A3, #2573): where a page's caveats and footnotes go so
 * the data reads first and the honest small print stays one click away.
 *
 * A native `<details>`: keyboard-operable, announced with its expanded state, and its content is
 * plain DOM text once open. It expands height + opacity over --duration-base while the chevron
 * turns 180° in the same time (`.about` in globals.css); reduced motion zeroes both.
 */
export function AboutData({
  title = "About this data",
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <details className="about">
      <summary className="about__toggle">
        <span>{title}</span>
        <Icon name={ACTION_ICON.disclosure} className="disclosure__caret about__chevron" />
      </summary>
      <div className="about__body">{children}</div>
    </details>
  );
}
