"use client";

import { useState, useTransition, type FormEvent } from "react";
import type { OrgMemberView } from "../../../lib/org-members";
import { Badge, Button, Card, Input, Select } from "../../../components/ds";
import { inviteMemberAction, removeMemberAction } from "./actions";

/**
 * Client TEAM-management scaffold (Owner-only). Runs in the BROWSER and sees NO secret; it calls
 * the Owner-gated Server Actions, which RE-ASSERT `requireOwner` (the page gate is not the only
 * check) and bind to the server-held org. The data source is a STUB — the list is empty and the
 * invite/remove actions return a neutral "not yet available" until the org API lands.
 *
 * PII: members are opaque id + coarse label only. The invite email is typed locally and sent to
 * the action; it is never rendered back into the member list or any result message.
 */
export function TeamManager({ members }: { members: OrgMemberView[] }) {
  const [email, setEmail] = useState("");
  const [orgRole, setOrgRole] = useState("recruiter");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onInvite(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const res = await inviteMemberAction({ email, orgRole });
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
        <h2 className="team-section__title">Invite a member</h2>
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
          <Select
            id="invite-role"
            label="Role"
            value={orgRole}
            onChange={(e) => setOrgRole(e.target.value)}
          >
            <option value="recruiter">Recruiter — post / search / unlock / contact</option>
            <option value="owner">Owner — billing &amp; user management too</option>
          </Select>
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
            No additional members yet. Invites you send will appear here once the org directory
            API is connected.
          </Card>
        ) : (
          <table className="team-table">
            <thead>
              <tr>
                <th>Member</th>
                <th>Role</th>
                <th>Manage</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.memberId}>
                  <td className="bb-mono">{m.label}</td>
                  <td>
                    <Badge tone={m.orgRole === "owner" ? "success" : "neutral"}>{m.orgRole}</Badge>
                  </td>
                  <td>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={pending}
                      onClick={() => onRemove(m.memberId)}
                    >
                      Remove
                    </Button>
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
