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
    {
      href: "/postings/new",
      label: isAgency ? "Post a vacancy" : "Post a job",
      match: (p) => p === "/postings/new",
    },
    {
      href: "/postings",
      label: isAgency ? "Manage vacancies" : "Manage postings",
      // Manage covers the list + any /postings/[id]/… detail, but NOT /postings/new.
      match: (p) => p === "/postings" || (p.startsWith("/postings/") && p !== "/postings/new"),
    },
    { href: "/capacity", label: "Capacity", match: (p) => p.startsWith("/capacity") },
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
