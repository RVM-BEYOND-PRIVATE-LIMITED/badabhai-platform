"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { updatePosting } from "../../../../../lib/payer-api";
import { updatePostingInputSchema } from "../../../../../lib/contracts";
import type { PostingSummary } from "../../../../../lib/contracts";

/**
 * Edit-posting Server Action (ADR-0019 Phase 1 — LIVE `PATCH /payer/job-postings/:id`).
 * XB-A: the client supplies the posting id + the editable fields ONLY — never a payer
 * id (the seam binds tenancy to the server-held session). Unknown OR not-owned id is
 * the SAME neutral not-found (no cross-tenant oracle). Input is re-validated here with
 * the SAME schema the form used (never trust the client parse alone).
 */

export type EditPostingActionResult =
  | { ok: true; posting: PostingSummary }
  | { ok: false; error: string };

const postingIdSchema = z.string().uuid();

export async function updatePostingAction(input: {
  postingId: string;
  roleTitle: string;
  vacancies: number;
  locationLabel?: string;
  description?: string;
}): Promise<EditPostingActionResult> {
  if (!postingIdSchema.safeParse(input.postingId).success) {
    return { ok: false, error: "That posting could not be found." };
  }
  const parsed = updatePostingInputSchema.safeParse({
    roleTitle: input.roleTitle,
    vacancies: input.vacancies,
    ...(input.locationLabel !== undefined && input.locationLabel !== ""
      ? { locationLabel: input.locationLabel }
      : {}),
    ...(input.description !== undefined && input.description !== ""
      ? { description: input.description }
      : {}),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form and retry.",
    };
  }
  try {
    const posting = await updatePosting(input.postingId, parsed.data);
    if (!posting) return { ok: false, error: "That posting could not be found." };
    revalidatePath("/postings");
    revalidatePath(`/postings/${input.postingId}`);
    return { ok: true, posting };
  } catch {
    return { ok: false, error: "Could not save the changes right now. Please retry." };
  }
}
