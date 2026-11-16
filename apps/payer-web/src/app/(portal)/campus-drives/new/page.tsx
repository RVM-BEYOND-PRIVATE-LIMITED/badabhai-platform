import { notFound } from "next/navigation";
import { requirePayer } from "../../../../lib/auth";
import { getAudienceOptions, getPostings } from "../../../../lib/payer-api";
import { PageHeader } from "../../../../components/page-header";
import type { AudienceOptions, PostingSummary } from "../../../../lib/contracts";
import {
  oneYearFromTodayInIndia,
  todayInIndia,
} from "../../../../lib/campus-drive-view";
import { CampusDriveForm } from "./campus-drive-form";

export const dynamic = "force-dynamic";

/**
 * #2813 — ask RVM's placement team for a campus drive. Employer-only (payer-web only).
 *
 * The branch picker comes from `GET /payer/job-postings/audience-options`: only on a 200 is it
 * shown. A 404 there (the separate `job_audience` switch is off) simply leaves it out — branches
 * are optional and `[]` means any branch. The campus-drive `POST` itself is the switch-gated
 * route; a 404 from it is reported by the form as unavailable.
 *
 * Preferred dates are bounded server-side in India: today through one year ahead, so the client
 * never offers a date the API will refuse.
 */
export default async function NewCampusDrivePage() {
  const session = await requirePayer();
  if (session.role !== "employer") notFound();

  let postings: PostingSummary[] = [];
  try {
    postings = await getPostings();
  } catch {
    postings = [];
  }
  let audienceOptions: AudienceOptions | null = null;
  try {
    audienceOptions = await getAudienceOptions();
  } catch {
    audienceOptions = null;
  }

  const today = todayInIndia();

  return (
    <div className="page">
      <PageHeader
        back={{ href: "/campus-drives", label: "Campus drives" }}
        title="Ask for a campus drive"
        description="Tell RVM's placement team the branches, dates and numbers you need."
      />
      <CampusDriveForm
        postings={postings}
        branches={audienceOptions?.branches ?? []}
        minDate={today}
        maxDate={oneYearFromTodayInIndia()}
      />
    </div>
  );
}
