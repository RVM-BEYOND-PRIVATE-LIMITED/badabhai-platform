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
  /**
   * null when the metrics read failed or the operator lacks read_events.
   *
   * `by_event_name` is the COMPLETE set of event names in the window — the server groups by
   * name with no limit and no k-anonymity floor (the floor applies to the funnel's distinct
   * subjects, not to these raw counts). That is what makes an ABSENT key readable as zero
   * rather than as "not in the top N", which is the only reason a rule below may reason from
   * one not being there.
   */
  metrics: {
    breaches: { count: number }[];
    by_event_name: { key: string; count: number }[];
    window_days: number;
  } | null;
  /** null when the health probe is unreachable. */
  health: { environment: string; checks: Record<string, string> } | null;
  /** false when the operator has no read_events capability. */
  mayReadEvents: boolean;
  /** false when the operator has no read_entities capability — i.e. cannot open /feedback. */
  mayReadEntities: boolean;
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

  /**
   * 5. WORKERS WROTE IN AND NOBODY WENT TO LOOK.
   *
   * The Feedback screen is the only place a worker can say anything to us in their own words,
   * and nothing on this console ever mentioned it — an operator had to remember it existed.
   * Messages therefore sat unread for exactly as long as nobody thought of them.
   *
   * ── WHY THIS NUMBER IS REAL, AND WHY IT IS THE ONLY ONE ON OFFER ────────────────────────
   * Both figures come out of `by_event_name`, which the dashboard already fetches; no read is
   * added for this item. `feedback.submitted` is emitted inside the insert's transaction, so
   * its count is the number of messages that arrived in the window — not an estimate. The
   * server sends every name it grouped, so `admin.feedback_viewed` being absent means it did
   * not happen in the window rather than that it fell off a list.
   *
   * There is no "unread count" endpoint and this does not invent one: a message can only be
   * read after it arrives, so if the spine records no read of the list at all in the window,
   * no message that ARRIVED in that window has been read. That is the strongest claim this
   * data supports, and it is the one made. A read that happened before the read-audit event
   * shipped left no record, which is why the copy says what the spine RECORDS rather than
   * what an admin did.
   *
   * ── AND WHY IT IS `info` AND LAST ───────────────────────────────────────────────────────
   * Nothing is broken. This is a queue nobody is standing at, which must never outrank an
   * outage, a tripped cap or a console that has gone blind — so it is stated quietly, at the
   * bottom, and it disappears the moment someone opens the screen.
   */
  const eventCount = (name: string) =>
    (input.metrics?.by_event_name ?? []).find((b) => b.key === name)?.count ?? 0;
  const arrived = eventCount("feedback.submitted");
  // Gated on the capability the Feedback screen itself declares: an item whose entire content
  // is "go and read this" is noise to an operator the route would turn away.
  if (input.mayReadEntities && arrived > 0 && eventCount("admin.feedback_viewed") === 0) {
    items.push({
      id: "feedback-unread",
      tone: "info",
      title: `${arrived} worker ${arrived === 1 ? "message" : "messages"} waiting`,
      body: `${arrived === 1 ? "A worker" : "Workers"} wrote in over the last ${input.metrics?.window_days ?? "—"} days, and the spine records nobody opening the feedback screen since.`,
      href: "/feedback",
      linkLabel: "Read feedback",
    });
  }

  return items;
}
