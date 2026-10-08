"use client";

import type { ReactNode } from "react";
import { AgencyJobForm } from "../../dashboard/agency-job-form";
import { usePortalNavigation } from "../../../../../components/portal-navigation";
import { createAgencyJobAction } from "../../dashboard/jobs-actions";

/**
 * The agency's CREATE form on its own page (`/agency/jobs/new`). The form, its worker-card gap
 * rule and the live action are the ones the dashboard's inline form used — only the placement
 * moved: "New posting" is one destination, reached the same way from the rail, the dashboard
 * and the Postings list.
 *
 * Runs in the browser and sees no secret: the Server Action binds to the server-held session
 * (XB-A) and re-checks the role and the card rule itself. On success the payer lands on the
 * posting they just published; Cancel returns to the list — each with the shell's "Opening …"
 * cue while the page renders. `lead` is the page head, drawn at the top of the form column so the
 * preview rail starts level with it.
 */
export function NewAgencyPosting({ lead }: { lead: ReactNode }) {
  const { navigate } = usePortalNavigation();
  return (
    <AgencyJobForm
      mode="create"
      lead={lead}
      submitLabel="Publish posting"
      onCancel={() => navigate("/agency/jobs", { pendingLabel: "Postings" })}
      onSubmit={async (input) => {
        const res = await createAgencyJobAction(input);
        if (!res.ok) return { ok: false, error: res.error };
        navigate(`/agency/jobs/${res.job.id}`, { pendingLabel: res.job.title });
        return { ok: true };
      }}
    />
  );
}
