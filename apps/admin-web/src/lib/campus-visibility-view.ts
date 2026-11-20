import type { WorkerVisibilityOutcome } from "./campus-visibility";

/** #2891 — the plain words for one Campus visibility outcome (client-safe). */
export function campusOutcomeCopy(outcome: WorkerVisibilityOutcome): string {
  switch (outcome) {
    case "changed":
      return "Changed";
    case "unchanged":
      return "Already that way";
    case "trade_required":
      return "Set its trade first";
    case "audience_excludes_workers":
      return "Company limited it to RVM students";
    case "not_campus_origin":
      return "Not a Campus job";
  }
}
