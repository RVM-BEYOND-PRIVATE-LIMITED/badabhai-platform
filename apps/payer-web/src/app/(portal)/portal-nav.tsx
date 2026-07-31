"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Primary portal navigation (DS0.3) — CLIENT wrapper that adds the active-route
 * highlight + `aria-current` on top of the SAME role-aware link set the server shell
 * computed. This is presentation only: the links, labels, and which ones render are
 * still decided server-side (`isAgency` / `isOwner` passed in) and the SERVER gate
 * (`requireOwner` / `requireAgent`) remains the authorization — the active class is
 * never a permission. Routing is unchanged (still `next/link`).
 */
export interface PortalNavProps {
  isAgency: boolean;
  isOwner: boolean;
}

interface NavLink {
  href: string;
  label: string;
  /** Active when the current path is this route or a child of it. */
  match: (pathname: string) => boolean;
}

export function PortalNav({ isAgency, isOwner }: PortalNavProps) {
  const pathname = usePathname();

  const links: NavLink[] = [
    { href: "/dashboard", label: "Dashboard", match: (p) => p === "/dashboard" },
    { href: "/profile", label: "Profile", match: (p) => p.startsWith("/profile") },
    {
      href: "/postings/new",
      label: isAgency ? "Post a vacancy" : "Post a job",
      // The ADR-0035 AI chat (/postings/ai/new) is the same "post a job" task, so it keeps
      // this entry active rather than lighting up "Manage".
      match: (p) => p === "/postings/new" || p.startsWith("/postings/ai"),
    },
    {
      href: "/postings",
      label: isAgency ? "Manage vacancies" : "Manage postings",
      // Manage covers the list + any /postings/[id]/… detail, but NOT the create routes
      // (/postings/new or the AI chat at /postings/ai/…).
      match: (p) =>
        p === "/postings" ||
        (p.startsWith("/postings/") && p !== "/postings/new" && !p.startsWith("/postings/ai")),
    },
    { href: "/plans", label: "Plans & Capacity", match: (p) => p.startsWith("/plans") },
  ];

  if (isOwner) {
    links.push(
      { href: "/credits", label: "Credits", match: (p) => p.startsWith("/credits") },
      { href: "/team", label: "Team", match: (p) => p.startsWith("/team") },
    );
  }
  if (isAgency) {
    // MERGE-1: the agency demand dashboard is now the single role-aware `/dashboard` (the
    // "Dashboard" link above), so there is no separate "Agency dashboard" nav entry — it would
    // be a redundant duplicate of Dashboard. The referrals deep page stays its own link.
    links.push({
      href: "/agency/referrals",
      label: "Referrals & payouts",
      match: (p) => p.startsWith("/agency/referrals"),
    });
    links.push({
      href: "/agency/revenue",
      label: "Revenue",
      match: (p) => p.startsWith("/agency/revenue"),
    });
  }

  return (
    <nav className="portal-nav" aria-label="Primary">
      {links.map((link) => {
        const active = link.match(pathname);
        return (
          <Link
            key={link.href}
            className={active ? "portal-nav__link portal-nav__link--active" : "portal-nav__link"}
            href={link.href}
            aria-current={active ? "page" : undefined}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
