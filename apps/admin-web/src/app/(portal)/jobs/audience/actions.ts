"use server";

import { z } from "zod";
import { describeAdminActionError } from "../../../../lib/describe-admin-error";
import { isAdminRequestError } from "../../../../lib/admin-http";
import type { AdminActionOutcome } from "../../../../lib/admin-action-result";
import { POSTING_REASON_CODES } from "../../../../lib/company-vocabulary";
import { setAudience, setCampusTrades } from "../../../../lib/job-audience";
import {
  AUDIENCE_OUTCOME_MESSAGES,
  JOB_AUDIENCES,
  type AudienceOutcome,
} from "../../../../lib/job-audience-vocabulary";

/** The switch is off: the API answers 404 for every audience route. */
const SWITCHED_OFF =
  "Deciding where jobs show is not switched on yet. Ask the owner to turn on ADMIN_JOB_AUDIENCE_ENABLED.";

const reason = z.object({
  category: z.enum(POSTING_REASON_CODES),
  text: z.string().trim().min(15, "The reason needs at least 15 characters.").max(500),
});

const decision = z.object({
  postingIds: z.array(z.string().uuid()).min(1).max(100),
  audience: z.enum(JOB_AUDIENCES),
  reason,
});

/** A decision's outcome for the dialog, plus each job's own outcome (a batch shows them). */
export type AudienceDecisionOutcome = AdminActionOutcome & {
  results?: { postingId: string; outcome: AudienceOutcome; message: string }[];
};

/**
 * #2956 — one job or many get the same decision; each job has its own outcome. For ONE job a
 * refusal is a failure (the dialog stays open and says why); for a batch the summary is a success
 * and the rows say which were refused.
 */
export async function decideAudienceAction(input: unknown): Promise<AudienceDecisionOutcome> {
  const parsed = decision.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the decision." };
  }
  const { postingIds, audience, reason: why } = parsed.data;
  try {
    const raw = await setAudience({
      postingIds,
      audience,
      reasonCode: why.category,
      reasonText: why.text,
    });
    const results = raw.map((r) => ({
      postingId: r.posting_id,
      outcome: r.outcome,
      message: AUDIENCE_OUTCOME_MESSAGES[r.outcome],
    }));
    const changed = results.filter((r) => r.outcome === "changed").length;
    if (results.length === 1) {
      const only = results[0]!;
      if (only.outcome !== "changed" && only.outcome !== "unchanged") {
        return { ok: false, error: only.message };
      }
      return { ok: true, changed: only.outcome === "changed", message: only.message, results };
    }
    const refused = results.filter(
      (r) => r.outcome !== "changed" && r.outcome !== "unchanged",
    ).length;
    return {
      ok: true,
      changed: changed > 0,
      message: `${changed} changed, ${results.length - changed - refused} already set, ${refused} refused.`,
      results,
    };
  } catch (err) {
    if (isAdminRequestError(err) && err.status === 404) return { ok: false, error: SWITCHED_OFF };
    return { ok: false, error: describeAdminActionError(err) };
  }
}

const trades = z.object({
  tradeKeys: z.array(z.string().min(1).max(64)).max(64),
  reason,
});

/** #2957 — replace the list of trades RVM trains. */
export async function setCampusTradesAction(input: unknown): Promise<AdminActionOutcome> {
  const parsed = trades.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the list." };
  }
  try {
    const res = await setCampusTrades({
      tradeKeys: parsed.data.tradeKeys,
      reasonCode: parsed.data.reason.category,
      reasonText: parsed.data.reason.text,
    });
    if (res.added.length === 0 && res.removed.length === 0) {
      return { ok: true, changed: false, message: "Nothing changed. The list was already this." };
    }
    return {
      ok: true,
      changed: true,
      message: `Saved. Added ${res.added.length}, removed ${res.removed.length}.`,
    };
  } catch (err) {
    if (isAdminRequestError(err) && err.status === 404) return { ok: false, error: SWITCHED_OFF };
    return { ok: false, error: describeAdminActionError(err) };
  }
}
