"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { AdminActionButton } from "../../../components/admin-action-button";
import { AdminActionResultBanner } from "../../../components/admin-action-result-banner";
import { inviteAdminAction } from "./actions";
import { ADMIN_ROLES, ROLE_LABELS, type AdminRole } from "../../../lib/auth/capabilities";
import type { AdminActionOutcome } from "../../../lib/admin-action-result";

/** Invite a new admin by work email + role (`manage_admins`). Status defaults to `pending`. */
export function InviteAdminForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AdminRole>("analyst");
  const [outcome, setOutcome] = useState<AdminActionOutcome | null>(null);
  const emailId = useId();
  const roleId = useId();

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  function handleSettled(o: AdminActionOutcome) {
    setOutcome(o);
    if (o.ok) {
      // The refresh repopulates the admin table. `outcome` is component state, so the
      // accept link SURVIVES it — which matters, because the link cannot be fetched
      // again and losing it would strand the invitee.
      router.refresh();
      setEmail("");
    }
  }

  return (
    <section className="panel" aria-labelledby="ad-invite">
      <div className="panel__head">
        <h2 className="panel__title" id="ad-invite">
          Invite an admin
        </h2>
        <p className="panel__sub">
          Creates a `pending` admin and mints a one-time accept link, shown here once for
          you to share. An email is sent only when real invite delivery is configured.
        </p>
      </div>
      <form className="form" onSubmit={(e) => e.preventDefault()}>
        <div className="form-grid">
          <label className="field" htmlFor={emailId}>
            <span className="field__label">
              Work email<span className="req">*</span>
            </span>
            <input
              id={emailId}
              className="field__input"
              type="email"
              autoComplete="off"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={email !== "" && !emailValid ? true : undefined}
            />
          </label>
          <label className="field" htmlFor={roleId}>
            <span className="field__label">Role</span>
            <select
              id={roleId}
              className="field__input"
              value={role}
              onChange={(e) => setRole(e.target.value as AdminRole)}
            >
              {ADMIN_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-actions">
          <AdminActionButton
            label="Invite admin"
            confirmLabel={`Confirm invite for ${email || "this address"}?`}
            variant="primary"
            disabled={!emailValid}
            action={() => inviteAdminAction({ email, role })}
            onSettled={handleSettled}
          />
        </div>
      </form>
      {outcome && (
        <AdminActionResultBanner
          outcome={outcome}
          timelineHref="/events?eventName=admin.action_performed"
        />
      )}
      {outcome?.ok && outcome.acceptUrl ? (
        <AcceptLinkPanel url={outcome.acceptUrl} expiresAt={outcome.acceptExpiresAt} />
      ) : null}
    </section>
  );
}

/**
 * The one-time accept link, shown once, right after a successful invite (#1494).
 *
 * THIS IS HOW ONBOARDING WORKS BY DEFAULT. `ADMIN_INVITES_ENABLE_REAL` is off unless
 * explicitly enabled and an email provider is configured, so in the ordinary case no mail
 * is sent and this link is the only way the invitee can ever reach the accept page.
 *
 * A BEARER SECRET, treated like one: rendered for the operator to copy, never logged,
 * never put in an analytics event, never persisted. It cannot be fetched again —
 * re-inviting a pending admin mints a fresh link and invalidates this one.
 */
function AcceptLinkPanel({ url, expiresAt }: { url: string; expiresAt?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      // Long enough to be seen, short enough that the button does not lie about a
      // clipboard the operator may have overwritten since.
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied (insecure origin, permission policy). The link is on screen and
      // selectable, so the operator can still copy it by hand — say nothing misleading.
      setCopied(false);
    }
  }

  return (
    <div className="alert alert--ok" role="status">
      <div className="alert__text">
        <p className="alert__title">Send this link to the invitee</p>
        <p className="alert__body">
          Shown once. No email was sent unless real invite delivery is configured
          {expiresAt ? <> — the link expires {new Date(expiresAt).toLocaleString()}</> : null}.
        </p>
        {/* readOnly, not disabled: an operator must be able to select it by hand when the
            clipboard API is unavailable. */}
        <input
          className="field__input"
          type="text"
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Invite accept link"
        />
      </div>
      <button type="button" className="btn" onClick={copy}>
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}
