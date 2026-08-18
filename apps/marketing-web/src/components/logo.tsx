/**
 * BadaBhai brand mark + Anek wordmark — trimmed port of
 * apps/payer-web/src/components/ds/logo.tsx (mark geometry + token references
 * are byte-identical; the `theme`/`wavy` props and per-letter animation are
 * dropped — this static page never runs in the ink theme and needs no
 * client-side animation).
 *
 * Pure SVG + text, no hooks — safe in a Server Component. Colors resolve from
 * design tokens via inline `style` (no raw hex in source).
 */
export interface BadaBhaiLogoProps {
  /** @default 'full' */
  variant?: "full" | "mark" | "wordmark";
  /** Mark size in px; wordmark scales from it. @default 32 */
  size?: number;
  className?: string;
}

export function BadaBhaiLogo({ variant = "full", size = 32, className = "" }: BadaBhaiLogoProps) {
  const mark = (
    <svg viewBox="0 0 512 512" width={size} height={size} className="bb-logo__mark" aria-hidden="true">
      <rect width="512" height="512" rx="128" style={{ fill: "var(--brand)" }} />
      <path
        d="M150 124h212a40 40 0 0 1 40 40v132a40 40 0 0 1-40 40H252l-78 62a12 12 0 0 1-19.4-9.4V336h-4.6a40 40 0 0 1-40-40V164a40 40 0 0 1 40-40Z"
        style={{ fill: "var(--paper-0)" }}
      />
      <path
        d="M196 268l60-58 60 58"
        style={{ stroke: "var(--success)" }}
        strokeWidth={32}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );

  return (
    <span className={["bb-logo", className].filter(Boolean).join(" ")} role="img" aria-label="BadaBhai">
      {variant !== "wordmark" && mark}
      {variant !== "mark" && (
        <span className="bb-logo__word" style={{ fontSize: Math.round(size * 0.92) }}>
          Bada<span style={{ color: "var(--brand-press)" }}>Bhai</span>
        </span>
      )}
    </span>
  );
}
