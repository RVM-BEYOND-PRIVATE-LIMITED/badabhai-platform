/**
 * Lifecycle status, rendered with a tone.
 *
 * The tone mapping is deliberately conservative: only states that are genuinely fine read
 * as "ok". Anything the operator might need to act on reads as "warn", and only terminal
 * or punitive states read as "bad". An unknown value NEVER falls through to "ok" — a
 * status this portal has not been taught about is exactly the one worth looking at, and
 * defaulting it to green would hide a new state the moment the backend adds one.
 */
export type Tone = "ok" | "warn" | "bad" | "muted";

const TONES: Record<string, Tone> = {
  // shared
  active: "ok",
  open: "ok",
  verified: "ok",
  pending: "warn",
  suspended: "bad",
  rejected: "bad",
  // postings
  draft: "muted",
  paused: "warn",
  closed: "muted",
  unverified: "warn",
  // profiles
  confirmed: "ok",
  extracted: "ok",
  extracting: "warn",
  // applications
  applied: "ok",
  skipped: "muted",
};

export function statusTone(value: string | null | undefined): Tone {
  if (!value) return "muted";
  return TONES[value.toLowerCase()] ?? "warn";
}

export function StatusPill({
  value,
  title,
}: {
  value: string | null | undefined;
  title?: string;
}) {
  if (!value) return <span className="pill pill--muted">—</span>;
  return (
    <span className={`pill pill--${statusTone(value)}`} title={title}>
      {value.replace(/_/g, " ")}
    </span>
  );
}
