"use client";

import { useState, useTransition, type FormEvent } from "react";
import type { OrgMemberView } from "../../../lib/org-members";
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
      <section className="section">
        <h2>Invite a member</h2>
        <form className="form" onSubmit={onInvite}>
          <div className="field">
            <label htmlFor="invite-email">
              Email <span className="req">*</span>
            </label>
            <input
              id="invite-email"
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="recruiter@yourcompany.example"
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label htmlFor="invite-role">Role</label>
            <select
              id="invite-role"
              className="input"
              value={orgRole}
              onChange={(e) => setOrgRole(e.target.value)}
            >
              <option value="recruiter">Recruiter — post / search / unlock / contact</option>
              <option value="owner">Owner — billing &amp; user management too</option>
            </select>
          </div>
          <div className="btn-row">
            <button className="btn" type="submit" disabled={pending} aria-busy={pending}>
              {pending ? "Working…" : "Send invite"}
            </button>
          </div>
        </form>
        <div aria-live="polite">
          {message ? (
            <p className="note" style={{ marginTop: 12 }}>
              {message}
            </p>
          ) : null}
        </div>
      </section>

      <section className="section">
        <h2>Members</h2>
        {members.length === 0 ? (
          <div className="empty">
            No additional members yet. Invites you send will appear here once the org directory
            API is connected.
          </div>
        ) : (
          <table>
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
                  <td className="mono">{m.label}</td>
                  <td>
                    <span className={m.orgRole === "owner" ? "badge badge-ok" : "badge"}>
                      {m.orgRole}
                    </span>
                  </td>
                  <td>
                    <button
                      className="btn secondary"
                      type="button"
                      disabled={pending}
                      onClick={() => onRemove(m.memberId)}
                    >
                      Remove
                    </button>
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
