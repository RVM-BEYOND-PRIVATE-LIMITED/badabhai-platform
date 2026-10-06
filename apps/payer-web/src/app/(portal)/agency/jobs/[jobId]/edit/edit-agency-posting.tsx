"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { AgencyJob } from "../../../../../../lib/contracts";
import { AgencyJobForm } from "../../../dashboard/agency-job-form";
import { updateAgencyJobAction } from "../../../dashboard/jobs-actions";

/**
 * The agency's EDIT form on its own page (`/agency/jobs/<id>/edit`). The form, its card rule
 * (gaps highlighted, never blocking on edit) and the live action are the ones the retired inline
 * row editor used — only the placement moved, so the preview rail starts at the top of the page.
 *
 * Runs in the browser and sees no secret: the Server Action binds to the server-held session
 * (XB-A) and re-checks the role itself. The loaded posting is passed as `initial`, so the seam
 * diffs it into the `clear` list — a card field the payer blanked is unset, not kept. On success
 * the payer lands on the posting's details (refreshed, so a later Back never restores the
 * pre-save form); Cancel returns there too.
 */
export function EditAgencyPosting({ job, lead }: { job: AgencyJob; lead: ReactNode }) {
  const router = useRouter();
  const detailHref = `/agency/jobs/${job.id}`;
  return (
    <AgencyJobForm
      mode="edit"
      job={job}
      lead={lead}
      submitLabel="Save changes"
      onCancel={() => router.push(detailHref)}
      onSubmit={async (input) => {
        const res = await updateAgencyJobAction(job.id, input, job);
        if (!res.ok) return { ok: false, error: res.error };
        router.push(detailHref);
        router.refresh();
        return { ok: true };
      }}
    />
  );
}
