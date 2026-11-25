"use server";

import { isAdminRequestError } from "../../../lib/admin-http";
import { describeAdminActionError } from "../../../lib/describe-admin-error";
import { setAppReleasePolicy } from "../../../lib/app-release-policy";
import {
  APP_RELEASE_NOT_READY,
  appReleasePolicyBodySchema,
  fieldErrorsFromIssues,
  type AppReleaseIssue,
  type SaveAppReleasePolicyResult,
} from "../../../lib/app-release-policy-model";

const CHECK_FIELDS = "Some values were refused. Check the highlighted fields.";

/** `ZodValidationPipe` serves each issue's path JOINED ("latest_build"); accept that and arrays. */
function issuesFromBody(body: Record<string, unknown> | undefined): AppReleaseIssue[] {
  const raw = body?.issues;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as { path?: unknown; message?: unknown };
    const path = Array.isArray(record.path)
      ? record.path.map(String)
      : typeof record.path === "string"
        ? record.path.split(".")
        : [];
    return [{ path, message: typeof record.message === "string" ? record.message : "" }];
  });
}

/**
 * The server's own words for a REFUSAL are shown here, deliberately, as on the Trades screen
 * (`trades/actions.ts`): a signed-in super admin is being told why this row was not changed. A
 * 5xx or a transport failure is not a refusal to interpret, so it goes through the safe copy.
 */
function refusalMessage(err: unknown): string {
  if (isAdminRequestError(err) && err.status >= 400 && err.status < 500) return err.message;
  return describeAdminActionError(err);
}

/**
 * `PUT /admin/app-release-policy` — set one app and platform's minimum and latest build (#3058).
 *
 * Re-validates with the server's own bounds before anything is sent, and sends EVERY field with
 * the row's `message_key` as it was read. The actor is the session cookie `adminFetch` carries;
 * no admin id is ever in the body.
 *
 * Failures: a 503 is the migration not being applied yet, said as such; any other 4xx is the
 * server refusing this change, so its own message is shown to the signed-in super admin (a 400's
 * issues are also placed on their fields); a 5xx or a transport failure gets the safe copy.
 */
export async function saveAppReleasePolicyAction(
  input: unknown,
): Promise<SaveAppReleasePolicyResult> {
  const parsed = appReleasePolicyBodySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      kind: "validation",
      error: CHECK_FIELDS,
      fieldErrors: fieldErrorsFromIssues(parsed.error.issues),
    };
  }

  try {
    const res = await setAppReleasePolicy(parsed.data);
    return { ok: true, changed: res.changed, policy: res.policy };
  } catch (err) {
    if (isAdminRequestError(err) && err.status === 503) {
      return { ok: false, kind: "not_ready", error: APP_RELEASE_NOT_READY };
    }
    if (isAdminRequestError(err) && err.status >= 400 && err.status < 500) {
      const fieldErrors = err.status === 400 ? fieldErrorsFromIssues(issuesFromBody(err.body)) : {};
      return {
        ok: false,
        kind: "refused",
        error: refusalMessage(err),
        ...(Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {}),
      };
    }
    return { ok: false, kind: "error", error: describeAdminActionError(err) };
  }
}
