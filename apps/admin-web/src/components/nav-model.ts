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
      // Beside Workers rather than at the end of the section: every row on this screen is a
      // worker speaking, and its Worker column links straight back into the roster above.
      // `read_entities` mirrors the route's own guard exactly — the nav hides a door it
      // cannot open, it does not decide who may go through it.
      { href: "/feedback", label: "Feedback", capability: "read_entities" },
      // Beside Feedback, and for the mirror reason: Feedback is what a worker chose to tell
      // us, this is every AI call the platform made on their behalf. Both link back into the
      // roster above, and both answer "what happened to this worker" from a different side.
      //
      // `read_ai_traces`, NOT `read_entities`, AND IT MIRRORS THE ROUTE. The API gates BOTH
      // legs of `/admin/ai-traces` on `read_ai_traces` (super_admin only) behind a default-off
      // flag, per the owner ruling — the list included, because walked end to end it is an index
      // of which worker spoke, in which interview, when, and how much.
      //
      // This entry declared `read_entities` while the API gated the list the same way, and the
      // two agreed. They must keep agreeing: the nav's job is to hide a door the session cannot
      // open, so a nav entry looser than its route puts three of four roles one click from a
      // 403, and a nav entry tighter than its route hides a screen they are entitled to. If the
      // owner reopens the list to ops, this line moves back in the SAME change as the decorator.
      { href: "/ai-calls", label: "AI calls", capability: "read_ai_traces" },
      { href: "/companies", label: "Companies", capability: "read_entities" },
      { href: "/agencies", label: "Agencies", capability: "read_entities" },
      { href: "/jobs", label: "Jobs", capability: "read_entities" },
    ],
  },
  {
    title: "Skills",
    items: [
      // `read_entities`, mirroring the three READS on `AdminSkillDiscoveryController` — the
      // queue, the detail read and the metrics tiles all sit on the read floor. The write
      // (`review_skill_candidates`) is a separate, narrower grant the detail screen checks
      // for itself before offering the five decision buttons; the nav entry stays on the
      // floor so an admin who can only READ the queue is not routed to a 403.
      { href: "/skills/discovery", label: "Skill Discovery", capability: "read_entities" },
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
