import Link from "next/link";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { requireCapability } from "../../../lib/auth";
import { can } from "../../../lib/auth/capabilities";
import { isAdminRequestError } from "../../../lib/admin-http";
import {
  getHeldCampusRoles,
  getTradeRelease,
  type HeldCampusRole,
  type TradeReleaseRow,
} from "../../../lib/trade-release";
import { PageHeader } from "../../../components/page-header";
import { HeldRolesPanel, type HeldRolesState } from "./held-roles-panel";
import { TradesScreen } from "./trades-screen";

export const dynamic = "force-dynamic";
export const metadata = { title: "Trades" };

const DESCRIPTION =
  "Every declared trade, its department and wave, and the two release switches the owner can flip without a deploy.";

/**
 * #3023 — the trade catalogue. Every authenticated admin may read it (`read_entities`); only a
 * session holding `manage_postings` may change a switch. The list is read on the server so a
 * failed read renders an honest error state instead of an empty table. The held-role list is a
 * separate read: its 404 is the feature switch, not a failure.
 */
export default async function TradesPage() {
  const session = await requireCapability("read_entities");

  let rows: TradeReleaseRow[] | null = null;
  try {
    rows = await getTradeRelease();
  } catch {
    rows = null;
  }

  let held: HeldCampusRole[] = [];
  let heldState: HeldRolesState = "ready";
  try {
    held = await getHeldCampusRoles();
  } catch (err) {
    heldState = isAdminRequestError(err) && err.status === 404 ? "off" : "error";
  }

  const canWrite = can(session.capabilities, "manage_postings");

  return (
    <div className="page page--list">
      <PageHeader title="Trades" description={DESCRIPTION} />

      {rows === null ? (
        <>
          <section className="panel">
            <div className="state state--error">
              <h2 className="state__title">Trades are unavailable</h2>
              <p className="state__body">
                The catalogue did not load. That is a fault on our side, not an empty list.
              </p>
              <div className="state__actions">
                <Link className="btn btn--ghost" href="/trades">
                  <Icon name={ACTION_ICON.retry} />
                  Retry
                </Link>
              </div>
            </div>
          </section>
          <HeldRolesPanel roles={held} state={heldState} />
        </>
      ) : (
        <TradesScreen
          rows={rows}
          canWrite={canWrite}
          held={held}
          heldState={heldState}
        />
      )}
    </div>
  );
}
