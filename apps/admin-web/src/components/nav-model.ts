import type { CanonicalIconName } from "@badabhai/icons";
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
  /**
   * The item's glyph — the product-wide mapping (one concept, one icon, both portals): a
   * Phosphor FILL name from @badabhai/icons, typed, so a misspelling fails typecheck rather than
   * rendering an empty box. Canonical names only; a retired glyph cannot be chosen.
   */
  icon: CanonicalIconName;
  /** Omit for items every authenticated admin may see. */
  capability?: AdminCapability;
  /** Sections landing in ADMIN-6..8 render disabled, so the IA is honest about scope. */
  upcoming?: boolean;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

/**
 * THE SIDEBAR (A6, #2576) — five groups, at most 15 items, so the whole nav fits a 1080p screen
 * with no scrolling (it was 19, which pushed Account and Sign out below the fold; those two now
 * live in the topbar's avatar menu). Workers is Candidates; Companies holds Agencies (a Kind
 * filter); Agency match skills is a tab on the agency posting, under Postings. Routes, API paths
 * and capability keys did not move with the labels — the old addresses redirect
 * (next.config.mjs) — and every item's capability is still its page's own gate
 * (`nav-model.test.ts` reads each page's source to hold that).
 */
export const NAV: NavSection[] = [
  {
    title: "Home",
    items: [{ href: "/", label: "Dashboard", icon: "squares-four" }],
  },
  {
    // Who and what the platform holds: the people, their logins, the customers, the postings.
    title: "Directory",
    items: [
      // Was "Workers" (the route was /workers): the same roster, under the name the owner plan
      // gives it (#2553). A7 (#2577) rebuilds the page on the candidate data bank.
      {
        href: "/candidates",
        label: "Candidates",
        icon: "users-three",
        capability: "read_candidates",
      },
      // USER ACCOUNTS (#2578) — the payer logins an admin can create, recover or disable.
      // `manage_payer_credentials` mirrors `AdminPayerLoginsController`'s own guard (#2563);
      // the route came with its page and its capability, as this comment always said it would.
      {
        href: "/accounts",
        label: "User accounts",
        icon: "identification-card",
        capability: "manage_payer_credentials",
      },
      //
      // Companies AND Agencies: one list with a Kind filter since A6 — one table, one API.
      { href: "/companies", label: "Companies", icon: "buildings", capability: "read_entities" },
      // The route stays /jobs (owner ruling 2026-10-01: labels change, routes do not); /postings
      // redirects here. Agency postings and their match skills are a view of this section.
      { href: "/jobs", label: "Postings", icon: "briefcase", capability: "read_entities" },
    ],
  },
  {
    title: "Finance",
    items: [
      // `read_entities`, NOT `grant_credits`. Seeing the credit position and changing it are
      // different privileges — an analyst investigating a billing complaint should be able to
      // read the ledger without gaining the ability to alter a balance.
      { href: "/credits", label: "Credits", icon: "wallet", capability: "read_entities" },
      {
        href: "/transactions",
        label: "Payment orders",
        icon: "receipt",
        capability: "read_entities",
      },
    ],
  },
  {
    // What workers told us, what the AI did for them, and the vocabulary and engine that match
    // them — the quality half of the console.
    title: "Quality & AI",
    items: [
      // Every row here is a worker speaking, and its Worker column links straight back into
      // Candidates. `read_entities` mirrors the route's own guard exactly — the nav hides a door
      // it cannot open, it does not decide who may go through it.
      {
        href: "/feedback",
        label: "Feedback",
        icon: "chat-centered-text",
        capability: "read_entities",
      },
      // Beside Feedback, and for the mirror reason: Feedback is what a worker chose to tell us,
      // this is every AI call the platform made on their behalf.
      //
      // `read_ai_traces`, NOT `read_entities`, AND IT MIRRORS THE ROUTE. The API gates BOTH
      // legs of `/admin/ai-traces` on `read_ai_traces` (super_admin only) behind a default-off
      // flag, per the owner ruling — the list included, because walked end to end it is an index
      // of which worker spoke, in which interview, when, and how much.
      //
      // They must keep agreeing: the nav's job is to hide a door the session cannot open, so a
      // nav entry looser than its route puts three of four roles one click from a 403, and a nav
      // entry tighter than its route hides a screen they are entitled to. If the owner reopens
      // the list to ops, this line moves back in the SAME change as the decorator.
      { href: "/ai-calls", label: "AI calls", icon: "robot", capability: "read_ai_traces" },
      // `read_entities`, mirroring the three READS on `AdminSkillDiscoveryController` — the
      // queue, the detail read and the metrics tiles all sit on the read floor. The write
      // (`review_skill_candidates`) is a separate, narrower grant the detail screen checks
      // for itself before offering the five decision buttons; the nav entry stays on the
      // floor so an admin who can only READ the queue is not routed to a 403.
      {
        href: "/skills/discovery",
        label: "Skill discovery",
        icon: "list-magnifying-glass",
        capability: "read_entities",
      },
      // The live Matching V1 view (owner-approved investor demo): what one worker's feed holds,
      // and why. `read_entities`, mirroring all three reads on `AdminMatchEngineController`.
      {
        href: "/matching/engine",
        label: "Engine view",
        icon: "path",
        capability: "read_entities",
      },
    ],
  },
  {
    title: "Audit & Admin",
    items: [
      {
        href: "/events",
        label: "Events",
        icon: "clock-counter-clockwise",
        capability: "read_events",
      },
      { href: "/admins", label: "Admin users", icon: "user-gear", capability: "manage_admins" },
      // No capability: the authorization model describes the reader's OWN limits, and
      // hiding it would only make the portal opaque to the people working inside it. The page
      // keeps its full name ("Roles and capabilities"); the sidebar row says it short.
      { href: "/roles", label: "Roles", icon: "shield-check" },
      // No capability either: dependency health is not a secret. The page itself hides the
      // switch table from anyone without `toggle_kill_switch`, rather than 403-ing the lot.
      { href: "/system", label: "System", icon: "gauge" },
    ],
  },
];

/** The most items the sidebar may list (A6 acceptance: it fits 1920×1080 with no scrolling). */
export const NAV_ITEM_LIMIT = 15;

/**
 * Does `pathname` sit at or below `href`? Exact for the dashboard, prefix elsewhere — but on a
 * segment boundary, so `/candidates/123` is inside Candidates and `/jobsx` is not inside Postings.
 */
export function navItemMatches(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The item `pathname` belongs to — the most specific match when two entries both claim it — or
 * null off the nav (`/account`, an unknown path). One answer, shared by the sidebar's active row
 * and the topbar crumb, so the two can never point at different sections.
 */
export function activeNavItem(
  sections: readonly NavSection[],
  pathname: string,
): { section: NavSection; item: NavItem } | null {
  let found: { section: NavSection; item: NavItem } | null = null;
  for (const section of sections) {
    for (const item of section.items) {
      if (!navItemMatches(item.href, pathname)) continue;
      if (!found || item.href.length > found.item.href.length) found = { section, item };
    }
  }
  return found;
}
