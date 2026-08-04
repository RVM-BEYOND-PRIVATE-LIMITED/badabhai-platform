import type { AdminCapability } from "../lib/auth/capabilities";

/**
 * The navigation model — plain data, in its OWN module with no `"use client"`.
 *
 * This split is load-bearing, not tidiness. When a Server Component imports a
 * non-component value from a client module, React hands back a client *reference*
 * rather than the value, and `NAV.map` throws `is not a function` at render time. The
 * portal layout filters this list on the server, so the data has to live somewhere the
 * server can actually read it.
 *
 * Each item names the capability it NEEDS. The shell filters against the server-resolved
 * list from `GET /admin/me`, so an operator never sees a door that will not open. That is
 * a UX decision — every route still enforces its own guard.
 */
export interface NavItem {
  href: string;
  label: string;
  /** Omit for items every authenticated admin may see. */
  capability?: AdminCapability;
  /** Sections landing in ADMIN-6..8 render disabled, so the IA is honest about scope. */
  upcoming?: boolean;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    title: "Overview",
    items: [
      { href: "/", label: "Dashboard" },
      { href: "/events", label: "Events", capability: "read_events", upcoming: true },
    ],
  },
  {
    title: "Operations",
    items: [
      { href: "/workers", label: "Workers", upcoming: true },
      { href: "/companies", label: "Companies", upcoming: true },
      { href: "/agencies", label: "Agencies", upcoming: true },
      { href: "/jobs", label: "Jobs", upcoming: true },
    ],
  },
  {
    title: "Finance",
    items: [
      { href: "/credits", label: "Credits", capability: "grant_credits", upcoming: true },
      { href: "/transactions", label: "Transactions", upcoming: true },
    ],
  },
  {
    title: "Administration",
    items: [
      { href: "/admins", label: "Admin users", capability: "manage_admins", upcoming: true },
      { href: "/system", label: "System health", upcoming: true },
    ],
  },
];
