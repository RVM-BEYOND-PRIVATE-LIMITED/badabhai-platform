# Design — Org-member RBAC (Owner vs Recruiter) in `apps/payer-web`

Status: **Scaffold landed, INERT until the org claim lands.** Owner: Prakash (RVM). Backend
wiring owner: Divyanshu (org API + signed-session org-role claim).

## 1. Why

The payer portal has ONE role today — the **account role** `employer | agent`
([roles.ts](../../apps/payer-web/src/lib/auth/roles.ts)) — which decides *which product
surface* (company vs agency) a session sees. It does **not** express *what a given person inside
that org may do*. A company needs at least two member roles:

- **Owner** — runs billing/wallet and manages who is on the team.
- **Recruiter** — does the hiring work (post / search / unlock / contact) but not billing or
  user management.

This is a **second, orthogonal role dimension** layered on top of the account role. The account
role is **left unchanged**.

## 2. The two dimensions

| Dimension | Source | Values | Decides |
| --- | --- | --- | --- |
| Account role | `PayerSession.role` (signed session) | `employer` \| `agent` | Which product surface / labeling |
| **Org role** (new) | `getOrgRole(session)` | `owner` \| `recruiter` | What this member may do inside the org |

They compose freely: an `employer · owner`, an `employer · recruiter`, an `agent · owner`, etc.

## 3. Seam — type + `getOrgRole`

[`lib/auth/org-roles.ts`](../../apps/payer-web/src/lib/auth/org-roles.ts).

```ts
export type OrgRole = "owner" | "recruiter";
export function getOrgRole(session: PayerSession): OrgRole
```

**Fail-closed (least privilege).** The signed session carries **no org-role claim today**, so
`getOrgRole` defaults to `recruiter`. The only non-default path is a **dev-only preview override**
`PAYER_DEV_ORG_ROLE=owner|recruiter`, honored **only** when
[`isDevEnv()`](../../packages/config/src/shared.ts) is true (raw `NODE_ENV` is `development`/`test`).
In staging/production the override is ignored — a stray env var can never unlock Owner.

> `// STUB: org-role not yet in the signed session — wire to Divyanshu's org API + session claim
> when it lands (XB-A).`

`isDevEnv` is imported from the **frontend-safe** `@badabhai/config/shared` subpath (zod-only, no
secrets) — never the secret-bearing root, honoring the server/public config split.

## 4. Gates — server-enforced, neutral 404

Mirrors `roles.ts` / `requireAgent()`:

- `requireOwner()` — admits **Owner**; a **Recruiter** gets a neutral `notFound()` (404). No
  "forbidden" oracle, no leak that the Owner section exists.
- `requireRecruiter()` — **Owner ⊇ Recruiter**, so it admits **both** (an Owner sees everything a
  Recruiter sees); any value outside the known set fails closed.

**The gate is the authorization; the nav is only an affordance.** A Recruiter who navigates
straight to `/credits` or `/team` still hits `requireOwner()` server-side and is 404'd — hiding
the nav link is convenience, never the security boundary.

## 5. Surfaces

| Surface | Route | Gate |
| --- | --- | --- |
| Billing / wallet | [`/credits`](../../apps/payer-web/src/app/(portal)/credits/page.tsx) | `requireOwner()` |
| User management | [`/team`](../../apps/payer-web/src/app/(portal)/team/page.tsx) | `requireOwner()` (+ each action re-asserts it) |
| Post / search / unlock / contact | dashboard, postings, applicants, capacity | shared (any member) |

Nav ([`(portal)/layout.tsx`](../../apps/payer-web/src/app/(portal)/layout.tsx)) shows the
**Credits** + **Team** links only when `getOrgRole(session) === "owner"`, and surfaces the org
role as a coarse affordance badge. Authorization stays in the gates.

## 6. User-management data — clearly STUBBED

[`lib/org-members.ts`](../../apps/payer-web/src/lib/org-members.ts) +
[`team/actions.ts`](../../apps/payer-web/src/app/(portal)/team/actions.ts).

There is **no org/member API yet**, so the scaffold is deliberately inert:

- `listOrgMembers()` returns `[]` — the Owner UI renders an **empty state**, never fabricated
  members. `OrgMemberView` is a clearly-marked STUB shape, **not** the backend contract.
- `inviteOrgMember` / `removeOrgMember` are no-ops returning a neutral "not available yet".
- The Server Actions validate input (email/role/id via zod), **re-assert `requireOwner`**
  (defence-in-depth), and forward to the stub. The invited email is validated then handed off —
  never persisted, logged, or echoed back.

When the backend lands, each stub call becomes a single `payerFetch("/payer/org/members…")` and
`getOrgRole` reads the session claim — no UI rewrite.

## 7. Security properties

- **Server-enforced** — every Owner surface is gated by `requireOwner()` (page + every action),
  never by nav visibility.
- **Fail-closed** — no claim ⇒ Recruiter (least privilege); the dev override is `isDevEnv`-gated.
- **No-oracle** — a denied member gets a neutral 404, identical to an unknown route.
- **No PII / no real member data** — opaque ids + coarse labels only; the directory is empty
  until the backend lands.
- **XB-A** — the org is the server-held session; a client never supplies an org/member id.

## 8. Deferred (backend, with Divyanshu)

1. Org-role **claim** on the signed session (`session-token.ts`) + the issuing login flow.
2. `/payer/org/members` **list / invite / remove** endpoints + their PII-free DTOs.
3. Replace the `getOrgRole` STUB body with the session-claim read; replace the `org-members.ts`
   stub calls with `payerFetch`.

Until (1)–(3), the scaffold is **inert and fail-closed**: every member resolves to `recruiter`,
so the Owner surfaces are reachable only via the `isDevEnv`-gated dev override.
