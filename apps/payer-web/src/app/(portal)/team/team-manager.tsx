"use client";

import { useState, useTransition, type FormEvent } from "react";
import type { OrgMemberView, OrgMemberStatus } from "../../../lib/org-members";
import type { OrgRole } from "../../../lib/auth/org-roles";
import { Badge, Button, Card, Input } from "../../../components/ds";
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
 */
const ROLE_TONE: Record<OrgRole, "brand" | "neutral"> = { owner: "brand", recruiter: "neutral" };
const STATUS_TONE: Record<OrgMemberStatus, "success" | "warning" | "neutral"> = {
  active: "success",
  invited: "warning",
  removed: "neutral",
};

export function TeamManager({ members }: { members: OrgMemberView[] }) {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onInvite(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const res = await inviteMemberAction({ email });
      setMessage(res.message);
      if (res.ok) setEmail("");
    });
  }

  function onRemove(memberId: string) {
    setMessage(null);
    startTransition(async () => {
      const res = await removeMemberAction({ memberId });
      setMessage(res.message);
    });
  }

  return (
    <>
      <section className="team-section">
        <h2 className="team-section__title">Invite a recruiter</h2>
        <form className="team-form" onSubmit={onInvite}>
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
          <p className="team-form__hint">
            Recruiters can post, search, and unlock. Billing &amp; user management stay with owners.
          </p>
          <div className="chrome-actions">
            <Button type="submit" variant="primary" loading={pending} aria-busy={pending}>
              {pending ? "Working…" : "Send invite"}
            </Button>
          </div>
        </form>
        <div aria-live="polite" className="team-form__status">
          {message ? (
            <Card variant="outline" className="team-note" style={{ marginTop: "var(--space-3)" }}>
              <p className="team-note__msg">{message}</p>
            </Card>
          ) : null}
        </div>
      </section>

      <section className="team-section">
        <h2 className="team-section__title">Members</h2>
        {members.length === 0 ? (
          <Card variant="flat" className="team-empty">
            No members yet. Invites you send appear here as “invited” until they accept.
          </Card>
        ) : (
          <table className="team-table">
            <thead>
              <tr>
                <th>Member</th>
                <th>Role</th>
                <th>Status</th>
                <th>Manage</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.memberId}>
                  <td className="bb-mono">
                    {m.emailMasked}
                    {m.isSelf ? <Badge tone="info" style={{ marginLeft: "var(--space-2)" }}>You</Badge> : null}
                  </td>
                  <td>
                    <Badge tone={ROLE_TONE[m.orgRole]}>{m.orgRole}</Badge>
                  </td>
                  <td>
                    <Badge tone={STATUS_TONE[m.status]}>{m.status}</Badge>
                  </td>
                  <td>
                    {m.isSelf || m.orgRole === "owner" ? (
                      <span className="team-table__muted">—</span>
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
        )}
      </section>
    </>
  );
}
