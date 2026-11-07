import type { AdminActionOutcome } from "./admin-action-result";
import type { WorkerAccountAction } from "./candidate-account";

/**
 * The browser half of the candidate drawer's account actions (#2562, A7 #2577): a plain fetch
 * of the same-origin route, which carries the admin's httpOnly session to the API. Never a
 * Server Action — see the record/phone routes for why a pending action must not be discarded by
 * the drawer's own URL changes.
 */
export async function requestWorkerAccountAction(
  workerId: string,
  action: WorkerAccountAction,
  reasonText: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AdminActionOutcome> {
  try {
    const res = await fetchImpl(`/candidates/${encodeURIComponent(workerId)}/account/${action}`, {
      method: "POST",
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ reason_text: reasonText }),
    });
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null) {
      const envelope = body as { ok?: unknown; error?: unknown };
      if (envelope.ok === true) {
        return { ok: true, changed: true, message: "Done." };
      }
      if (typeof envelope.error === "string" && envelope.error.trim() !== "") {
        return { ok: false, error: envelope.error };
      }
    }
    return { ok: false, error: "The action did not go through. Try again." };
  } catch {
    return { ok: false, error: "The action did not reach the server. Try again." };
  }
}
