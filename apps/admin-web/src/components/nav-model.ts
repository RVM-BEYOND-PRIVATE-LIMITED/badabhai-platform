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
      { href: "/events", label: "Events", capability: "read_events" },
    ],
  },
  {
    title: "Operations",
    items: [
      { href: "/workers", label: "Workers", capability: "read_entities" },
      { href: "/companies", label: "Companies", capability: "read_entities" },
      { href: "/agencies", label: "Agencies", capability: "read_entities" },
      { href: "/jobs", label: "Jobs", capability: "read_entities" },
    ],
  },
  {
    title: "Finance",
    items: [
      // `read_entities`, NOT `grant_credits`. Seeing the credit position and changing it are
      // different privileges — an analyst investigating a billing complaint should be able to
      // read the ledger without gaining the ability to alter a balance.
      { href: "/credits", label: "Credits", capability: "read_entities" },
      { href: "/transactions", label: "Transactions", capability: "read_entities" },
    ],
  },
  {
    title: "Administration",
    items: [
      { href: "/admins", label: "Admin users", capability: "manage_admins" },
      // No capability: the authorization model describes the reader's OWN limits, and
      // hiding it would only make the portal opaque to the people working inside it.
      { href: "/roles", label: "Roles & capabilities" },
      // No capability either: dependency health is not a secret. The page itself hides the
      // switch table from anyone without `toggle_kill_switch`, rather than 403-ing the lot.
      { href: "/system", label: "System" },
    ],
  },
];
