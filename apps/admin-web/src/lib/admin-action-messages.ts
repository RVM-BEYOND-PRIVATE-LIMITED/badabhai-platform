/**
 * The admin action copy catalogue (#2689 rule 3).
 *
 * Every failure a governed admin action can surface passes through here. The API's own text is
 * never rendered: a 4xx may carry a useful refusal, but it is ALSO a wire format that can quote
 * ids, field names or an intermediary's page, so it is used only to choose a sentence from this
 * catalogue and is then discarded. An unknown status, code or message gets {@link SAFE_ACTION_ERROR}.
 */

/** The line used when nothing more specific is known — never the API's own text. */
export const SAFE_ACTION_ERROR =
  "That action couldn't be completed. Check the details and try again.";

export const SESSION_ENDED = "Your session has ended. Reload the page and sign in again.";
export const NOT_ALLOWED = "Your role no longer has permission to do that.";
export const RECORD_GONE = "That record no longer exists. Refresh the page and try again.";
export const RECORD_CHANGED =
  "That record changed since you loaded it. Refresh the page and check it before trying again.";
export const TOO_MANY_REQUESTS =
  "Too many attempts just now. Wait a moment, then try again.";
export const SERVICE_UNAVAILABLE =
  "The admin service is unreachable right now. Try again shortly.";
export const INVALID_DETAILS = "Some details were refused. Check them and try again.";
export const ID_REFUSED = "That id is not valid, so nothing was sent to the admin API.";
export const DUPLICATE_ADMIN = "An admin with that email already exists.";
export const SELF_ACTION = "You can't do that to your own admin account.";
export const MFA_ALREADY_ON = "Two-step verification is already on. Reload to see its current state.";
export const MFA_ALREADY_OFF = "Two-step verification is already off. Reload to see its current state.";
export const PASSWORD_REFUSED = "That password can't be used here. Choose a different one.";
export const CUSTOMER_SUSPENDED_CREDITS =
  "That customer is suspended, so credits can't be granted. Reinstate the customer first.";
export const POSTING_CLOSED = "This posting is closed, so it can't be edited.";

/**
 * A small closed set of server `code` values we understand. Unknown codes fall through to the
 * status copy, then to {@link SAFE_ACTION_ERROR}.
 */
const CODE_COPY: Readonly<Record<string, string>> = {
  unauthorized: SESSION_ENDED,
  forbidden: NOT_ALLOWED,
  not_found: RECORD_GONE,
  conflict: RECORD_CHANGED,
  validation_failed: INVALID_DETAILS,
  rate_limited: TOO_MANY_REQUESTS,
  too_many_requests: TOO_MANY_REQUESTS,
  last_active_super_admin:
    "You can't remove the last active super admin. Give another admin that role first.",
  self_action: "You can't do that to your own admin account.",
  already_decided: "That decision was already recorded. Reload to see the current state.",
  stale_expected_status: RECORD_CHANGED,
  illegal_transition: "That change isn't allowed from the record's current state. Reload and retry.",
};

/**
 * Refusals whose MEANING is stable even though the server does not send a code. Matched against
 * the API text only; the matched text is never rendered.
 */
const MESSAGE_RULES: readonly { readonly match: RegExp; readonly copy: string }[] = [
  {
    match: /last active (super[_ ]?admin|super admin)/i,
    copy: "You can't remove the last active super admin. Give another admin that role first.",
  },
  {
    match: /already exists|duplicate/i,
    copy: DUPLICATE_ADMIN,
  },
  {
    match: /already on/i,
    copy: MFA_ALREADY_ON,
  },
  {
    match: /already off/i,
    copy: MFA_ALREADY_OFF,
  },
  {
    match: /(cannot|can't|may not).*(yourself|your own|self)/i,
    copy: SELF_ACTION,
  },
  {
    match: /too common|password (is|was) refused|password policy/i,
    copy: PASSWORD_REFUSED,
  },
  {
    match: /suspended.*credit|credit.*suspended/i,
    copy: CUSTOMER_SUSPENDED_CREDITS,
  },
  {
    match: /closed.*(edit|cannot)|cannot.*closed/i,
    copy: POSTING_CLOSED,
  },
  {
    match: /id is not valid|nothing was sent/i,
    copy: ID_REFUSED,
  },
  {
    match: /not found|does not exist|no such/i,
    copy: RECORD_GONE,
  },
  {
    match: /already|stale|changed since|version/i,
    copy: RECORD_CHANGED,
  },
  {
    match: /reason/i,
    copy: "Add a clear reason before trying again.",
  },
  {
    match: /valid|invalid|malformed|required/i,
    copy: INVALID_DETAILS,
  },
];

/** Copy for a status, when no more specific sentence applies. */
function statusCopy(status: number): string {
  if (status === 400 || status === 422) return INVALID_DETAILS;
  if (status === 401) return SESSION_ENDED;
  if (status === 403) return NOT_ALLOWED;
  if (status === 404) return RECORD_GONE;
  if (status === 409) return RECORD_CHANGED;
  if (status === 429) return TOO_MANY_REQUESTS;
  if (status >= 500 || status === 0) return SERVICE_UNAVAILABLE;
  return SAFE_ACTION_ERROR;
}

/**
 * The ONE mapping from an API refusal to operator copy. `code` and `message` are inputs to the
 * lookup only; neither can reach the screen.
 */
export function adminActionErrorCopy(input: {
  status?: number;
  code?: string;
  message?: string;
}): string {
  // A 5xx or a transport failure is never the operator's refusal to interpret, whatever text
  // happened to travel with it (a 500 body can quote SQL, a stack or an internal hostname).
  if ((input.status ?? 0) >= 500 || input.status === 0) return SERVICE_UNAVAILABLE;

  const code = input.code?.trim().toLowerCase();
  if (code && Object.hasOwn(CODE_COPY, code)) return CODE_COPY[code]!;

  const message = input.message ?? "";
  for (const rule of MESSAGE_RULES) {
    if (rule.match.test(message)) return rule.copy;
  }

  return statusCopy(input.status ?? 0);
}
