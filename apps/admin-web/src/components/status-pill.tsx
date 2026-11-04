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
 * THE status label map (A1, #2571) — what an operator READS for a status value, in sentence case.
 * The console printed raw values beside curated labels, so one table said "open" and the next
 * "Closed". A value with no entry here is de-snaked and sentence-cased by `statusLabel`, so a new
 * backend state still reads like every other pill.
 */
export const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  open: "Open",
  verified: "Verified",
  pending: "Pending",
  suspended: "Suspended",
  rejected: "Rejected",
  draft: "Draft",
  paused: "Paused",
  closed: "Closed",
  unverified: "Unverified",
  confirmed: "Confirmed",
  extracted: "Extracted",
  extracting: "Extracting",
  applied: "Applied",
  skipped: "Skipped",
};

/** Upper-cases the first letter only — the rest is kept, so an acronym ("AI") survives. */
export function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The sentence-case label for a status value: the map, else the de-snaked value. */
export function statusLabel(value: string): string {
  return STATUS_LABELS[value.toLowerCase()] ?? sentenceCase(value.replace(/_/g, " "));
}

/**
 * @param label  Display text, when the raw value is not what an operator should read
 *               (e.g. `pack_purchase` → "Pack purchase"). Defaults to `statusLabel(value)`.
 *               Rendered in sentence case either way, so every pill on the console reads alike.
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
      {sentenceCase(label ?? statusLabel(value))}
    </span>
  );
}
