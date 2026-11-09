/**
 * Server-safe links shared by the admin console.
 *
 * `ALL_ADMIN_ACTIONS_LINK` used to live in `components/admin-action-result-banner.tsx`,
 * which is a `"use client"` module. Server components that imported it received a client
 * reference, so `ALL_ADMIN_ACTIONS_LINK.href` was `undefined` at render time and Next's
 * `<Link>` threw. Keeping the constant here (no `"use client"`) lets server pages read it
 * as a plain object; the client banner re-exports it for existing client callers.
 */
export interface ResultEventsLink {
  href: string;
  label: string;
}

export const ALL_ADMIN_ACTIONS_LINK: ResultEventsLink = {
  href: "/events?eventName=admin.action_performed",
  label: "View all admin actions",
};
