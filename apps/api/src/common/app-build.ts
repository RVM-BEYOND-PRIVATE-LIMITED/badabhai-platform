import { WORKER_FEEDBACK_APP_BUILD_MAX } from "@badabhai/types";

/**
 * The build stamp every worker-app request carries (#966): a commit SHA, a build number, or the
 * literal `dev` from a local build. Exported rather than inlined at the call site — header names
 * are always constants in this repo (`INTERNAL_SERVICE_TOKEN_HEADER`, `TEST_LOGIN_TOKEN_HEADER`,
 * …), so a rename is one edit and a typo is a compile error rather than a silently absent header.
 */
export const APP_BUILD_HEADER = "x-app-build";

/**
 * The charset half of the contract. Together with the length check in {@link sanitizeAppBuild}
 * this is `^[A-Za-z0-9._+-]{1,WORKER_FEEDBACK_APP_BUILD_MAX}$` — split in two so the bound comes
 * from the shared constant instead of being re-typed into a regex literal that cannot track it.
 *
 * Deliberately NO whitespace, no `/`, no `<`: a build id is a sha, a `1.4.2+318`, or `dev`.
 * Anything else is a client that is not the client we ship.
 */
const APP_BUILD_CHARSET = /^[A-Za-z0-9._+-]+$/;

/**
 * Normalise the `x-app-build` header into something safe to store and to event.
 *
 * SANITIZE, NEVER REJECT — AND NEVER THROW. This header is untrusted client input, but it is
 * TELEMETRY: it is not part of any request contract and no business decision reads it. Rejecting
 * a submission because its build stamp was malformed would throw away a worker's typed feedback
 * over a field nobody asked them for, which is the wrong failure direction. Fail-closed governs
 * validation, privacy, auth and AI safety (CLAUDE.md §3); a build stamp is none of those.
 *
 * A value that is absent, non-string, empty, over-long, or outside the charset becomes `null`,
 * which reads on the admin screen as "unknown build" — the honest answer.
 *
 * `raw` is `unknown` rather than `string | undefined` because the two callers this serves are a
 * Nest `@Headers()` param (a string in practice) and, defensively, anything a future raw
 * `req.headers[...]` read hands over — Node hands back `string[]` for a repeated header. Typing
 * it honestly is what lets the single `typeof` check below be the only guard needed.
 */
export function sanitizeAppBuild(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > WORKER_FEEDBACK_APP_BUILD_MAX) return null;
  return APP_BUILD_CHARSET.test(trimmed) ? trimmed : null;
}
