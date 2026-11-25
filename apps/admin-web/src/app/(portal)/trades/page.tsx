import Link from "next/link";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { requireCapability } from "../../../lib/auth";
import { can } from "../../../lib/auth/capabilities";
import { isAdminRequestError } from "../../../lib/admin-http";
import {
  getHeldCampusRoles,
  getTradeCatalogue,
  getTradeRelease,
  type HeldCampusRole,
  type TradeRow,
} from "../../../lib/trade-release";
import { PageHeader } from "../../../components/page-header";
import { HeldRolesPanel, type HeldRolesState } from "./held-roles-panel";
import { TradesScreen } from "./trades-screen";

export const dynamic = "force-dynamic";
export const metadata = { title: "Trades" };

const DESCRIPTION =
  "Every declared trade, its department and wave, and the two release switches the owner can flip without a deploy.";

/**
 * #3023 — the trade catalogue. Every authenticated admin may read the list (`read_entities`).
 * The switches are behind `manage_trade_release` on the API for BOTH the read and the write
 * (super_admin, #3067), so a session without it sees the catalogue read-only — names,
 * departments, kinds and waves — and never makes a read that would 403. The switch read is made
 * on the server so a failed read renders an honest error state instead of an empty table. The
 * held-role list is a separate read: its 404 is the feature switch, not a failure.
 */
export default async function TradesPage() {
  const session = await requireCapability("read_entities");
  const canManage = can(session.capabilities, "manage_trade_release");

  let rows: TradeRow[] | null = null;
  if (canManage) {
    try {
      rows = await getTradeRelease();
    } catch {
      rows = null;
    }
  } else {
    rows = getTradeCatalogue();
  }

  let held: HeldCampusRole[] = [];
  let heldState: HeldRolesState = "ready";
  try {
    held = await getHeldCampusRoles();
  } catch (err) {
    heldState = isAdminRequestError(err) && err.status === 404 ? "off" : "error";
  }

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
          canManage={canManage}
          held={held}
          heldState={heldState}
        />
      )}
    </div>
  );
}
