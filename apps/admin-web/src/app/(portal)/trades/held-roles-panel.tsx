"use client";

import { useState } from "react";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import type { HeldCampusRole } from "../../../lib/trade-release";
import { heldRolesByCount, heldRolesText } from "../../../lib/trade-release-view";

export type HeldRolesState = "ready" | "off" | "error";

/**
 * #3014 / #3023 — the Campus role names the mapping could not translate. Read-only: a role name
 * and a count, never a person. "Copy list" produces the short list an admin sends for a ruling.
 * A 404 or a switched-off route says "Not switched on yet"; it is not a broken screen.
 */
export function HeldRolesPanel({
  roles,
  state,
}: {
  roles: readonly HeldCampusRole[];
  state: HeldRolesState;
}) {
  const [copied, setCopied] = useState(false);
  const ordered = heldRolesByCount(roles);

  async function copy() {
    try {
      await navigator.clipboard.writeText(heldRolesText(ordered));
    } catch {
      setCopied(false);
      return;
    }
    setCopied(true);
  }

  return (
    <section className="panel" aria-labelledby="held-roles-heading">
      <div className="panel__head panel__head--row">
        <div>
          <h2 className="panel__title" id="held-roles-heading">
            Held Campus roles
          </h2>
          <p className="panel__sub">
            Role names Campus holds that do not map to a trade yet. Names and counts only.
          </p>
        </div>
        {state === "ready" && ordered.length > 0 ? (
          <button type="button" className="btn btn--ghost" onClick={() => void copy()}>
            <Icon name={ACTION_ICON.copy} />
            {copied ? "Copied" : "Copy list"}
          </button>
        ) : null}
      </div>
      <div className="panel__body">
        {state === "off" ? (
          <div className="state">
            <h3 className="state__title">Not switched on yet</h3>
            <p className="state__body">
              The held-role list arrives with the Campus trade mapping. Until its switch is on,
              there is nothing to show here.
            </p>
          </div>
        ) : state === "error" ? (
          <div className="state state--error">
            <h3 className="state__title">The held list could not be read</h3>
            <p className="state__body">
              That is a fault on our side, not an empty list. Refresh the page to try again.
            </p>
          </div>
        ) : ordered.length === 0 ? (
          <div className="state">
            <h3 className="state__title">No held roles</h3>
            <p className="state__body">
              Every Campus role name maps to a trade in this catalogue.
            </p>
          </div>
        ) : (
          <>
            <ul className="chips" aria-label="Held Campus roles">
              {ordered.map((role) => (
                <li className="chip" key={role.role_label}>
                  {role.role_label} · {role.count}
                </li>
              ))}
            </ul>
            <p className="field__help" role="status" aria-live="polite">
              {copied ? "Copied the held roles to the clipboard." : ""}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
