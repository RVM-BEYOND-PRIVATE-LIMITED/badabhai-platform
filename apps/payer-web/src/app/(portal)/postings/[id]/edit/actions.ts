"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { updatePosting, type PostingEditInitial } from "../../../../../lib/payer-api";
import { matchSelectionInputSchema, updatePostingInputSchema } from "../../../../../lib/contracts";
import type { PostingSummary } from "../../../../../lib/contracts";
import { workerCardGap } from "../../../../../lib/worker-card-gap";

/**
 * Edit-posting Server Action (PR-B — LIVE `PATCH /payer/job-postings/:id`). One action serves both
 * SAVE and PUBLISH:
 *
 *  - SAVE (`publish` absent): persists the card fields + the `clear` diff (a blanked field is
 *    unset). NO gap block — editing a LIVE (or draft) posting saves with the gaps merely
 *    highlighted on the form (owner ruling), never refused.
 *  - PUBLISH (`publish` present, DRAFT only): the workerCardGap rule BLOCKS a thin card and a
 *    publish requires ≥1 match skill; the same PATCH carries `match_skill_ids` + `status:"open"`.
 *
 * XB-A: the client supplies the posting id + fields + the prior `initial` (for the clear diff) —
 * never a payer id. Input is re-validated here with the SAME schema the form used.
 */

export type EditPostingActionResult =
  | { ok: true; posting: PostingSummary }
  | { ok: false; error: string };

const postingIdSchema = z.string().uuid();

export interface UpdatePostingActionInput {
  postingId: string;
  roleKind?: string;
  roleTitle: string;
  vacancies?: number;
  locationLabel?: string;
  description?: string;
  city?: string;
  area?: string;
  payMin?: number;
  payMax?: number;
  payType?: string;
  minExperienceYears?: number;
  maxExperienceYears?: number;
  shift?: string;
  neededBy?: string;
  requirements?: string[];
  benefits?: string[];
  /** The prior values, for the `clear` diff (a field that HAD a value and is now blank). */
  initial: PostingEditInitial;
  /** Present only on the DRAFT "Publish" path — the matchable half + the gap block. */
  publish?: { matchSkillIds: string[]; untickedRelatedIds: string[] };
}

export async function updatePostingAction(
  input: UpdatePostingActionInput,
): Promise<EditPostingActionResult> {
  if (!postingIdSchema.safeParse(input.postingId).success) {
    return { ok: false, error: "That posting could not be found." };
  }
  const parsed = updatePostingInputSchema.safeParse({
    roleTitle: input.roleTitle,
    ...(input.vacancies !== undefined ? { vacancies: input.vacancies } : {}),
    ...(input.roleKind ? { roleKind: input.roleKind } : {}),
    ...(input.locationLabel ? { locationLabel: input.locationLabel } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.city ? { city: input.city } : {}),
    ...(input.area ? { area: input.area } : {}),
    ...(input.payMin !== undefined ? { payMin: input.payMin } : {}),
    ...(input.payMax !== undefined ? { payMax: input.payMax } : {}),
    ...(input.payType ? { payType: input.payType } : {}),
    ...(input.minExperienceYears !== undefined ? { minExperienceYears: input.minExperienceYears } : {}),
    ...(input.maxExperienceYears !== undefined ? { maxExperienceYears: input.maxExperienceYears } : {}),
    ...(input.shift ? { shift: input.shift } : {}),
    ...(input.neededBy ? { neededBy: input.neededBy } : {}),
    ...(input.requirements && input.requirements.length > 0 ? { requirements: input.requirements } : {}),
    ...(input.benefits && input.benefits.length > 0 ? { benefits: input.benefits } : {}),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check the form and retry." };
  }

  let publish: { matchSkillIds: string[]; untickedRelatedIds: string[] } | undefined;
  if (input.publish) {
    // PUBLISH — gap BLOCKS (a live posting must trace to a full card) + ≥1 skill required.
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
    if (gap !== null) return { ok: false, error: `${gap.title}: ${gap.message}` };
    const selection = matchSelectionInputSchema.safeParse(input.publish);
    if (!selection.success) {
      return { ok: false, error: "Pick at least one skill so workers can find this job." };
    }
    publish = selection.data;
  }

  try {
    const posting = await updatePosting(input.postingId, parsed.data, {
      initial: input.initial,
      publish,
    });
    if (!posting) return { ok: false, error: "That posting could not be found." };
    revalidatePath("/postings");
    revalidatePath(`/postings/${input.postingId}`);
    return { ok: true, posting };
  } catch (e) {
    if (e instanceof Error && /returned 400/.test(e.message)) {
      return { ok: false, error: "No changes to save." };
    }
    if (e instanceof Error && /returned 409/.test(e.message)) {
      return { ok: false, error: "This posting can no longer be edited." };
    }
    return { ok: false, error: "Could not save the changes right now. Please retry." };
  }
}
