/**
 * A Phosphor FILL glyph, inlined as SVG.
 *
 * payer-web renders Phosphor as `<i className="ph-fill ph-*">` against the icon webfont it
 * fetches from a CDN. This console deliberately loads no third-party icon sheet (see the UI-1
 * shell note in globals.css), so a glyph it needs is carried here as the same Phosphor path — the
 * FILL weight only, because the brand allows solid silhouettes and nothing thinner.
 *
 * Path data: Phosphor Icons v2.1.1 (`@phosphor-icons/core`, `assets/fill/<name>-fill.svg`), MIT
 * License, Copyright (c) 2023 Phosphor Icons. Add a glyph by copying its fill path verbatim.
 *
 * Decorative by contract: always `aria-hidden` and out of the tab order, so the control that
 * holds it must carry its own accessible name (as the drawer toggle's `sr-only` label does).
 * Size and colour come from CSS (`.ph-icon`: one em square in the current text colour).
 */
const PATHS = {
  list: "M208,32H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32ZM192,184H64a8,8,0,0,1,0-16H192a8,8,0,0,1,0,16Zm0-48H64a8,8,0,0,1,0-16H192a8,8,0,0,1,0,16Zm0-48H64a8,8,0,0,1,0-16H192a8,8,0,0,1,0,16Z",
} as const;

export type PhIconName = keyof typeof PATHS;

export function PhIcon({ name }: { name: PhIconName }) {
  return (
    <svg className="ph-icon" viewBox="0 0 256 256" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}
