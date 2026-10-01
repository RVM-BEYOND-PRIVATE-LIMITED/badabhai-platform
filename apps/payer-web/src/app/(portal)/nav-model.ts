/**
 * The portal navigation model — plain data, in its OWN module with no `"use client"`.
 *
 * This split is load-bearing, not tidiness (the same reason admin-web keeps its nav model
 * separate): when a Server Component imports a non-component value from a client module,
 * React hands back a client *reference* rather than the value, and `.map` throws at render
 * time. The portal layout builds this list on the server, so the data has to live somewhere
 * the server can actually read it.
 *
 * PLAIN DATA MEANS PLAIN DATA — NO FUNCTIONS. The layout is a Server Component and
 * `AppShell` is a Client Component, so these sections are serialized across the RSC
 * boundary. `match` used to be a closure (`match: (p) => p === "/dashboard"`), which is not
 * serializable: every portal route threw "Functions cannot be passed directly to Client
 * Components" and `/dashboard` returned a 500. It is a DESCRIPTOR now, evaluated by
 * {@link isNavItemActive}, which the client components import directly rather than being
 * handed. `nav-model.test.ts` fails on any function reintroduced anywhere in this model.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * AUTHORIZATION IS NOT HERE. The nav is an AFFORDANCE — it decides which doors a user is
 * shown, never which doors open. Every route keeps its own server gate (`requirePayer` /
 * `requireAgent` / `requireOwner`), and those gates are untouched by this file. A user who
 * types a hidden URL still meets the same neutral 404 they met before.
 *
 * WHAT CHANGED, AND WHY (IA-1)
 * The previous nav was a single flat row of 5–8 links in the header, which had three
 * concrete problems:
 *
 *  1. NO LEVELS. "New posting" (used many times a day) sat at the same visual weight as
 *     "Plans & capacity" (used perhaps twice a quarter). Grouping restores the hierarchy.
 *
 *  2. ORPHANED SURFACES. `/agency/workers` existed, was guarded, and was reachable ONLY from a
 *     tile on the agency dashboard — navigate away and the browser's back button was the only
 *     route back. It is now addressable from the nav. This exposes no new capability: the
 *     route keeps `requireAgent()` + its flag gate. (`/agency/bulk-upload` is NOT in the nav:
 *     it explains a module that will never be built, and the dashboard's Invite tools card is
 *     its one way in.)
 *
 *  3. DUPLICATES PRESENTED AS PEERS. `/profile` used to render the very same `AccountForm`
 *     as `/account`, so the nav offered two doors onto one screen. `/account` is the
 *     survivor and lives in the account menu where a settings screen belongs. BL-6/DU-1
 *     (product decision, 2026-08-14): `/profile` is now a server `redirect()` to `/account`
 *     (see profile/page.tsx) — it KEEPS WORKING for old links/bookmarks, it just no longer
 *     renders its own copy of the form or shows up in the nav.
 *
 * NAV FOLLOWS THE PAGE GATE (2026-10-01). An item is shown only when its page would render for
 * this session: the agency items carry the SAME `agencyPortalEnabled` flag their pages check, so
 * a switched-off agency surface leaves the rail instead of offering doors that 404. (The old
 * `comingSoon` state — a greyed, non-link item for a route that 404s — is gone with its only
 * user: "Bulk invite upload" is dead by design (ADR-0022 Amendment 3) and is never framed as
 * coming.) `parked` stays: a reachable page that explains what is not built yet.
 *
 * NAMING (owner ruling 2026-10-01): the job entity is a "Posting" for BOTH personas — "New
 * posting" creates one, "Postings" lists them. An agency posts AGENCY jobs only (the `jobs`
 * table the worker feed reads), so its Demand items open `/agency/jobs*`; the company posting
 * surface (`/postings*`, the `job_postings` table) is offered to companies only. Labels only:
 * no route or API path was renamed to change a label.
 */

import { ACTION_ICON, type IconName } from "@badabhai/icons";

/**
 * WHICH PATHS LIGHT AN ITEM UP — as data, so it survives the RSC boundary.
 *
 * Every clause is segment-aware: a base matches itself and its children (`/plans`,
 * `/plans/upgrade`) but never a mere string neighbour (`/plans-archive`), which the old
 * `startsWith` closures would have claimed.
 */
export interface NavMatch {
  /** Paths that activate this item and nothing below them. */
  exact?: string[];
  /** Bases that activate this item along with everything under them. */
  prefix?: string[];
  /**
   * Bases that VETO a `prefix` hit, with their children. This is what keeps siblings from
   * lighting each other up: `/postings` owns its subtree EXCEPT the two routes that are
   * their own nav entry (`/postings/new`, `/postings/ai/*`).
   */
  except?: string[];
}

export interface NavItem {
  href: string;
  label: string;
  /** Glyph (a typed `IconName`, so a typo fails typecheck). Always paired with a text label. */
  icon: IconName;
  /** One line, shown as the tooltip when the rail is collapsed to icons. */
  description?: string;
  /**
   * Active when the current path is this route or a child of it. Kept as an explicit
   * descriptor because several routes are siblings that must NOT light each other up
   * (`/postings` vs `/postings/new` vs `/postings/ai/*`).
   */
  match: NavMatch;
  /**
   * REACHABLE but parked: the route renders a real page that explains what is not built yet.
   * It stays a normal link — the destination is an explanation, not a dead end — and carries a
   * SOON badge so the rail sets the right expectation before the click. A route whose gate
   * would 404 for this session is never parked: it is simply not in the model.
   */
  parked?: boolean;
}

export interface NavSection {
  /** Omit for the lead group — an unlabelled first block reads as "home", not a category. */
  title?: string;
  items: NavItem[];
}

export interface NavModelInput {
  /** ACCOUNT role: `session.role === "agent"`. Decides product labelling AND the agency group. */
  isAgency: boolean;
  /**
   * ORG role: `getOrgRole(session) === "owner"`. Owner-only affordances (billing + team).
   *
   * NOTE FOR WHOEVER READS THIS NEXT: `getOrgRole()` is currently a stub that returns
   * "recruiter" for every session outside dev/test, so `isOwner` is false in staging and
   * production and these two items never render — while the API's own org-role guard would
   * happily let a real owner through. That is a pre-existing authorization gap, NOT
   * something this navigation introduced or should paper over. The model passes the flag
   * through exactly as the old nav did; fixing the stub is a separate, deliberate change.
   */
  isOwner: boolean;
  /**
   * `agencyFlags().agencyPortalEnabled` — the gate EVERY agency page checks before it renders
   * (off → neutral 404). The agency items follow it so the rail never offers a door that 404s.
   * Affordance only, like the rest of this model.
   */
  agencyPortalEnabled: boolean;
}

/** True when `pathname` IS `base` or sits underneath it. Never a bare string prefix. */
function isUnder(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/**
 * Evaluate a {@link NavMatch} against the current path.
 *
 * Exported so the client rail and the breadcrumb can both import it — importing a function
 * from a shared module is not the same as being PASSED one across the RSC boundary, which
 * is the thing that broke. Pure, so the whole activation table is unit-testable without a
 * renderer.
 */
export function isNavItemActive(match: NavMatch, pathname: string): boolean {
  if (match.exact?.includes(pathname)) return true;
  if (!match.prefix?.some((base) => isUnder(pathname, base))) return false;
  return !match.except?.some((base) => isUnder(pathname, base));
}

/** `/postings` owns its subtree except the two routes that carry their own nav entry. */
const POSTINGS_LIST_MATCH: NavMatch = {
  prefix: ["/postings"],
  except: ["/postings/new", "/postings/ai"],
};
/** Posting a role and the AI chat that does the same job are ONE destination. */
const POSTINGS_NEW_MATCH: NavMatch = { exact: ["/postings/new"], prefix: ["/postings/ai"] };
/** The agency's own postings (`jobs`): the list owns its subtree except the create form. */
const AGENCY_POSTINGS_MATCH: NavMatch = {
  prefix: ["/agency/jobs"],
  except: ["/agency/jobs/new"],
};
const AGENCY_NEW_POSTING_MATCH: NavMatch = { exact: ["/agency/jobs/new"] };
/**
 * /capacity is the hiring-capacity part of Plans & capacity (plans embeds the same
 * CapacityPanel); it has no nav entry of its own and lights its parent.
 */
const PLANS_MATCH: NavMatch = { prefix: ["/plans", "/capacity"] };

const DASHBOARD_MATCH: NavMatch = { exact: ["/dashboard"] };

/** Owner-only billing entry — identical for both account types. */
function creditsItem(): NavItem {
  return {
    href: "/credits",
    label: "Credits",
    icon: ACTION_ICON.credits,
    description: "Your credit balance, credit purchases and payment history.",
    match: { prefix: ["/credits"] },
  };
}

function plansItem(): NavItem {
  return {
    href: "/plans",
    label: "Plans & capacity",
    icon: "chart-donut",
    description: "How many postings you can run at once, and what each costs.",
    match: PLANS_MATCH,
  };
}

/** Owner-only organisation group — identical for both account types. */
function organisationSection(): NavSection {
  return {
    title: "Organisation",
    items: [
      {
        href: "/team",
        label: "Team",
        icon: ACTION_ICON.users,
        description: "Invite recruiters and manage who can access this account.",
        match: { prefix: ["/team"] },
      },
    ],
  };
}

/** Level 1 + 2 + 3 for a COMPANY (employer) account. */
function companySections({ isOwner }: NavModelInput): NavSection[] {
  return [
    {
      items: [
        {
          href: "/dashboard",
          label: "Dashboard",
          icon: "squares-four",
          description: "Everything that needs you today, in one view.",
          match: DASHBOARD_MATCH,
        },
      ],
    },
    {
      title: "Hiring",
      items: [
        {
          href: "/postings/new",
          label: "New posting",
          icon: ACTION_ICON.create,
          description: "Describe the role and publish it to matched workers.",
          match: POSTINGS_NEW_MATCH,
        },
        {
          href: "/postings",
          label: "Postings",
          icon: ACTION_ICON.posting,
          description: "Manage your postings and review their applicants.",
          match: POSTINGS_LIST_MATCH,
        },
      ],
    },
    {
      title: "Billing",
      items: [plansItem(), ...(isOwner ? [creditsItem()] : [])],
    },
    ...(isOwner ? [organisationSection()] : []),
  ];
}

/**
 * Level 1 + 2 + 3 + 4 for an AGENCY (agent) account.
 *
 * Every agency-only destination (Demand, Supply, Revenue) is behind the agency-portal flag on
 * its page, so it is behind the same flag here. With the flag off an agency keeps Dashboard and
 * (owner) Credits + Team — the shared surfaces whose pages do not check it.
 *
 * NO "Plans & capacity" (2026-10-01, a consequence of ruling 2): that page sells entitlements on
 * COMPANY postings, and an agency posts agency jobs only — an agent who opens /plans or /capacity
 * is sent to the dashboard. Billing for an agency is Credits, which only an owner can open.
 */
function agencySections({ isOwner, agencyPortalEnabled }: NavModelInput): NavSection[] {
  const agencyOnly = (sections: NavSection[]) => (agencyPortalEnabled ? sections : []);
  return [
    {
      items: [
        {
          href: "/dashboard",
          label: "Dashboard",
          icon: "squares-four",
          description: "Demand, supply and referrals in one view.",
          match: DASHBOARD_MATCH,
        },
      ],
    },
    ...agencyOnly([
      {
        title: "Demand",
        items: [
          {
            href: "/agency/jobs/new",
            label: "New posting",
            icon: ACTION_ICON.create,
            description: "Publish a posting for your agency and reach matched workers.",
            match: AGENCY_NEW_POSTING_MATCH,
          },
          {
            href: "/agency/jobs",
            label: "Postings",
            icon: ACTION_ICON.posting,
            description: "Your agency's postings — edit, pause, resume and close them.",
            match: AGENCY_POSTINGS_MATCH,
          },
        ],
      },
      {
        title: "Supply",
        items: [
          {
            href: "/agency/workers",
            label: "Worker activity",
            icon: ACTION_ICON.users,
            description: "How the workers you referred are getting on.",
            match: { prefix: ["/agency/workers"] },
          },
          {
            href: "/agency/referrals",
            label: "Referrals",
            icon: "share-network",
            description: "Invite links, sign-up funnel and payout status.",
            match: { prefix: ["/agency/referrals"] },
          },
          {
            href: "/agency/qr",
            label: "QR invite",
            icon: "qr-code",
            description: "A printable invite sheet for a workshop wall or chai stall.",
            match: { prefix: ["/agency/qr"] },
          },
        ],
      },
    ]),
    ...(isOwner ? [{ title: "Billing", items: [creditsItem()] }, organisationSection()] : []),
    ...agencyOnly([
      {
        // LEVEL 4 — a real route whose page explains what is not built yet.
        title: "Coming soon",
        items: [
          {
            href: "/agency/revenue",
            label: "Revenue",
            icon: "currency-inr",
            description: "Revenue analytics for your agency, once it is built.",
            match: { prefix: ["/agency/revenue"] },
            parked: true,
          },
        ],
      },
    ]),
  ];
}

/**
 * Build the sections for a session. Pure — takes the flags the shell already computes
 * server-side and returns data, so it is trivially unit-testable and holds no session.
 */
export function navSections(input: NavModelInput): NavSection[] {
  return input.isAgency ? agencySections(input) : companySections(input);
}
