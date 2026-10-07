import { Icon } from "@badabhai/icons";
import { Card } from "../components/ds";
import { PortalLink } from "../components/portal-link";

/**
 * Neutral 404 (ADR-0019 Phase 1) — matches the role-guard neutral style.
 *
 * Reached for an unknown route AND for a `notFound()` from the role/tenant guards
 * (e.g. an `employer` hitting an agency-only section, or a not-owned resource). It is
 * deliberately INDISTINGUISHABLE from "does not exist" — no "forbidden" oracle, no leak
 * that a gated section exists, no PII. A Server Component (no client state needed).
 *
 * UI-1: the centred neutral card is now the DS `Card` + the shared `.state` block instead of
 * the private `chrome-card`/`chrome-title`/`chrome-sub`/`chrome-actions` set. The COPY is
 * unchanged on purpose: it is the no-oracle wording, not decoration, and the icon is a neutral
 * wayfinding glyph — nothing that hints "forbidden" rather than "absent".
 *
 * It renders OUTSIDE the portal shell (a guard's `notFound()` lands here, above the `(portal)`
 * layout), so there is no bar or status line — but its link is a `PortalLink`, and the dot on the
 * button still answers the click while the Dashboard loads.
 */
export default function NotFound() {
  return (
    <div className="login-wrap">
      <Card>
        <div className="state">
          <span className="state__icon">
            <Icon name="compass" />
          </span>
          <h1 className="state__title">Not found</h1>
          <p className="state__body">
            This page doesn&rsquo;t exist, or isn&rsquo;t available to your account.
          </p>
          <div className="state__actions">
            <PortalLink
              className="bb-btn bb-btn--primary"
              href="/dashboard"
              pendingLabel="Dashboard"
            >
              <span>Go to dashboard</span>
            </PortalLink>
          </div>
        </div>
      </Card>
    </div>
  );
}
