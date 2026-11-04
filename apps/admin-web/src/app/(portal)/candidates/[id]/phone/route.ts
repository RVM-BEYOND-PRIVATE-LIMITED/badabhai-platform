import { z } from "zod";
import { uuidSchema } from "@badabhai/validators";
import {
  adminFetch,
  isAdminForbidden,
  isAdminRequestError,
  isAdminUnauthorized,
} from "../../../../../lib/admin-http";
import { PII_REVEAL_REASON_CODES } from "../../../../../lib/admin-action-vocabulary";
import {
  isJsonRequest,
  isSameOriginRequest,
  readBodyText,
} from "../../../../../lib/same-origin-request";
import {
  REVEAL_BAD_ID,
  REVEAL_FAILED,
  REVEAL_FORBIDDEN,
  REVEAL_NOTE_REFUSED,
  REVEAL_NOT_SAME_ORIGIN,
  REVEAL_NO_REASON,
  REVEAL_REFUSED,
  REVEAL_SIGNED_OUT,
  REVEAL_UNAVAILABLE,
  type RevealPhoneOutcome,
} from "../../reveal-messages";

/**
 * `POST /candidates/<id>/phone` — reveal ONE worker's phone, for the Candidates drawer (A7, #2577),
 * through the EXISTING reason-gated `POST /admin/workers/:id/reveal-contact` (ADR-0025 Decision 4:
 * `reveal_pii`, support + super admin). The API holds every control: the role, the closed reason
 * code, the note's PII check, the per-admin hourly and daily cap, the `admin.pii_viewed` audit row
 * BEFORE the decrypt, and `Cache-Control: no-store`. This route only carries the operator's choice
 * to it, server-side, with the admin's token from the httpOnly cookie (`adminFetch`).
 *
 * ── WHY A ROUTE AND NOT A SERVER ACTION ─────────────────────────────────────────────────
 * The record read's reason (`../record/route.ts`), with more at stake. Next runs a server action
 * through the router's queue, and a Back or Forward while one is pending (ACTION_RESTORE) DISCARDS
 * it and then dispatches a full refresh: /candidates re-renders, re-reading the 50-name list
 * against the admin's name budget (an `admin.identity_viewed` row each), and the revealed phone is
 * dropped — inviting a second audited reveal. A plain fetch from the drawer never enters that queue.
 *
 * ── WHAT THE SERVER ACTION CHECKED FOR FREE, CHECKED HERE ───────────────────────────────
 * Before anything is read or sent, every one refused with its own status and static sentence:
 *  - a request from anywhere but a page of this portal → 403 (`Sec-Fetch-Site` same-origin when
 *    sent, `Origin` the portal's own when sent — `lib/same-origin-request.ts`, which also says why a
 *    header an older browser does not send is allowed);
 *  - a body that is not `application/json` → 415 (no other site can send JSON here);
 *  - a body over {@link MAX_BODY_BYTES} → 413, read no further.
 * Then the request itself: the path id a uuid (the API's own check), and the body exactly
 * `{ reason_code, note }` — the code from the API's closed list, the explanation as the confirm
 * sends it. Nothing else rides along: no actor id (the actor is the session), no worker id (the
 * path names the worker).
 *
 * ── WHAT IT ANSWERS ─────────────────────────────────────────────────────────────────────
 * `{ ok: true, phone }` or `{ ok: false, error }`, where `error` is one of the reveal's own sentences
 * (`reveal-messages.ts`) — never the API's text: every neutral 404 is the ONE sentence
 * `REVEAL_UNAVAILABLE`, so the drawer is no oracle either. `Cache-Control: no-store` on every
 * answer. The phone exists only in a 200's body; nothing here logs or keeps it.
 */
export const dynamic = "force-dynamic";

/**
 * The largest body read. The API takes an explanation of at most 280 characters, which is at most
 * 1,680 bytes of JSON (six per escaped character); anything longer than this can only be refused,
 * and it is refused as the explanation, the one part of the body an operator writes.
 */
const MAX_BODY_BYTES = 4096;

/** The drawer's request: the API's closed reason code and the explanation — nothing else. */
const revealRequestSchema = z
  .object({ reason_code: z.enum(PII_REVEAL_REASON_CODES), note: z.string() })
  .strict();

const revealResponseSchema = z.object({ worker_id: z.string(), phone: z.string().min(1) });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isSameOriginRequest(request)) return refuse(403, REVEAL_NOT_SAME_ORIGIN);
  if (!isJsonRequest(request)) return refuse(415, REVEAL_REFUSED);
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return refuse(400, REVEAL_BAD_ID);
  const text = await readBodyText(request, MAX_BODY_BYTES);
  if (text === null) return refuse(413, REVEAL_NOTE_REFUSED);
  const parsed = revealRequestSchema.safeParse(parseJson(text));
  if (!parsed.success) {
    // A missing or unlisted reason is the operator's to fix; any other shape is not the drawer's.
    const reasonOnly = parsed.error.issues.every((issue) => issue.path[0] === "reason_code");
    return refuse(400, reasonOnly ? REVEAL_NO_REASON : REVEAL_REFUSED);
  }

  try {
    const res = await adminFetch(`/admin/workers/${encodeURIComponent(id)}/reveal-contact`, {
      method: "POST",
      body: { reason_code: parsed.data.reason_code, note: parsed.data.note.trim() },
      schema: revealResponseSchema,
    });
    return answer(200, { ok: true, phone: res.phone });
  } catch (err) {
    const { status, error } = describeRevealError(err);
    return refuse(status, error);
  }
}

function answer(status: number, outcome: RevealPhoneOutcome): Response {
  return Response.json(outcome, { status, headers: { "Cache-Control": "no-store" } });
}

function refuse(status: number, error: string): Response {
  return answer(status, { ok: false, error });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * A failed reveal: the status and the operator's sentence — never the API's own text (a 404's
 * would be an oracle). The same mapping the drawer's server action had.
 */
function describeRevealError(err: unknown): { status: number; error: string } {
  if (isAdminUnauthorized(err)) return { status: 401, error: REVEAL_SIGNED_OUT };
  if (isAdminForbidden(err)) return { status: 403, error: REVEAL_FORBIDDEN };
  if (isAdminRequestError(err)) {
    if (err.status === 404) return { status: 404, error: REVEAL_UNAVAILABLE };
    if (err.status === 400) {
      return { status: 400, error: noteRefused(err.body) ? REVEAL_NOTE_REFUSED : REVEAL_REFUSED };
    }
  }
  return { status: 502, error: REVEAL_FAILED };
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
