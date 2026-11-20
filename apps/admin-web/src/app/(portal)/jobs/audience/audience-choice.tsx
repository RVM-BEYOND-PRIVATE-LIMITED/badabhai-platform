"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "../../../../components/confirm-dialog";
import { filterChipClass } from "../../../../components/filter-chip";
import { POSTING_REASON_CATEGORIES } from "../../../../lib/company-vocabulary";
import {
  AUDIENCE_HINTS,
  AUDIENCE_LABELS,
  JOB_AUDIENCES,
  SHOWN_TO_LABELS,
  type JobAudience,
  type ShownTo,
} from "../../../../lib/job-audience-vocabulary";
import { decideAudienceAction, type AudienceDecisionOutcome } from "./actions";

/**
 * #2958 — WHERE A JOB SHOWS: Campus only, Campus and BadaBhai, or BadaBhai only. One job (the job
 * page) or many (the list's selection) get the same decision; every change asks for a reason and
 * is stored with the admin's name in the audit trail. Each job's outcome comes back from the API:
 * a refusal (no trade, a trade RVM doesn't train, an agency copy) is said in plain words.
 */
export function AudienceChoice({
  postingIds,
  shownTo,
  disabledReason,
  onDecided,
}: {
  postingIds: readonly string[];
  /** Where the job shows now (one job only); null for a selection of many. */
  shownTo: ShownTo | null;
  /** When set, the buttons are disabled with this explanation (for example, nothing selected). */
  disabledReason?: string;
  onDecided?: (outcome: AudienceDecisionOutcome) => void;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState<JobAudience | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const many = postingIds.length > 1;
  const current = shownTo === null ? null : SHOWN_TO_LABELS[shownTo];

  return (
    <div>
      <div className="state__actions" role="group" aria-label="Where this job shows">
        {JOB_AUDIENCES.map((audience) => {
          const isCurrent = current !== null && current === AUDIENCE_LABELS[audience];
          return (
            <button
              key={audience}
              type="button"
              className={filterChipClass(isCurrent, "md")}
              aria-pressed={isCurrent}
              disabled={disabledReason !== undefined}
              title={disabledReason ?? AUDIENCE_HINTS[audience]}
              onClick={() => {
                setMessage(null);
                setChoice(audience);
              }}
            >
              {AUDIENCE_LABELS[audience]}
            </button>
          );
        })}
      </div>
      {disabledReason ? <p className="field__help">{disabledReason}</p> : null}
      {message ? (
        <p className="field__help" role="status">
          {message}
        </p>
      ) : null}
      <ConfirmDialog
        open={choice !== null}
        onClose={() => setChoice(null)}
        tier="consequential"
        title={many ? `Show ${postingIds.length} jobs: ${choice ? AUDIENCE_LABELS[choice] : ""}` : `Show this job: ${choice ? AUDIENCE_LABELS[choice] : ""}`}
        description={choice ? AUDIENCE_HINTS[choice] : undefined}
        changes={[
          {
            label: "Shown to",
            before: many ? "Each job's current choice" : (current ?? "Not decided"),
            after: choice ? AUDIENCE_LABELS[choice] : "",
          },
        ]}
        categories={POSTING_REASON_CATEGORIES}
        confirmLabel="Save"
        onConfirm={(reason) =>
          decideAudienceAction({ postingIds: [...postingIds], audience: choice, reason })
        }
        onSettled={(outcome) => {
          if (!outcome.ok) return;
          setChoice(null);
          setMessage(outcome.message);
          onDecided?.(outcome as AudienceDecisionOutcome);
          router.refresh();
        }}
      />
    </div>
  );
}
