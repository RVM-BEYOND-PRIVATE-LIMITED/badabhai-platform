import type { ReactNode } from "react";
import { Icon } from "@badabhai/icons";

/**
 * A caveat one click away (A3, #2573): the ⓘ button beside a subtitle or a figure, and the note
 * it opens.
 *
 * A native `<details>`, so it needs no client JS and stays server-safe: the `<summary>` is a real
 * button in the tab order (Enter and Space toggle it), a screen reader announces it with its
 * `label` and its expanded state, and the note is ordinary text in the DOM once open. The note
 * fades in and scales 0.98 → 1 over --duration-fast from the ⓘ (`.infopop` in globals.css).
 */
export function InfoPopover({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="infopop">
      <summary className="infopop__toggle" aria-label={label} title={label}>
        <Icon name="info" />
      </summary>
      <div className="infopop__body" role="note">
        {children}
      </div>
    </details>
  );
}
