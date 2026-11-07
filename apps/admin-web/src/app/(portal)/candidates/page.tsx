import { requireCapability } from "../../../lib/auth";
import { can } from "../../../lib/auth/capabilities";
import { readCandidateRecord } from "../../../lib/candidate-detail";
import { CANDIDATE_PARAM } from "./candidate-drawer-model";
import { CandidatesBank } from "./candidates-bank";
import type { InitialCandidateRecord } from "./candidate-drawer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Candidates" };

/**
 * Candidates — the data bank (A7, #2577).
 *
 * The page's own job is the capability gate and the DRAWER's server read (so `?c=<id>` survives
 * a reload, a shared link and a new tab). The list itself belongs to `CandidatesBank`, a client
 * component: the universal search term is deliberately body-only (ADR-0062 §3.6), so a server
 * page fetch would have to put it in the address to survive a reload. Filters, order and pages
 * still live in the URL; the term lives only in the POST body (and in the viewer's local saved
 * views, which never leave the browser).
 *
 * NAME POSTURE is measured from the rows the API actually returned (`identityPosture` inside the
 * bank), not predicted from the capability, so a capped read renders as capped and an analyst
 * never sees a Name column.
 */
export default async function CandidatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireCapability("read_candidates");

  const sp = await searchParams;
  const one = (value: string | string[] | undefined) =>
    (Array.isArray(value) ? value[0] : value)?.trim() || undefined;

  // The drawer: open while `?c=<id>` is in the address. Read beside the list (the list is a
  // separate client read), never after it.
  const openId = one(sp[CANDIDATE_PARAM]);
  const openRead = openId ? readCandidateRecord(openId) : null;
  const initialRecord: InitialCandidateRecord | null =
    openId && openRead ? { id: openId, result: await openRead } : null;

  // The address as plain strings for the first client render. `c` is ignored by the list parser.
  const initialParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(sp)) {
    const first = one(value);
    if (first !== undefined) initialParams[key] = first;
  }

  return (
    <div className="page page--list">
      <CandidatesBank
        initialParams={initialParams}
        initialRecord={initialRecord}
        entitled={can(session.capabilities, "read_identity")}
        canReveal={can(session.capabilities, "reveal_pii")}
        canEdit={can(session.capabilities, "edit_candidates")}
        canReadEvents={can(session.capabilities, "read_events")}
        canManageAccount={can(session.capabilities, "manage_worker_account")}
      />
    </div>
  );
}
