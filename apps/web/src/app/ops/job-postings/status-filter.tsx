"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { JobPostingStatus } from "@badabhai/types";

const OPTIONS: { value: JobPostingStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
];

/**
 * Status filter for the postings list. Drives the server component via the
 * `?status=` query param (read by the page and forwarded to GET /job-postings).
 * "All" clears the param. No mutating action — navigation only.
 */
export function StatusFilter() {
  const router = useRouter();
  const pathname = usePathname();
  const current = useSearchParams().get("status") ?? "all";

  function select(value: JobPostingStatus | "all") {
    const href = value === "all" ? pathname : `${pathname}?status=${value}`;
    router.push(href);
  }

  return (
    <div className="filter-bar" role="group" aria-label="Filter by status">
      <span className="page-sub" style={{ margin: 0 }}>
        Status:
      </span>
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`filter-chip${current === o.value ? " active" : ""}`}
          aria-pressed={current === o.value}
          onClick={() => select(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
