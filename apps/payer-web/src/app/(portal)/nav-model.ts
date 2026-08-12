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
 *  1. NO LEVELS. "Post a job" (used many times a day) sat at the same visual weight as
 *     "Plans & Capacity" (used perhaps twice a quarter). Grouping restores the hierarchy.
 *
 *  2. ORPHANED SURFACES. `/agency/workers` and `/agency/bulk-upload` existed, were guarded,
 *     and were reachable ONLY from a tile on the agency dashboard — navigate away and the
 *     browser's back button was the only route back. They are now addressable from the nav.
 *     This exposes no new capability: both routes keep `requireAgent()` + their flag gate.
 *
 *  3. DUPLICATES PRESENTED AS PEERS. `/profile` renders the very same `AccountForm` as
 *     `/account` (profile/page.tsx imports `../account/account-form`), so the nav offered
 *     two doors onto one screen. `/account` is the survivor and lives in the account menu
 *     where a settings screen belongs; `/profile` KEEPS WORKING and is not removed — it is
 *     simply no longer advertised twice.
 *
 * `comingSoon` marks a capability whose server side is real but is not open to this user
 * yet — a parked shell (`/agency/revenue`) or a flag that is OFF by default. Those render
 * greyed and non-interactive rather than being deleted, so the IA stays honest about scope
 * instead of hiding roadmap that already exists in the codebase.
 */

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
  /** Phosphor glyph name, rendered as `ph ph-{icon}`. Always paired with a text label. */
  icon: string;
  /** One line, shown as a tooltip when the rail is collapsed and under Coming Soon items. */
  description?: string;
  /**
   * Active when the current path is this route or a child of it. Kept as an explicit
   * descriptor because several routes are siblings that must NOT light each other up
   * (`/postings` vs `/postings/new` vs `/postings/ai/*`).
   */
  match: NavMatch;
  /**
   * NOT REACHABLE yet: the route exists but its gate would answer with a neutral 404 for
   * this user (a fail-closed flag that defaults OFF). Renders disabled and is never a link,
   * because sending someone to a 404 is the "broken functionality" a Coming Soon state
   * exists to prevent. Not a security control — the route's own gate is.
   */
  comingSoon?: boolean;
  /**
   * REACHABLE but parked: the route renders a real page that explains what is coming. It
   * stays a normal link — the destination is an explanation, not a dead end — and carries
   * the same SOON badge so the IA is honest about what you will find there.
   *
   * The distinction is the whole point. Marking these `comingSoon` too would orphan a page
   * that exists and reads well; marking the 404-ing ones `parked` would walk users into a
   * dead end. Which one a route is depends on its gate, so it is recorded per item.
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
/** /capacity is a subset of /plans (plans embeds the same CapacityPanel). */
const PLANS_MATCH: NavMatch = { prefix: ["/plans", "/capacity"] };

/** Owner-only billing entry — identical for both account types. */
function creditsItem(): NavItem {
  return {
    href: "/credits",
    label: "Credits",
    icon: "wallet",
    description: "Your unlock balance, top-ups and payment history.",
    match: { prefix: ["/credits"] },
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
        icon: "users-three",
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
          match: { exact: ["/dashboard"] },
        },
      ],
    },
    {
      title: "Hiring",
      items: [
        {
          href: "/postings/new",
          label: "Post a job",
          icon: "plus-circle",
          description: "Describe the role and publish it to matched workers.",
          match: POSTINGS_NEW_MATCH,
        },
        {
          href: "/postings",
          label: "Postings",
          icon: "briefcase",
          description: "Manage open roles and review their applicants.",
          match: POSTINGS_LIST_MATCH,
        },
      ],
    },
    {
      title: "Billing",
      items: [
        {
          href: "/plans",
          label: "Plans & capacity",
          icon: "chart-donut",
          description: "How many roles you can run at once, and what each costs.",
          match: PLANS_MATCH,
        },
        ...(isOwner ? [creditsItem()] : []),
      ],
    },
    ...(isOwner ? [organisationSection()] : []),
  ];
}

/** Level 1 + 2 + 3 + 4 for an AGENCY (agent) account. */
function agencySections({ isOwner }: NavModelInput): NavSection[] {
  return [
    {
      items: [
        {
          href: "/dashboard",
          label: "Dashboard",
          icon: "squares-four",
          description: "Demand, supply and referrals in one view.",
          match: { exact: ["/dashboard"] },
        },
      ],
    },
    {
      title: "Demand",
      items: [
        {
          href: "/postings/new",
          label: "Post a vacancy",
          icon: "plus-circle",
          description: "Publish a vacancy and reach matched workers.",
          match: POSTINGS_NEW_MATCH,
        },
        {
          href: "/postings",
          label: "Vacancies",
          icon: "briefcase",
          description: "Manage open vacancies and review their applicants.",
          match: POSTINGS_LIST_MATCH,
        },
      ],
    },
    {
      title: "Supply",
      items: [
        {
          href: "/agency/workers",
          label: "Workers",
          icon: "users",
          description: "Workers who joined through your referrals.",
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
          label: "QR poster",
          icon: "qr-code",
          description: "A printable invite sheet for a workshop wall or chai stall.",
          match: { prefix: ["/agency/qr"] },
        },
      ],
    },
    {
      title: "Billing",
      items: [
        {
          href: "/plans",
          label: "Plans & capacity",
          icon: "chart-donut",
          description: "How many vacancies you can run at once, and what each costs.",
          match: PLANS_MATCH,
        },
        ...(isOwner ? [creditsItem()] : []),
      ],
    },
    ...(isOwner ? [organisationSection()] : []),
    {
      // LEVEL 4 — built on the server, not open yet. Every entry here corresponds to a real
      // route or a real flag in this repo; none is invented roadmap.
      title: "Coming soon",
      items: [
        {
          href: "/agency/revenue",
          label: "Revenue",
          icon: "currency-inr",
          // REACHABLE: agencyPortalEnabled defaults ON, so this renders a real parked page
          // that explains what is coming (agency/revenue/page.tsx). Kept as a link.
          description: "Earnings, payout history and revenue analytics for your agency.",
          match: { prefix: ["/agency/revenue"] },
          parked: true,
        },
        {
          href: "/agency/bulk-upload",
          label: "Bulk invite upload",
          icon: "upload-simple",
          // Route is real and guarded, but gated on agencyBulkUploadEnabled, which is a
          // fail-closed NEXT_PUBLIC_* flag that defaults OFF.
          description: "Mint invite codes for many workers from one spreadsheet.",
          match: { prefix: ["/agency/bulk-upload"] },
          comingSoon: true,
        },
      ],
    },
  ];
}

/**
 * Build the sections for a session. Pure — takes the two flags the shell already computes
 * server-side and returns data, so it is trivially unit-testable and holds no session.
 */
export function navSections(input: NavModelInput): NavSection[] {
  return input.isAgency ? agencySections(input) : companySections(input);
}
