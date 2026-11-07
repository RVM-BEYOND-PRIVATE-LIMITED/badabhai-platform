import type { CorrectionHistoryItem, CorrectionResult } from "./candidate-corrections";
import type { CorrectionReasonCode } from "./candidate-edit-model";

/**
 * The drawer's correction actions (A7, #2577): plain fetches of the same-origin routes under
 * `/candidates/<id>/corrections`. No server-only import — these run in the browser.
 *
 * Every failure is a VALUE with a sentence to show. A rejected promise means the caller aborted
 * (the drawer moved to another candidate) and nobody will read the answer.
 */

export type CorrectionHistoryResult =
  | { ok: true; items: CorrectionHistoryItem[] }
  | { ok: false; error: string };

export type CorrectionActionResult =
  | { ok: true; result: CorrectionResult }
  | { ok: false; error: string };

interface Envelope {
  ok?: unknown;
  error?: unknown;
  history?: unknown;
  result?: unknown;
}

function envelopeOf(body: unknown): Envelope {
  return typeof body === "object" && body !== null ? (body as Envelope) : {};
}

function errorOf(env: Envelope): string {
  return typeof env.error === "string" && env.error.trim() !== ""
    ? env.error
    : "The change did not go through. Try again.";
}

const base = (workerId: string) => `/candidates/${encodeURIComponent(workerId)}/corrections`;

export async function fetchCorrectionHistory(
  workerId: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<CorrectionHistoryResult> {
  try {
    const res = await fetchImpl(base(workerId), {
      cache: "no-store",
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    const env = envelopeOf(await res.json());
    if (env.ok === true && Array.isArray(env.history)) {
      // The route parsed the API response through Zod; the shape is already the route's.
      const history = env.history as { items?: unknown };
      const items = Array.isArray(history.items) ? history.items : [];
      return { ok: true, items: items as CorrectionHistoryItem[] };
    }
    return { ok: false, error: errorOf(env) };
  } catch (err) {
    if (signal?.aborted) throw err;
    return { ok: false, error: "The edit log did not load. Try again." };
  }
}

export async function postCandidateCorrection(
  workerId: string,
  factKey: string,
  value: unknown,
  reason: { reason_code: CorrectionReasonCode; reason_text: string },
  fetchImpl: typeof fetch = fetch,
): Promise<CorrectionActionResult> {
  try {
    const res = await fetchImpl(base(workerId), {
      method: "POST",
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        fact_key: factKey,
        value,
        reason_code: reason.reason_code,
        reason_text: reason.reason_text,
      }),
    });
    const env = envelopeOf(await res.json());
    if (env.ok === true && typeof env.result === "object" && env.result !== null) {
      return { ok: true, result: env.result as CorrectionResult };
    }
    return { ok: false, error: errorOf(env) };
  } catch {
    return { ok: false, error: "The change did not reach the server. Try again." };
  }
}

export async function postCandidateRevert(
  workerId: string,
  factKey: string,
  reason: { reason_code: CorrectionReasonCode; reason_text: string },
  fetchImpl: typeof fetch = fetch,
): Promise<CorrectionActionResult> {
  try {
    const res = await fetchImpl(`${base(workerId)}/${encodeURIComponent(factKey)}/revert`, {
      method: "POST",
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(reason),
    });
    const env = envelopeOf(await res.json());
    if (env.ok === true && typeof env.result === "object" && env.result !== null) {
      return { ok: true, result: env.result as CorrectionResult };
    }
    return { ok: false, error: errorOf(env) };
  } catch {
    return { ok: false, error: "The revert did not reach the server. Try again." };
  }
}
