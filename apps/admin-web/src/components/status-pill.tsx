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

/**
 * @param label  Display text, when the raw value is not what an operator should read
 *               (e.g. `pack_purchase` → "Pack purchase"). Defaults to the de-snaked value.
 * @param tone   Explicit tone, for domains this component's map does not cover.
 *
 * ── WHY `tone` EXISTS ───────────────────────────────────────────────────────────────────
 * The map keys off the VALUE, so borrowing a tone by passing a different domain's value
 * also changes the text. That is not hypothetical: the credits ledger shipped rendering
 * `<StatusPill value={reason === "unlock_debit" ? "skipped" : "applied"} />`, so every
 * credit movement — including an ops grant — displayed a pill reading **"applied"**, a word
 * from the job-applications domain that means nothing on a finance screen.
 *
 * Passing a tone directly is the fix: the text always stays the real value.
 */
export function StatusPill({
  value,
  title,
  label,
  tone,
}: {
  value: string | null | undefined;
  title?: string;
  label?: string;
  tone?: Tone;
}) {
  if (!value) return <span className="pill pill--muted">—</span>;
  return (
    <span className={`pill pill--${tone ?? statusTone(value)}`} title={title}>
      {label ?? value.replace(/_/g, " ")}
    </span>
  );
}
