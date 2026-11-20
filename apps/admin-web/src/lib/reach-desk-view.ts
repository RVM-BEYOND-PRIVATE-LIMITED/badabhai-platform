/** #2750 items 7/8 — client-safe labels and the closed attempt/outcome lists. */
export const REACH_ATTEMPT_RESULTS = [
  "no_answer",
  "busy",
  "switched_off",
  "wrong_number",
  "other",
] as const;

export const REACH_OUTCOMES = [
  "reached_interested",
  "reached_declined",
  "not_reached",
] as const;

export function reachCaseLabel(status: string): string {
  switch (status) {
    case "open":
      return "Open";
    case "reached_interested":
      return "Reached — interested";
    case "reached_declined":
      return "Reached — declined";
    case "not_reached":
      return "Not reached";
    default:
      return status.replace(/_/g, " ");
  }
}
