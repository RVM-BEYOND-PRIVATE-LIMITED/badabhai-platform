"use client";

import { useRouter } from "next/navigation";
import { AgencyJobForm } from "../../dashboard/agency-job-form";
import { createAgencyJobAction } from "../../dashboard/jobs-actions";

/**
 * The agency's CREATE form on its own page (`/agency/jobs/new`). The form, its worker-card gap
 * rule and the live action are the ones the dashboard's inline form used — only the placement
 * moved: "New posting" is one destination, reached the same way from the rail, the dashboard
 * and the Postings list.
 *
 * Runs in the browser and sees no secret: the Server Action binds to the server-held session
 * (XB-A) and re-checks the role and the card rule itself. On success the payer lands on the
 * posting they just published; Cancel returns to the list.
 */
export function NewAgencyPosting() {
  const router = useRouter();
  return (
    <AgencyJobForm
      mode="create"
      submitLabel="Publish posting"
      onCancel={() => router.push("/agency/jobs")}
      onSubmit={async (input) => {
        const res = await createAgencyJobAction(input);
        if (!res.ok) return { ok: false, error: res.error };
        router.push(`/agency/jobs/${res.job.id}`);
        return { ok: true };
      }}
    />
  );
}
