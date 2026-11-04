"use server";

import { z } from "zod";
import {
  adminFetch,
  isAdminForbidden,
  isAdminRequestError,
  isAdminUnauthorized,
} from "../../../lib/admin-http";
import { PII_REVEAL_REASON_CODES } from "../../../lib/admin-action-vocabulary";
import {
  REVEAL_BAD_ID,
  REVEAL_FAILED,
  REVEAL_FORBIDDEN,
  REVEAL_NOTE_REFUSED,
  REVEAL_NO_REASON,
  REVEAL_REFUSED,
  REVEAL_SIGNED_OUT,
  REVEAL_UNAVAILABLE,
  type RevealPhoneOutcome,
} from "./reveal-messages";

/**
 * Reveal ONE worker's phone — the existing reason-gated `POST /admin/workers/:id/reveal-contact`
 * (ADR-0025 Decision 4: `reveal_pii`, support + super admin), from the Candidates drawer (A7,
 * #2577). The API holds every control: the role, the closed reason code, the note's PII check,
 * the per-admin hourly and daily cap, the `admin.pii_viewed` audit row BEFORE the decrypt, and
 * `Cache-Control: no-store`. This action only carries the operator's choice to it.
 *
 *  - The actor is the SESSION (the cookie's token); the target is the path id. No body field
 *    names either.
 *  - The phone exists only in the returned value, for the drawer to show. Nothing here logs it,
 *    caches it or puts it anywhere else, and no error message ever carries it.
 *  - NO ORACLE: every neutral 404 gets the one sentence `REVEAL_UNAVAILABLE` (reveal-messages.ts).
 */

const revealResponseSchema = z.object({ worker_id: z.string(), phone: z.string().min(1) });

export async function revealCandidatePhoneAction(
  workerId: string,
  reasonCode: string,
  note: string,
): Promise<RevealPhoneOutcome> {
  if (!z.string().uuid().safeParse(workerId).success) return { ok: false, error: REVEAL_BAD_ID };
  const reason = z.enum(PII_REVEAL_REASON_CODES).safeParse(reasonCode);
  if (!reason.success) return { ok: false, error: REVEAL_NO_REASON };

  try {
    const res = await adminFetch(
      `/admin/workers/${encodeURIComponent(workerId)}/reveal-contact`,
      {
        method: "POST",
        body: { reason_code: reason.data, note: note.trim() },
        schema: revealResponseSchema,
      },
    );
    return { ok: true, phone: res.phone };
  } catch (err) {
    return { ok: false, error: describeRevealError(err) };
  }
}

/** Operator copy for a failed reveal — never the API's own text (a 404's would be an oracle). */
function describeRevealError(err: unknown): string {
  if (isAdminUnauthorized(err)) return REVEAL_SIGNED_OUT;
  if (isAdminForbidden(err)) return REVEAL_FORBIDDEN;
  if (isAdminRequestError(err)) {
    if (err.status === 404) return REVEAL_UNAVAILABLE;
    if (err.status === 400) return noteRefused(err.body) ? REVEAL_NOTE_REFUSED : REVEAL_REFUSED;
  }
  return REVEAL_FAILED;
}

/** Did the API's validation refusal name the note? (`issues[].path`, ZodValidationPipe's shape.) */
function noteRefused(body: Record<string, unknown> | undefined): boolean {
  const issues = body?.issues;
  return (
    Array.isArray(issues) &&
    issues.some(
      (i) => typeof i === "object" && i !== null && (i as { path?: unknown }).path === "note",
    )
  );
}
