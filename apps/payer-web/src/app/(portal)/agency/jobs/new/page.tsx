import { notFound } from "next/navigation";
import { requireAgent } from "../../../../../lib/auth/roles";
import { agencyFlags } from "../../../../../lib/config";
import { listMatchSkills } from "../../../../../lib/payer-api";
import type { MatchSkillWire } from "../../../../../lib/contracts";
import { PageHeader } from "../../../../../components/page-header";
import { NewAgencyPosting } from "./new-agency-posting";

export const dynamic = "force-dynamic";

/**
 * Agency "New posting" (owner ruling 2026-10-01) — EVERY agency "post" entry point (the rail,
 * the dashboard head, the Postings list) opens this page, and it creates an AGENCY job: a row
 * of the `jobs` table the worker feed reads (POST /payer/agency/jobs). It never creates a
 * company `job_postings` row — that surface is for companies only.
 *
 * A top-level destination (its own rail item), so its header has no back link; Cancel in the
 * form returns to Postings. The page head LEADS the form column (as on the company form), so the
 * card-preview rail starts at the top of the content and the worker card and "Publish posting"
 * are on a laptop screen from the first field (final sweep F01: rendered above the form instead,
 * the head pushed the rail 76px down and the button below a 720px viewport).
 *
 * SECURITY: `requireAgent()` FIRST, then the agency-portal flag, like every agency page. The
 * create action re-asserts the role itself (a Server Action is independently invocable).
 */
export default async function NewAgencyPostingPage() {
  await requireAgent();
  if (!agencyFlags().agencyPortalEnabled) notFound();

  // ADR-0050 §6.1 step 2 (#2104) — the closed match vocabulary, read SERVER-side so the session
  // Bearer never reaches the browser (the company form's page does the same). A FAILED read is
  // NOT swallowed into "carry on": `[]` is the form's signal to say so and refuse the save,
  // because a job with no match pick gets a `paused` twin and reaches nobody. `[]` is
  // distinguishable from a real empty vocabulary only because a real one is never empty (the
  // seed is checked in).
  let matchSkills: MatchSkillWire[] = [];
  try {
    matchSkills = await listMatchSkills();
  } catch {
    matchSkills = [];
  }

  return (
    <NewAgencyPosting
      matchSkills={matchSkills}
      lead={
        <PageHeader
          title="New posting"
          description="Describe the role; it goes live for matched workers as soon as you publish it."
        />
      }
    />
  );
}
