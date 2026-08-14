import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * LEGACY PROFILE ROUTE → permanently consolidated into `/account` (BL-6 / DU-1: the two pages
 * rendered the identical identity panel + {@link AccountForm} + agent-only KYC/bank section,
 * gated on the same `requirePayer()` session, differing only in title copy). Product decision
 * (2026-08-14): `/account` is the single canonical route; `/profile` is kept ONLY so old
 * links/bookmarks still resolve — it `redirect()`s server-side to `/account`.
 *
 * No session is read and no data is rendered here. The portal layout (`(portal)/layout.tsx`)
 * already calls `requirePayer()` for every route in this group before this component runs, and
 * `/account/page.tsx` re-asserts it independently on the destination — the auth gate is
 * unchanged by this redirect, never weakened or duplicated client-side.
 */
export default function ProfileRedirect(): never {
  redirect("/account");
}
