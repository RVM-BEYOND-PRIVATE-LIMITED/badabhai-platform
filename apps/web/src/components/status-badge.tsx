import type { JobPostingStatus } from "@badabhai/types";
import { STATUS_LABEL } from "@/lib/job-postings";

/**
 * Job-posting lifecycle badge. Distinct colour per status so a `draft` reads
 * clearly differently from `open` / `closed` at a glance.
 */
export function StatusBadge({ status }: { status: JobPostingStatus }) {
  return (
    <span className={`status-badge status-${status}`}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}
