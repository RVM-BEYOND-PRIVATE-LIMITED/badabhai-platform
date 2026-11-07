import { z } from "zod";
import { uuidSchema } from "@badabhai/validators";
import {
  createCandidateCorrection,
  readCorrectionHistory,
} from "../../../../../lib/candidate-corrections";
import { describeCorrectionRouteError } from "../../../../../lib/candidate-correction-http";
import {
  isJsonRequest,
  isSameOriginRequest,
  readBodyText,
} from "../../../../../lib/same-origin-request";
import { CORRECTION_REASON_CODES } from "../../../../../lib/candidate-edit-model";

/**
 * `GET|POST /candidates/<id>/corrections` — the drawer's correction read and write (A7, #2577).
 *
 * GET is the reason history (`edit_candidates`, same-origin): it is the only response that
 * carries the admin-authored reason TEXT, which is why the drawer only asks for it for a session
 * the page already knows may edit. POST is one fact, one reason; the drawer sends one request per
 * changed field in a section.
 *
 * A route rather than a Server Action for the reason the record read gives: a pending action is
 * discarded by a URL change (the drawer's own `?c=` moves), and the refresh that follows re-reads
 * up to 100 names against the admin's hourly budget. `Cache-Control: no-store` on every answer.
 */
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 32 * 1024;

const createSchema = z
  .object({
    fact_key: z.string().trim().min(1).max(80),
    value: z.unknown(),
    reason_code: z.enum(CORRECTION_REASON_CODES),
    reason_text: z.string().trim().min(15).max(500),
  })
  .strict();

const ALLOWED_FETCH_SITES = new Set(["same-origin", "none"]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && !ALLOWED_FETCH_SITES.has(site)) {
    return answer(403, { ok: false, error: "This history can only be read from the portal." });
  }
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) {
    return answer(400, { ok: false, error: "That worker id is not valid." });
  }
  try {
    const history = await readCorrectionHistory(id);
    return answer(200, { ok: true, history });
  } catch (err) {
    const refusal = describeCorrectionRouteError(err);
    return answer(refusal.status, { ok: false, error: refusal.error });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return answer(403, { ok: false, error: "A correction can only be made from the portal." });
  }
  if (!isJsonRequest(request)) {
    return answer(415, { ok: false, error: "A correction must be sent as a JSON request." });
  }
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) {
    return answer(400, { ok: false, error: "That worker id is not valid." });
  }
  const text = await readBodyText(request, MAX_BODY_BYTES);
  if (text === null) {
    return answer(413, { ok: false, error: "That correction is too large." });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return answer(400, { ok: false, error: "That correction could not be read." });
  }
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return answer(400, {
      ok: false,
      error: "Choose a reason of 15 to 500 characters and a value for the field.",
    });
  }

  try {
    const result = await createCandidateCorrection(id, parsed.data.fact_key, parsed.data.value, {
      reason_code: parsed.data.reason_code,
      reason_text: parsed.data.reason_text,
    });
    return answer(200, { ok: true, result });
  } catch (err) {
    const refusal = describeCorrectionRouteError(err);
    return answer(refusal.status, { ok: false, error: refusal.error });
  }
}

function answer(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
