# Worker Referrals API — Reference

> Scope: the worker app's referral routes — `POST /referrals/attribute` (after consent) and
> `GET /referrals/helper` (the pre-code screen, #2753 item 12). Source of truth is the code:
> `apps/api/src/referrals/referral-attribution.controller.ts`, `referral-attribution.service.ts`,
> `referral-helper.controller.ts` and `referral-helper-name.service.ts`. Consumer: the worker app
> (`apps/worker-app`). Owner: Backend Platform. The resolver `GET /r/:code` and the agency invite
> routes are described in [payer-agency-api-reference.md](./payer-agency-api-reference.md).

A referral code is 12 lowercase hex characters, carried by `/i/<code>` and `/r/<code>` links. It
is a bearer token: the server never logs it or puts it in an event.

## `POST /referrals/attribute`

Worker-authed (`Authorization: Bearer <worker token>`, `WorkerAuthGuard`); the worker id always
comes from the token. Body `{ "code": "<12 hex>", "source"?: "app_link" | "install_referrer" |
"custom_scheme" | "unknown" }`; a malformed code is a `400`. Capped per address
(`REFERRAL_ATTRIBUTE_MAX_PER_IP_PER_HOUR`, default 20 an hour; over the cap or with Redis down,
`429`).

The answer is always `200 { "ok": true }`, byte for byte, sent without waiting for the
attribution: the client learns neither whether the code was valid nor who invited the worker.

What happens behind it (never visible in the response):

- Only with an active consent (fail-closed). The worker's invite space (`invites`) is tried
  first, then the agency's (`agency_invites`). A résumé-QR code stops before either.
- **Came-from (#2753 item 12).** A successful attribution also writes the worker's
  `worker_origins` row: `referrer` for a worker's invite, `partner` for an agency's invite, with
  the code as `ref`. **First origin wins:** an origin he already has (for example `institute` from
  the Campus link, or an earlier code) is never overwritten. A refused or neutral attribution,
  and a résumé-QR scan, write no origin. A failed origin write never changes the attribution.

## `GET /referrals/helper?code=<code>`

> **Behind `REFERRAL_HELPER_NAME_ENABLED` (default off). The owner must approve before it is
> switched on.** It reverses the rule `POST /referrals/attribute` is built on (no oracle) and
> opens a code-to-name lookup to anyone, before sign-in. The screen's copy waits for a lawyer's
> check: "[Name] helped you make this profile. Confirm with the OTP only if the details are yours
> and you have not paid anyone."

Unauthenticated: the screen comes before the OTP. Do not send a token.

| Switch | Answer                                                                                                |
| ------ | ----------------------------------------------------------------------------------------------------- |
| off    | `404`, the API's error envelope (`error.message` "Not found"). Nothing is counted, looked up or read. |
| on     | `200 { "display_name": string \| null }`, with `Cache-Control: no-store`.                             |

With the switch on:

- `display_name` is the agency's **company name** for a live agency code: an agency invite not
  yet accepted, or an agency link that has not expired, of an agency whose account is active.
- It is `null` for every other code, with the **same `200` body**: a worker referrer's code (no
  name a referrer agreed to show exists yet; a worker's stored name is never shown), an unknown
  code, an accepted (spent) invite, an expired link, a suspended or archived agency, an
  employer's code, a malformed code (the `/r/:code` shape check, nothing trimmed), a missing or
  repeated `code` parameter, and any server failure. Every case runs the same one lookup.
- Capped per address with the same limiter and cap as `POST /referrals/attribute`
  (`REFERRAL_ATTRIBUTE_MAX_PER_IP_PER_HOUR`), in its own bucket: over the cap, `429`.
- No worker's name or phone, and nothing else, is ever returned. No name is logged.

Render rule for the app: show the line only when `display_name` is a non-empty string; on
`null`, `404` or any error, show the screen without a name.
