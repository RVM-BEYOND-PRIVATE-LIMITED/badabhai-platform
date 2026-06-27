"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { agencyJobInputSchema, type AgencyJob } from "../../../../lib/contracts";
import {
  closeAgencyJob,
  createAgencyJob,
  pauseAgencyJob,
  updateAgencyJob,
} from "../../../../lib/payer-api";
import { requireAgent } from "../../../../lib/auth/roles";

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
 * NOTE on EDIT semantics: the backend `UpdateAgencyJobSchema` treats an OMITTED field as
 * "no change" (and has no `nullable` for the optional bands), so BLANKING a previously-set
 * optional field (area / pay / experience) is a NO-OP, not a clear — the stored value
 * persists. Clearing an optional back to null is not expressible over the current contract;
 * a dedicated "clear" affordance would require a backend change first.
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
    const job = await updateAgencyJob(jobId, parsed.data);
    if (!job) return { ok: false, error: NOT_FOUND }; // no-oracle: not-found == not-owned.
    revalidatePath("/dashboard"); // MERGE-1: the agency vacancy manager now renders on /dashboard.
    return { ok: true, job };
  } catch {
    return { ok: false, error: "Could not update the vacancy right now. Please retry." };
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
