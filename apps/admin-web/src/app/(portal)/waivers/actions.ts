"use server";

import { z } from "zod";
import { describeAdminActionError } from "../../../lib/describe-admin-error";
import { setWaiver } from "../../../lib/waivers";

const inputSchema = z.object({
  scope: z.enum(["company", "job"]),
  companyId: z.string().uuid(),
  postingId: z.string().uuid().optional(),
  active: z.boolean(),
  reasonText: z.string().trim().min(15).max(500),
});

export type SetWaiverResult =
  | { ok: true; changed: boolean; message: string }
  | { ok: false; error: string };

export async function setWaiverAction(input: unknown): Promise<SetWaiverResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the waiver." };
  }
  try {
    const res = await setWaiver(parsed.data);
    return {
      ok: true,
      changed: res.changed,
      message: res.changed
        ? res.active
          ? "Waiver set."
          : "Waiver cleared."
        : "Nothing changed — the waiver was already in that state.",
    };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}
