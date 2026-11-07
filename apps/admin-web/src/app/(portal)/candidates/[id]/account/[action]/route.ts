import {
  isAdminForbidden,
  isAdminRequestError,
  isAdminUnauthorized,
} from "../../../../../../lib/admin-http";
import {
  isWorkerAccountAction,
  performWorkerAccountAction,
} from "../../../../../../lib/candidate-account";
import {
  isJsonRequest,
  isSameOriginRequest,
  readBodyText,
} from "../../../../../../lib/same-origin-request";
import { z } from "zod";
import { uuidSchema } from "@badabhai/validators";

/**
 * `POST /candidates/<id>/account/<action>` — one governed worker account action from the
 * candidate drawer (A7, #2577; API #2562). Same-origin and JSON only; the API holds the role,
 * reason and audit rules.
 *
 * The 503 contract is important: it means the worker's sessions could not be ended, and NOTHING
 * should be reported as done. The drawer shows the message with Retry, which is safe.
 */
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;

const bodySchema = z.object({ reason_text: z.string().trim().min(15).max(500) }).strict();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; action: string }> },
): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return answer(403, { ok: false, error: "This action can only be taken from the portal." });
  }
  if (!isJsonRequest(request)) {
    return answer(415, { ok: false, error: "This action must be sent as a JSON request." });
  }
  const { id, action } = await params;
  if (!uuidSchema.safeParse(id).success) {
    return answer(400, { ok: false, error: "That worker id is not valid." });
  }
  if (!isWorkerAccountAction(action)) {
    return answer(400, { ok: false, error: "That account action is not one this page offers." });
  }
  const text = await readBodyText(request, MAX_BODY_BYTES);
  if (text === null) return answer(413, { ok: false, error: "That reason is too large." });
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return answer(400, { ok: false, error: "That action could not be read." });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return answer(400, {
      ok: false,
      error: "Explain the reason in 15 to 500 characters.",
    });
  }

  try {
    const result = await performWorkerAccountAction(id, action, parsed.data.reason_text);
    return answer(200, { ok: true, result });
  } catch (err) {
    if (isAdminUnauthorized(err)) {
      return answer(401, { ok: false, error: "Your session has ended. Sign in again." });
    }
    if (isAdminForbidden(err)) {
      return answer(403, { ok: false, error: "Your role cannot manage worker accounts." });
    }
    if (isAdminRequestError(err)) {
      if (err.status === 400) return answer(400, { ok: false, error: err.message });
      if (err.status === 404)
        return answer(404, { ok: false, error: "That candidate no longer exists." });
      if (err.status === 409) return answer(409, { ok: false, error: err.message });
      if (err.status === 503) {
        return answer(503, {
          ok: false,
          error: "The worker's sessions could not be ended, so nothing changed. Retrying is safe.",
        });
      }
    }
    return answer(502, { ok: false, error: "The action did not reach the server. Try again." });
  }
}

function answer(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
