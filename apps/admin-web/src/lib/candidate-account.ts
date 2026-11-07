import "server-only";
import { z } from "zod";
import { uuidSchema } from "@badabhai/validators";
import { adminFetch } from "./admin-http";

/**
 * The worker ACCOUNT actions (#2562) the candidate drawer offers (A7, #2577) — sign out
 * everywhere, reset PIN, suspend, unsuspend. The API routes are `POST /admin/workers/:id/*`
 * behind `manage_worker_account` (super_admin / ops_admin / support), each taking a closed
 * reason_code and a 15–500 character reason. The reason_code is DERIVED from the action here;
 * the operator only chooses the explanation.
 */

export const WORKER_ACCOUNT_ACTIONS = [
  "sign-out-all",
  "pin-reset",
  "suspend",
  "unsuspend",
] as const;
export type WorkerAccountAction = (typeof WORKER_ACCOUNT_ACTIONS)[number];

const API: Readonly<Record<WorkerAccountAction, { path: string; reason: string }>> = {
  "sign-out-all": { path: "sign-out-all", reason: "worker_sign_out_all" },
  "pin-reset": { path: "pin-reset", reason: "worker_pin_reset" },
  suspend: { path: "suspend", reason: "worker_suspend" },
  unsuspend: { path: "unsuspend", reason: "worker_unsuspend" },
};

const resultSchema = z.object({ target_id: z.string(), changed: z.boolean() });

export type WorkerAccountActionResult = z.infer<typeof resultSchema>;

export function isWorkerAccountAction(value: unknown): value is WorkerAccountAction {
  return typeof value === "string" && (WORKER_ACCOUNT_ACTIONS as readonly string[]).includes(value);
}

/** One governed account action, with the operator's explanation. */
export async function performWorkerAccountAction(
  workerId: string,
  action: WorkerAccountAction,
  reasonText: string,
): Promise<WorkerAccountActionResult> {
  if (!uuidSchema.safeParse(workerId).success) throw new Error("That worker id is not valid.");
  const route = API[action];
  return adminFetch(`/admin/workers/${encodeURIComponent(workerId)}/${route.path}`, {
    method: "POST",
    body: { reason_code: route.reason, reason_text: reasonText },
    schema: resultSchema,
  });
}
