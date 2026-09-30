"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { agencyJobInputSchema, type AgencyJob } from "../../../../lib/contracts";
import {
  closeAgencyJob,
  createAgencyJob,
  pauseAgencyJob,
  resumeAgencyJob,
  updateAgencyJob,
} from "../../../../lib/payer-api";
import { requireAgent } from "../../../../lib/auth/roles";
import { workerCardGap } from "../../../../lib/worker-card-gap";

/**
 * Agency job lifecycle + CRUD Server Actions (ADR-0022, LIVE).
 *
 * VERTICAL AUTHZ (XB-A / XT3): a Server Action is independently invocable (it is a POST
 * endpoint), so EACH action enforces the agent role gate ITSELF via `requireAgent()` as
 * its FIRST statement — it does NOT rely on the page's gate or the backend alone. An
 * employer session hits the SAME neutral `notFound()` the page does (no oracle, no leak
 * that the action exists).
 *
 * TENANCY: the owner payer is the SERVER-HELD session (the payer JWT) inside the data
 * seam — the client supplies ONLY a job id + coarse, non-PII demand fields, NEVER a
 * payer id. NO-ORACLE: a `null` seam result (unknown OR not-owned job) maps to the SAME
 * neutral "not found" message as a malformed id (no cross-tenant existence oracle).
 * FACELESS: no worker identity / employer name is ever an input or output here.
 */

const NOT_FOUND = "That vacancy could not be found.";

/** Lifecycle (pause/close) discriminated result — returns the full updated job on success. */
export type AgencyJobActionResult =
  | { ok: true; job: AgencyJob }
  | { ok: false; error: string };

/** Create/edit discriminated result — returns the updated job (the manager re-renders it). */
export type AgencyJobMutationResult =
  | { ok: true; job: AgencyJob }
  | { ok: false; error: string };

const jobIdSchema = z.string().uuid();

/**
 * EDIT semantics (PR-B): `UpdateAgencyJobSchema` now carries a `clear` list, so BLANKING a
 * previously-set optional card field (area / pay / experience / shift / pay type / description /
 * requirements / benefits) DOES clear it. `updateAgencyJobAction` passes the current row as
 * `initial`, and `toAgencyJobBody` diffs it to build `clear` — restricted to the mirrored
 * `CLEARABLE_AGENCY_JOB_FIELDS` allowlist (NOT NULL columns like `trade_key`/`title`/`city` can
 * never be cleared). Backend re-validates and stays the authority.
 */

/**
 * The coarse, non-PII demand input the form/manager submits. Mirrors `AgencyJobInput`
 * (validated by `agencyJobInputSchema`); there is deliberately NO employer-name / worker
 * field. `unknown` here keeps the action callable with raw client input — it is Zod-parsed
 * before it ever reaches the seam.
 */
export async function createAgencyJobAction(input: unknown): Promise<AgencyJobMutationResult> {
  await requireAgent(); // role gate FIRST — employer → neutral notFound().
  const parsed = agencyJobInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  // GAP RULE — an agency create is create==publish (the vacancy goes live `open` immediately),
  // so the full worker-card rule applies exactly as on company CREATE. Re-run server-side: a
  // Server Action is independently invocable, so a direct POST must not be able to bypass the
  // browser gate and ship a thin card (parity with `new/actions.ts`; XB-A).
  const gap = workerCardGap({
    roleKind: parsed.data.roleKind ?? null,
    city: parsed.data.city ?? "",
    payMin: parsed.data.payMin ?? null,
    payMax: parsed.data.payMax ?? null,
    payType: parsed.data.payType ?? null,
    expMin: parsed.data.minExperienceYears ?? null,
    expMax: parsed.data.maxExperienceYears ?? null,
    shift: parsed.data.shift ?? null,
    neededBy: parsed.data.neededBy ?? null,
    description: parsed.data.description ?? "",
    requirements: parsed.data.requirements ?? [],
    benefits: parsed.data.benefits ?? [],
  });
  if (gap !== null) {
    return { ok: false, error: `${gap.title}: ${gap.message}` };
  }
  try {
    const job = await createAgencyJob(parsed.data);
    revalidatePath("/dashboard"); // MERGE-1: the agency vacancy manager now renders on /dashboard.
    return { ok: true, job };
  } catch {
    return { ok: false, error: "Could not create the vacancy right now. Please retry." };
  }
}

export async function updateAgencyJobAction(
  jobId: string,
  input: unknown,
  initial?: AgencyJob | null,
): Promise<AgencyJobMutationResult> {
  await requireAgent(); // role gate FIRST — employer → neutral notFound().
  if (!jobIdSchema.safeParse(jobId).success) {
    return { ok: false, error: NOT_FOUND };
  }
  const parsed = agencyJobInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  try {
    // `initial` (the current row) drives the `clear` diff — a card field the payer BLANKED is unset.
    const job = await updateAgencyJob(jobId, parsed.data, initial ?? null);
    if (!job) return { ok: false, error: NOT_FOUND }; // no-oracle: not-found == not-owned.
    revalidatePath("/dashboard"); // MERGE-1: the agency vacancy manager now renders on /dashboard.
    return { ok: true, job };
  } catch {
    return { ok: false, error: "Could not update the vacancy right now. Please retry." };
  }
}

/**
 * Resume an OWN paused vacancy (`paused` -> `open`, #1202) — the reverse of pause. Role-gated
 * FIRST (employer → neutral notFound()). A `suspended` job is SYSTEM-owned and 409s server-side
 * (surfaced as the retryable message); unknown/not-owned → the neutral NOT_FOUND.
 */
export async function resumeAgencyJobAction(input: {
  jobId: string;
}): Promise<AgencyJobActionResult> {
  await requireAgent();
  if (!jobIdSchema.safeParse(input.jobId).success) {
    return { ok: false, error: NOT_FOUND };
  }
  try {
    const job = await resumeAgencyJob(input.jobId);
    if (!job) return { ok: false, error: NOT_FOUND }; // no-oracle: not-found == not-owned.
    revalidatePath("/dashboard");
    return { ok: true, job };
  } catch {
    return { ok: false, error: "Could not resume the vacancy right now. Please retry." };
  }
}

export async function pauseAgencyJobAction(input: {
  jobId: string;
}): Promise<AgencyJobActionResult> {
  await requireAgent(); // role gate FIRST — employer → neutral notFound().
  if (!jobIdSchema.safeParse(input.jobId).success) {
    return { ok: false, error: NOT_FOUND };
  }
  try {
    const job = await pauseAgencyJob(input.jobId);
    if (!job) return { ok: false, error: NOT_FOUND }; // no-oracle: not-found == not-owned.
    revalidatePath("/dashboard"); // MERGE-1: the agency vacancy manager now renders on /dashboard.
    return { ok: true, job };
  } catch {
    return { ok: false, error: "Could not pause the vacancy right now. Please retry." };
  }
}

export async function closeAgencyJobAction(input: {
  jobId: string;
}): Promise<AgencyJobActionResult> {
  await requireAgent(); // role gate FIRST — employer → neutral notFound().
  if (!jobIdSchema.safeParse(input.jobId).success) {
    return { ok: false, error: NOT_FOUND };
  }
  try {
    const job = await closeAgencyJob(input.jobId);
    if (!job) return { ok: false, error: NOT_FOUND }; // no-oracle: not-found == not-owned.
    revalidatePath("/dashboard"); // MERGE-1: the agency vacancy manager now renders on /dashboard.
    return { ok: true, job };
  } catch {
    return { ok: false, error: "Could not close the vacancy right now. Please retry." };
  }
}
