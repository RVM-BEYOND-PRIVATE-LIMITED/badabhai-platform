import { healthTone } from "../../lib/format";

/**
 * "What needs an operator right now?" — derived from the reads the dashboard already makes.
 *
 * An operations console that opens on four counters answers "how much happened?" but never
 * "is anything wrong?", which is the only question worth asking first. This module is that
 * rule set, kept pure and separate from the page so each item is unit-testable and so it is
 * obvious that nothing is invented: every item is a statement about a value that is actually
 * in the metrics or health payload.
 *
 * An empty list is a good outcome and the band does not render. A console that always shows
 * a banner teaches its operators to stop reading banners.
 */

export type AttentionTone = "critical" | "warning" | "info";

export interface AttentionItem {
  id: string;
  tone: AttentionTone;
  title: string;
  body: string;
  href?: string;
  linkLabel?: string;
}

export interface AttentionInput {
  /** null when the metrics read failed or the operator lacks read_events. */
  metrics: { breaches: { count: number }[]; window_days: number } | null;
  /** null when the health probe is unreachable. */
  health: { environment: string; checks: Record<string, string> } | null;
  /** false when the operator has no read_events capability. */
  mayReadEvents: boolean;
  /** true when the metrics read was attempted and rejected (as opposed to not attempted). */
  metricsFailed: boolean;
  /** true when the recent-events read was attempted and rejected. */
  recentFailed: boolean;
}

export function buildAdminAttention(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];

  // 1. A dependency that is actually DOWN outranks everything else on the screen.
  const down = Object.entries(input.health?.checks ?? {})
    .filter(([, v]) => healthTone(v) === "bad")
    .map(([name]) => name.replace(/_/g, " "));
  if (down.length > 0) {
    items.push({
      id: "health-down",
      tone: "critical",
      title: `${down.length === 1 ? "A dependency is" : `${down.length} dependencies are`} down`,
      body: `${down.join(", ")} — platform paths that rely on ${down.length === 1 ? "it" : "them"} will be failing.`,
      href: "/system",
      linkLabel: "Open system",
    });
  }

  // 2. Spend/rate caps that actually tripped in the window.
  const breachTotal = (input.metrics?.breaches ?? []).reduce((sum, b) => sum + b.count, 0);
  if (breachTotal > 0) {
    items.push({
      id: "breaches",
      tone: "warning",
      title: `${breachTotal} cap ${breachTotal === 1 ? "breach" : "breaches"} in the last ${input.metrics?.window_days ?? "—"} days`,
      body: "A spend or rate ceiling was hit. Check which caps tripped before raising one.",
      href: "/events",
      linkLabel: "View events",
    });
  }

  // 3. A dependency that is UP but simulated. Not broken — but a green console that is
  //    quietly running on mocks is exactly how a staging config reaches production
  //    unnoticed, so it is stated rather than left to a reader to spot in a list.
  const mocked = Object.entries(input.health?.checks ?? {})
    .filter(([, v]) => v.toLowerCase() === "mock")
    .map(([name]) => name.replace(/_/g, " "));
  if (mocked.length > 0) {
    items.push({
      id: "health-mock",
      tone: "info",
      title: `${mocked.length} ${mocked.length === 1 ? "dependency is" : "dependencies are"} simulated`,
      body: `${mocked.join(", ")} — up, but not exercising the real provider in ${input.health?.environment ?? "this environment"}.`,
      href: "/system",
      linkLabel: "Open system",
    });
  }

  // 4. The console itself is partly blind. Distinguished from "nothing happened", which is
  //    what an empty panel would otherwise imply.
  if (input.health === null) {
    items.push({
      id: "health-unreachable",
      tone: "warning",
      title: "The health probe is unreachable",
      body: "Dependency status is unknown — this is a gap in what this page can tell you, not an all-clear.",
    });
  }
  if (input.mayReadEvents && (input.metricsFailed || input.recentFailed)) {
    items.push({
      id: "events-unreachable",
      tone: "warning",
      title: "The events spine did not answer",
      body: "Activity figures below are incomplete or missing. Retry before drawing conclusions from them.",
    });
  }

  return items;
}
