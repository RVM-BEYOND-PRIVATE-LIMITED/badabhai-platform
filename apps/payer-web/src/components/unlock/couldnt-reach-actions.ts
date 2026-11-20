"use server";

import { requirePayer } from "../../lib/auth";
import { getReachCase, reportCouldntReach } from "../../lib/payer-api";

export type ReachCaseView = {
  caseId: string;
  unlockId: string;
  status: "open" | "reached_interested" | "reached_declined" | "not_reached";
  reportedAt: string;
  deadlineAt: string;
  resolvedAt: string | null;
  creditsReturned: number;
};

export type ReachCaseResult =
  | { ok: true; reachCase: ReachCaseView | null }
  | { ok: false; error: string };

export async function getReachCaseAction(unlockId: string): Promise<ReachCaseResult> {
  await requirePayer();
  try {
    return { ok: true, reachCase: await getReachCase(unlockId) };
  } catch {
    return { ok: false, error: "Couldn't read this case right now. Please retry." };
  }
}

export async function reportCouldntReachAction(unlockId: string): Promise<ReachCaseResult> {
  await requirePayer();
  try {
    return { ok: true, reachCase: await reportCouldntReach(unlockId) };
  } catch {
    // Includes the 409 REPORT_WINDOW_CLOSED — the action is hidden after day 7 anyway, and the
    // page never discloses which cause refused.
    return { ok: false, error: "This contact can no longer be reported. Please retry or contact support." };
  }
}
