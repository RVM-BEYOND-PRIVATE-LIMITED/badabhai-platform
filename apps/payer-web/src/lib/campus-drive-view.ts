import type { CampusDriveRequest, CampusDriveStatus } from "./contracts";

/** The chip label for a request's status. Dates/reasons are rendered beside it, as plain text. */
export const CAMPUS_DRIVE_STATUS_LABEL: Record<CampusDriveStatus, string> = {
  requested: "Requested",
  scheduled: "Scheduled",
  declined: "Declined",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function campusDriveStatusTone(
  status: CampusDriveStatus,
): "success" | "warning" | "danger" | "neutral" | "brand" {
  switch (status) {
    case "scheduled":
      return "success";
    case "requested":
      return "brand";
    case "declined":
      return "danger";
    case "completed":
      return "neutral";
    case "cancelled":
      return "neutral";
  }
}

/** Can the company cancel this request? Only while it is requested or scheduled. */
export function canCancelCampusDrive(status: CampusDriveStatus): boolean {
  return status === "requested" || status === "scheduled";
}

/** Today's date in India, as the `YYYY-MM-DD` the API's date fields take. */
export function todayInIndia(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}

/** One year from today in India, as `YYYY-MM-DD` — the API's `preferred_to` ceiling. */
export function oneYearFromTodayInIndia(now: Date = new Date()): string {
  const [y = 0, m = 1, d = 1] = todayInIndia(now).split("-").map(Number);
  return `${y + 1}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** A stored `YYYY-MM-DD` date, rendered plainly. Never parsed into a timezone-shifting Date. */
export function campusDateLabel(value: string | null): string | null {
  if (value === null || value === "") return null;
  return value;
}

/** The posting context a request names, if any. The request never carries its title. */
export function campusDrivePostingLabel(request: CampusDriveRequest): string | null {
  return request.job_posting_id;
}
