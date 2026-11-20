"use server";

import { z } from "zod";
import { describeAdminActionError } from "../lib/describe-admin-error";
import {
  setCampusPostingVisibility,
  setCampusPostingsVisibility,
  type WorkerVisibilityOutcome,
} from "../lib/campus-visibility";
import type { PostingReasonCode } from "../lib/company-vocabulary";

const reasonSchema = z.string().trim().min(15).max(500);

export interface CampusResult {
  posting_id: string;
  outcome: WorkerVisibilityOutcome;
  state: "on" | "off" | null;
}

export type CampusActionResult =
  | { ok: true; results: CampusResult[] }
  | { ok: false; error: string };

function validate(reasonText: string): string | null {
  return reasonSchema.safeParse(reasonText).success ? null : "Reason must be 15–500 characters.";
}

export async function setCampusVisibilityAction(
  postingId: string,
  state: "on" | "off",
  reasonCode: PostingReasonCode,
  reasonText: string,
): Promise<CampusActionResult> {
  const invalid = validate(reasonText);
  if (invalid) return { ok: false, error: invalid };
  try {
    return {
      ok: true,
      results: [await setCampusPostingVisibility(postingId, state, reasonCode, reasonText.trim())],
    };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}

export async function setCampusVisibilityBulkAction(
  postingIds: string[],
  state: "on" | "off",
  reasonCode: PostingReasonCode,
  reasonText: string,
): Promise<CampusActionResult> {
  const invalid = validate(reasonText);
  if (invalid) return { ok: false, error: invalid };
  try {
    const res = await setCampusPostingsVisibility(postingIds, state, reasonCode, reasonText.trim());
    return { ok: true, results: res.results };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}
