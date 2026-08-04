/**
 * Display formatting. Pure, so it is testable without a DOM.
 *
 * Everything here is about being HONEST at a glance on an operations console: a
 * timestamp an operator can correlate with a log, an id they can copy, and — most
 * importantly — a suppressed statistic that reads as suppressed rather than as zero.
 */

/** Absolute UTC, second precision. Operators correlate these with server logs. */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

/**
 * "3m ago". Relative time is the scanning aid; the absolute value stays in a `title`
 * so nothing is ever ONLY relative — "2 days ago" is useless in an incident review.
 */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const secs = Math.round((now - t) / 1000);
  if (secs < 0) return "just now"; // clock skew — never render "in -3s"
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatTimestamp(iso).slice(0, 10);
}

/**
 * Shorten an opaque id for a dense table. The full value always stays in `title` and in
 * the copy affordance — a truncated id that cannot be recovered is worse than none.
 */
export function shortId(id: string | null, chars = 8): string {
  if (!id) return "—";
  return id.length <= chars ? id : `${id.slice(0, chars)}…`;
}

/** `worker.profile_confirmed` → `Worker · profile confirmed`. */
export function humanizeEventName(name: string): string {
  const [domain, ...rest] = name.split(".");
  const action = rest.join(".").replace(/_/g, " ");
  const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
  return action ? `${cap(domain ?? "")} · ${action}` : cap(name);
}

/** Thousands separators. Counts only — never money (₹ has its own rules). */
export function formatCount(n: number): string {
  return new Intl.NumberFormat("en-IN").format(n);
}

/**
 * Render a k-anonymity-floored statistic.
 *
 * The server sets `suppressed` and floors the value to 0 when fewer than `k` distinct
 * subjects reached a stage. Printing that 0 would state "nobody did this" when the truth
 * is "too few did this to report safely" — a different claim, and a false one. So the
 * suppressed case returns a marker the UI renders as text, never as a number.
 */
export function formatSuppressible(
  value: number,
  suppressed: boolean,
  floor: number,
): { text: string; isSuppressed: boolean; hint?: string } {
  if (suppressed) {
    return {
      text: `< ${floor}`,
      isSuppressed: true,
      hint: `Fewer than ${floor} distinct subjects — withheld to protect individuals.`,
    };
  }
  return { text: formatCount(value), isSuppressed: false };
}

/** Map a health check value to a severity the UI can colour. */
export function healthTone(value: string): "ok" | "warn" | "bad" {
  const v = value.toLowerCase();
  if (v === "up" || v === "ok" || v === "real") return "ok";
  if (v === "down" || v === "error" || v === "fail") return "bad";
  // `mock`, `degraded`, `unknown` — not broken, but not the real thing either, and
  // saying so plainly is the entire point of TD81.
  return "warn";
}
