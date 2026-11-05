import { requireSession } from "../../lib/auth";
import { ROLE_LABELS, can } from "../../lib/auth/capabilities";
import { getApiEnvironment } from "../../lib/environment";
import { NAV } from "../../components/nav-model";
import { allowedJumpKinds } from "../../components/quick-jump-model";
import { Shell } from "../../components/shell";
import { SignOutButton } from "../../components/sign-out-button";
import { ToastProvider } from "../../components/toast";
import { OfflineBanner } from "../../components/offline-banner";

// Per-request. A cached admin shell could show one operator another's navigation.
export const dynamic = "force-dynamic";

/**
 * The authenticated portal.
 *
 * `requireSession()` runs on EVERY render of every page in this group, and it asks the
 * server rather than reading the cookie's claims — so a revoked or expired session is
 * caught on the next navigation, not whenever the JWT happens to expire.
 *
 * The nav — and the quick jump's record kinds — are filtered by the server-supplied capability
 * list. That is presentation only; each route enforces `@RequireAdminRole` for itself, so a
 * hand-typed URL gains nothing.
 *
 * The environment badge reads the API's public health probe beside the session read, never
 * after it (`lib/environment.ts` caches it, and never throws: a failed probe is "unknown").
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const [session, environment] = await Promise.all([requireSession(), getApiEnvironment()]);
  const may = (capability: Parameters<typeof can>[1]) => can(session.capabilities, capability);

  const sections = NAV.map((section) => ({
    ...section,
    items: section.items.filter((i) => !i.capability || may(i.capability)),
    // A section whose every item was filtered out is dropped below, rather than rendering
    // an empty heading that reads like a broken menu.
  })).filter((section) => section.items.length > 0);

  // The toast stack (A5, #2575) wraps the whole shell, so any page's action can raise a toast
  // (a T1 Undo) and it outlives a navigation inside the portal.
  return (
    <ToastProvider>
      <OfflineBanner />
      <Shell
        sections={sections}
        roleLabel={ROLE_LABELS[session.role]}
        adminId={session.adminId}
        environment={environment}
        jumpKinds={allowedJumpKinds(may)}
        onSignOut={<SignOutButton />}
      >
        {children}
      </Shell>
    </ToastProvider>
  );
}
