/** "₹1,179" from integer paise (client-safe). */
export function formatPaise(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
}

/** The rule's plain-language refusal, never the server's raw enum (client-safe). */
export function refusalCopy(refusal: string | null): string | null {
  switch (refusal) {
    case "pack_used":
      return "Credits from this pack have been used";
    case "window_passed":
      return "The refund window has passed";
    case "no_job":
      return "No job to count applicants on";
    case "too_many_applicants":
      return "Too many people applied to the job";
    default:
      return null;
  }
}
