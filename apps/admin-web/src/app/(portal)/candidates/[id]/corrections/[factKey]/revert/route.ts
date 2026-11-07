import { z } from "zod";
import { uuidSchema } from "@badabhai/validators";
import { revertCandidateCorrection } from "../../../../../../../lib/candidate-corrections";
import { describeCorrectionRouteError } from "../../../../../../../lib/candidate-correction-http";
import {
  isJsonRequest,
  isSameOriginRequest,
  readBodyText,
} from "../../../../../../../lib/same-origin-request";
import { CORRECTION_REASON_CODES } from "../../../../../../../lib/candidate-edit-model";

/**
 * `POST /candidates/<id>/corrections/<factKey>/revert` — undo ONE live admin correction (A7,
 * #2577). A reason is required, exactly as for a correction; the API writes the worker's previous
 * value back through the same store writer and marks the override not live. A 409 means there is
 * no live correction to revert.
 */
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;

const revertSchema = z
  .object({
    reason_code: z.enum(CORRECTION_REASON_CODES),
    reason_text: z.string().trim().min(15).max(500),
  })
  .strict();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; factKey: string }> },
): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return answer(403, { ok: false, error: "A correction can only be reverted from the portal." });
  }
  if (!isJsonRequest(request)) {
    return answer(415, { ok: false, error: "A revert must be sent as a JSON request." });
  }
  const { id, factKey } = await params;
  if (!uuidSchema.safeParse(id).success) {
    return answer(400, { ok: false, error: "That worker id is not valid." });
  }
  if (!/^[a-z0-9_]+$/.test(factKey)) {
    return answer(400, { ok: false, error: "That field is not one that can be reverted." });
  }
  const text = await readBodyText(request, MAX_BODY_BYTES);
  if (text === null) return answer(413, { ok: false, error: "That revert is too large." });
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return answer(400, { ok: false, error: "That revert could not be read." });
  }
  const parsed = revertSchema.safeParse(json);
  if (!parsed.success) {
    return answer(400, {
      ok: false,
      error: "Choose a reason of 15 to 500 characters before reverting.",
    });
  }

  try {
    const result = await revertCandidateCorrection(id, factKey, parsed.data);
    return answer(200, { ok: true, result });
  } catch (err) {
    const refusal = describeCorrectionRouteError(err);
    return answer(refusal.status, { ok: false, error: refusal.error });
  }
}

function answer(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
