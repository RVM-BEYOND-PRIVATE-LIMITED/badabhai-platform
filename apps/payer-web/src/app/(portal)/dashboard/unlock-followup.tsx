import { Icon } from "@badabhai/icons";
import { getDueUnlockOutcomes } from "../../../lib/payer-api";
import { RetryButton } from "../../../components/retry-button";
import { UnlockFollowupList } from "./unlock-followup-list";

/**
 * #2984 §4 — the company-only "Did you hire this person?" panel.
 *
 * SERVER READ, CLIENT ANSWERS. This component owns the due-list read and its three states:
 *  - 404 (`off`) — `UNLOCK_FOLLOWUP_ENABLED` is off, or this surface is not the company's:
 *    render NOTHING (no empty band, no dead control).
 *  - 429 / 5xx / parse failure (`retry`) — one neutral Retry, never the API's reason.
 *  - `ok` — one row per due unlock; answering is the client child's job.
 *
 * The rows are faceless: ids never reach the DOM, and no name/phone is on the wire.
 */
export async function UnlockFollowup() {
  const due = await getDueUnlockOutcomes();

  if (due.status === "off") return null;
  if (due.status === "retry") {
    return (
      <section className="panel dash-panel" aria-labelledby="unlock-followup-heading">
        <div className="panel__head">
          <div className="panel__text">
            <h2 className="panel__title" id="unlock-followup-heading">
              Did you hire this person?
            </h2>
            <p className="panel__sub">Tell us what happened with the contacts you unlocked.</p>
          </div>
        </div>
        <div className="panel__body">
          <div className="state state--error">
            <span className="state__icon">
              <Icon name="warning-circle" />
            </span>
            <h3 className="state__title">We couldn’t load your follow-ups</h3>
            <p className="state__body">
              Nothing has changed. Retry to see which contacts are due for an answer.
            </p>
            <div className="state__actions">
              <RetryButton />
            </div>
          </div>
        </div>
      </section>
    );
  }

  if (due.items.length === 0) return null;

  return (
    <section className="panel dash-panel" aria-labelledby="unlock-followup-heading">
      <div className="panel__head">
        <div className="panel__text">
          <div className="dash-panel__titlerow">
            <h2 className="panel__title" id="unlock-followup-heading">
              Did you hire this person?
            </h2>
            <span className="dash-count">{due.items.length}</span>
          </div>
          <p className="panel__sub">Tell us what happened with the contacts you unlocked.</p>
        </div>
      </div>
      <div className="panel__body">
        <UnlockFollowupList
          items={due.items.map(({ unlockId, grantedAt, outcome }) => ({
            unlockId,
            grantedAt,
            outcome,
          }))}
        />
      </div>
    </section>
  );
}
