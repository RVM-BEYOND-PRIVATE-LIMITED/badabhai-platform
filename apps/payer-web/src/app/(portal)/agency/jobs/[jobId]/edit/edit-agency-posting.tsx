"use client";

import type { ReactNode } from "react";
import type { AgencyJob, MatchSkillWire } from "../../../../../../lib/contracts";
import { usePortalNavigation } from "../../../../../../components/portal-navigation";
import { AgencyJobForm } from "../../../dashboard/agency-job-form";
import { updateAgencyJobAction } from "../../../dashboard/jobs-actions";

/**
 * The agency's EDIT form on its own page (`/agency/jobs/<id>/edit`). The form, its card rule
 * (gaps highlighted, never blocking on edit) and the live action are the ones the retired inline
 * row editor used — only the placement moved, so the preview rail starts at the top of the page.
 *
 * Runs in the browser and sees no secret: the Server Action binds to the server-held session
 * (XB-A) and re-checks the role itself. The loaded posting is passed as `initial`, so the seam
 * diffs it into the `clear` list — a card field the payer blanked is unset, not kept. The match
 * vocabulary (#2104) comes from the page's own server read; the picker is prefilled from the
 * posting's stored pick and the save carries it only when it changed. On success the payer lands
 * on the posting's details (refreshed, so a later Back never restores the pre-save form); Cancel
 * returns there too — each with the shell's "Opening <title>…" cue while the page renders.
 */
export function EditAgencyPosting({
  job,
  matchSkills,
  lead,
}: {
  job: AgencyJob;
  matchSkills: MatchSkillWire[];
  lead: ReactNode;
}) {
  const { navigate } = usePortalNavigation();
  const detailHref = `/agency/jobs/${job.id}`;
  return (
    <AgencyJobForm
      mode="edit"
      job={job}
      matchSkills={matchSkills}
      lead={lead}
      submitLabel="Save changes"
      onCancel={() => navigate(detailHref, { pendingLabel: job.title })}
      onSubmit={async (input) => {
        const res = await updateAgencyJobAction(job.id, input, job);
        if (!res.ok) return { ok: false, error: res.error };
        navigate(detailHref, { pendingLabel: res.job.title, refresh: true });
        return { ok: true };
      }}
    />
  );
}
