"use server";

import { z } from "zod";
import { adminFetch, AdminRequestError } from "../../../lib/admin-http";
import {
  MALFORMED_LINK_ERROR,
  NEUTRAL_ACCEPT_ERROR,
  SERVICE_UNAVAILABLE_ERROR,
} from "./messages";

/**
 * Redeem an admin invite (#1494) — `POST /admin/invites/accept`, the one admin route that
 * is deliberately UNGUARDED, because the invitee has no session yet and the single-use
 * token IS the credential.
 *
 * THE TOKEN NEVER REACHES THE BROWSER'S JS. It arrives in the URL, is read server-side in
 * the page component, and is handed to this action — which runs on the server. No client
 * component ever receives it, consistent with how `adminFetch` keeps the API origin off the
 * client bundle.
 *
 * ACCEPTING MINTS NO SESSION, by design: the invitee signs in normally afterwards (emailed
 * code → TOTP enrolment), so there is exactly one door into a session. Nothing here is
 * stored, and there is nothing for a caller to persist.
 */

/** 20–128 chars, matching `AdminInviteAcceptSchema` so a mangled link fails here, not there. */
const tokenSchema = z.string().trim().min(20).max(128);

const acceptedSchema = z.object({
  admin_id: z.string().min(1),
  role: z.string().min(1),
  status: z.literal("active"),
  next: z.literal("sign_in"),
});

export type AcceptOutcome =
  | { ok: true; role: string }
  | { ok: false; error: string };

export async function acceptInviteAction(input: { token: string }): Promise<AcceptOutcome> {
  const parsed = tokenSchema.safeParse(input.token);
  // Caught here rather than sent: a wrong-length token cannot be a real invite, and
  // forwarding it would spend an IP rate-limit slot the invitee may need for the real link.
  if (!parsed.success) return { ok: false, error: MALFORMED_LINK_ERROR };

  try {
    const res = await adminFetch("/admin/invites/accept", {
      method: "POST",
      body: { token: parsed.data },
      // The route is unguarded — there is no cookie to attach, and asking for one would
      // fail before the request left.
      public: true,
      schema: acceptedSchema,
    });
    return { ok: true, role: res.role };
  } catch (err) {
    if (err instanceof AdminRequestError) {
      // 401 fuses invalid / expired / already-used. 400 is a mangled link. Everything
      // else is the service being unwell, which is safe to say plainly.
      if (err.status === 401) return { ok: false, error: NEUTRAL_ACCEPT_ERROR };
      if (err.status === 400) return { ok: false, error: MALFORMED_LINK_ERROR };
    }
    return { ok: false, error: SERVICE_UNAVAILABLE_ERROR };
  }
}
