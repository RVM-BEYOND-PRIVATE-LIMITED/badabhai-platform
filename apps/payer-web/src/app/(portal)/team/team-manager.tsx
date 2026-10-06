"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { Icon } from "@badabhai/icons";
import type { OrgMemberView, OrgMemberStatus } from "../../../lib/org-members";
import type { OrgRole } from "../../../lib/auth/org-roles";
import { Badge, Button, Dialog, Input } from "../../../components/ds";
import { RetryButton } from "../../../components/retry-button";
import { inviteMemberAction, removeMemberAction } from "./actions";

/**
 * Client TEAM-management UI (Owner-only), wired to the LIVE org API (ADR-0027 / B5.5). Runs in the
 * BROWSER and sees NO secret; it calls the Owner-gated Server Actions, which RE-ASSERT
 * `requireOwner` and bind to the server-held org. Invites are RECRUITER-only (the API rejects
 * `owner`; co-owner/transfer is a later capability), so there is no role picker.
 *
 * PII: members render with a SERVER-MASKED email (`h•••@domain`) + role + status only — never a
 * raw address. The invite email is typed locally and sent to the action; it is never rendered back
 * into the member list or any result message. A member cannot remove themselves or an owner (the
 * affordance is hidden and the API re-checks).
 *
 * UI-1: both blocks are `panel`s — the invite form on the shared `form` spine, the directory as a
 * `panel--table` whose body is the `table` primitive with an empty `state` that says what to do
 * next. The action result is a TONED `alert` band — success (green ✓) or danger (red ⚠) driven by
 * the action's `ok` flag, mirroring accept-invite. The message string is already PII-safe (it
 * never echoes an email), so tone conveys outcome without becoming an enumeration oracle.
 *
 * `members === null` means the list read FAILED (F30): the directory shows the standard in-place
 * error with a Retry, and the invite form stays. On a phone the table is re-laid as one card per
 * member so Remove is on screen without scrolling it sideways (F38, globals.css); because CSS
 * re-display can drop a table's semantics in some engines, every part states its role.
 *
 * REMOVE ASKS FIRST: a row's Remove opens the generic DS Dialog ("Remove <masked email> from your
 * team?" — Cancel / Remove); only its Remove calls the action. The Dialog hands focus back to the
 * trigger on close, but a confirmed removal disables every Remove while it runs — so once the
 * dialog is closed AND the removal has settled, focus is put back on that row's Remove (or, if the
 * row is gone, on the Members heading). Keyboard users land where they were.
 */
const ROLE_TONE: Record<OrgRole, "brand" | "neutral"> = { owner: "brand", recruiter: "neutral" };
/** The directory's heading — also the NAME of its scroll region (aria-labelledby). */
const MEMBERS_HEADING_ID = "team-members-title";
/** A row's Remove — where focus returns after its confirm. The member id is the org's own. */
const removeButtonId = (memberId: string) => `team-remove-${memberId}`;
const STATUS_TONE: Record<OrgMemberStatus, "success" | "warning" | "neutral"> = {
  active: "success",
  invited: "warning",
  removed: "neutral",
};

export function TeamManager({ members }: { members: OrgMemberView[] | null }) {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  // The member a Remove is waiting to be confirmed for — the confirm dialog is open while set.
  const [confirming, setConfirming] = useState<OrgMemberView | null>(null);
  const [pending, startTransition] = useTransition();
  // The control focus returns to once the confirm has closed and any removal has settled.
  const focusBack = useRef<string | null>(null);

  useEffect(() => {
    if (confirming !== null || pending || focusBack.current === null) return;
    const id = focusBack.current;
    focusBack.current = null;
    (document.getElementById(id) ?? document.getElementById(MEMBERS_HEADING_ID))?.focus();
  }, [confirming, pending]);

  function onInvite(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const res = await inviteMemberAction({ email });
      setMessage({ ok: res.ok, text: res.message });
      if (res.ok) setEmail("");
    });
  }

  function askRemove(member: OrgMemberView) {
    setMessage(null);
    focusBack.current = removeButtonId(member.memberId);
    setConfirming(member);
  }

  function confirmRemove() {
    const member = confirming;
    if (member === null) return;
    setConfirming(null);
    startTransition(async () => {
      const res = await removeMemberAction({ memberId: member.memberId });
      setMessage({ ok: res.ok, text: res.message });
    });
  }

  return (
    <>
      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">Invite a recruiter</h2>
        </div>
        <div className="panel__body">
          <form className="form" onSubmit={onInvite}>
            <Input
              id="invite-email"
              label="Email"
              type="email"
              iconLeft="envelope"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="recruiter@yourcompany.example"
              autoComplete="off"
            />
            <p className="form__hint">
              Recruiters can post, search, and unlock. Billing &amp; user management stay with
              owners.
            </p>
            <div className="form-actions">
              <Button type="submit" variant="primary" loading={pending} aria-busy={pending}>
                {pending ? "Working…" : "Send invite"}
              </Button>
            </div>
          </form>
          <div aria-live="polite" className="form-status">
            {message ? (
              <div className={`alert ${message.ok ? "alert--success" : "alert--danger"}`}>
                <i
                  className={`ph-fill ${message.ok ? "ph-check-circle" : "ph-warning-circle"} alert__icon`}
                  aria-hidden="true"
                />
                <div className="alert__text">
                  <p className="alert__body">{message.text}</p>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section className="panel panel--table">
        <div className="panel__head">
          <div className="panel__text">
            {/* tabIndex -1: focus can be PUT here (after a removed row is gone), never Tabbed to. */}
            <h2 className="panel__title" id={MEMBERS_HEADING_ID} tabIndex={-1}>
              Members
            </h2>
            <p className="panel__sub">
              Everyone who can sign in to this hiring desk. Emails stay masked.
            </p>
          </div>
        </div>
        <div className="panel__body">
          {members === null ? (
            <div className="state state--error">
              <span className="state__icon">
                <Icon name="warning-circle" />
              </span>
              <h3 className="state__title">We couldn&rsquo;t load your team</h3>
              <p className="state__body">
                Nothing has changed — everyone still has the access they had. You can still invite a
                recruiter above; retry to see the list.
              </p>
              <div className="state__actions">
                <RetryButton />
              </div>
            </div>
          ) : members.length === 0 ? (
            <div className="state">
              <span className="state__icon">
                <i className="ph-fill ph-users-three" aria-hidden="true" />
              </span>
              <h3 className="state__title">No members yet</h3>
              <p className="state__body">
                Invites you send appear here as “invited” until they accept.
              </p>
              <div className="state__actions">
                {/* Same-page recovery: the invite field is directly above. */}
                <a className="bb-btn bb-btn--secondary bb-btn--sm" href="#invite-email">
                  Invite a recruiter
                </a>
              </div>
            </div>
          ) : (
            <div
              className="tablewrap"
              tabIndex={0}
              role="region"
              aria-labelledby={MEMBERS_HEADING_ID}
            >
              <table className="table" role="table">
                <thead role="rowgroup">
                  <tr role="row">
                    <th scope="col" role="columnheader">
                      Member
                    </th>
                    <th scope="col" role="columnheader">
                      Role
                    </th>
                    <th scope="col" role="columnheader">
                      Status
                    </th>
                    <th scope="col" role="columnheader">
                      Manage
                    </th>
                  </tr>
                </thead>
                <tbody role="rowgroup">
                  {members.map((m) => (
                    <tr key={m.memberId} role="row">
                      <td className="mono" role="cell">
                        {m.emailMasked}
                        {m.isSelf ? (
                          <>
                            {" "}
                            <Badge tone="info">You</Badge>
                          </>
                        ) : null}
                      </td>
                      <td role="cell">
                        <Badge tone={ROLE_TONE[m.orgRole]}>{m.orgRole}</Badge>
                      </td>
                      <td role="cell">
                        <Badge tone={STATUS_TONE[m.status]}>{m.status}</Badge>
                      </td>
                      <td className="rowactions" role="cell">
                        {m.isSelf || m.orgRole === "owner" ? (
                          // Decorative placeholder: this row has no remove affordance (own row
                          // or an owner). Hidden from AT so the cell reads as empty, not as "—".
                          <span aria-hidden="true">—</span>
                        ) : (
                          <Button
                            id={removeButtonId(m.memberId)}
                            variant="secondary"
                            size="sm"
                            disabled={pending}
                            onClick={() => askRemove(m)}
                          >
                            Remove
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* Remove asks first — the generic DS Dialog (never the credit-spend confirm). */}
      <Dialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={confirming ? `Remove ${confirming.emailMasked} from your team?` : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmRemove}>
              Remove
            </Button>
          </>
        }
      >
        They will lose access to this hiring desk.
      </Dialog>
    </>
  );
}
