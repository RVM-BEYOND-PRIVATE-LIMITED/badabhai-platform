import { requireSession } from "../../lib/auth";
import { ROLE_LABELS, can } from "../../lib/auth/capabilities";
import { NAV } from "../../components/nav-model";
import { Shell } from "../../components/shell";
import { SignOutButton } from "../../components/sign-out-button";

// Per-request. A cached admin shell could show one operator another's navigation.
export const dynamic = "force-dynamic";

/**
 * The authenticated portal.
 *
 * `requireSession()` runs on EVERY render of every page in this group, and it asks the
 * server rather than reading the cookie's claims — so a revoked or expired session is
 * caught on the next navigation, not whenever the JWT happens to expire.
 *
 * The nav is filtered by the server-supplied capability list. That is presentation only;
 * each route enforces `@RequireAdminRole` for itself, so a hand-typed URL gains nothing.
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  const sections = NAV.map((section) => ({
    ...section,
    items: section.items.filter((i) => !i.capability || can(session.capabilities, i.capability)),
    // A section whose every item was filtered out is dropped below, rather than rendering
    // an empty heading that reads like a broken menu.
  })).filter((section) => section.items.length > 0);

  return (
    <Shell
      sections={sections}
      roleLabel={ROLE_LABELS[session.role]}
      adminId={session.adminId}
      onSignOut={<SignOutButton />}
    >
      {children}
    </Shell>
  );
}
