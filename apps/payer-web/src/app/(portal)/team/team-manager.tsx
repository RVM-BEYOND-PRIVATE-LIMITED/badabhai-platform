"use client";

import { useState, useTransition, type FormEvent } from "react";
import type { OrgMemberView, OrgMemberStatus } from "../../../lib/org-members";
import type { OrgRole } from "../../../lib/auth/org-roles";
import { Badge, Button, Input } from "../../../components/ds";
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
 */
const ROLE_TONE: Record<OrgRole, "brand" | "neutral"> = { owner: "brand", recruiter: "neutral" };
const STATUS_TONE: Record<OrgMemberStatus, "success" | "warning" | "neutral"> = {
  active: "success",
  invited: "warning",
  removed: "neutral",
};

export function TeamManager({ members }: { members: OrgMemberView[] }) {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function onInvite(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const res = await inviteMemberAction({ email });
      setMessage({ ok: res.ok, text: res.message });
      if (res.ok) setEmail("");
    });
  }

  function onRemove(memberId: string) {
    setMessage(null);
    startTransition(async () => {
      const res = await removeMemberAction({ memberId });
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
                  className={`ph ${message.ok ? "ph-check-circle" : "ph-warning-circle"} alert__icon`}
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
          <h2 className="panel__title">Members</h2>
          <p className="panel__sub">
            Everyone who can sign in to this hiring desk. Emails stay masked.
          </p>
        </div>
        <div className="panel__body">
          {members.length === 0 ? (
            <div className="state">
              <span className="state__icon">
                <i className="ph ph-users-three" aria-hidden="true" />
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
            <div className="tablewrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Member</th>
                    <th scope="col">Role</th>
                    <th scope="col">Status</th>
                    <th scope="col">Manage</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.memberId}>
                      <td className="mono">
                        {m.emailMasked}
                        {m.isSelf ? (
                          <>
                            {" "}
                            <Badge tone="info">You</Badge>
                          </>
                        ) : null}
                      </td>
                      <td>
                        <Badge tone={ROLE_TONE[m.orgRole]}>{m.orgRole}</Badge>
                      </td>
                      <td>
                        <Badge tone={STATUS_TONE[m.status]}>{m.status}</Badge>
                      </td>
                      <td className="rowactions">
                        {m.isSelf || m.orgRole === "owner" ? (
                          // Decorative placeholder: this row has no remove affordance (own row
                          // or an owner). Hidden from AT so the cell reads as empty, not as "—".
                          <span aria-hidden="true">—</span>
                        ) : (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={pending}
                            onClick={() => onRemove(m.memberId)}
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
    </>
  );
}
