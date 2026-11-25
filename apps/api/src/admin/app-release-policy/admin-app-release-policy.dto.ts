import type { AdminSetAppReleasePolicyDto } from "../../app-version/app-version.dto";
import type { AppReleasePolicyAdminView } from "../../app-version/app-version.service";

/**
 * #3048 — the admin contract for the minimum supported app build. The body schema lives beside
 * the service (`AdminSetAppReleasePolicySchema` in `app-version.dto.ts`) so the public and admin
 * halves share one set of bounds.
 */
export type AdminSetAppReleasePolicyBody = AdminSetAppReleasePolicyDto;

/** `GET /admin/app-release-policy`: all four app × platform rows. */
export interface AdminAppReleasePolicyListResponse {
  readonly policies: readonly AppReleasePolicyAdminView[];
}

/** `PUT /admin/app-release-policy`: the row after the call, and whether it changed. */
export interface AdminSetAppReleasePolicyResponse {
  readonly changed: boolean;
  readonly policy: AppReleasePolicyAdminView;
}
