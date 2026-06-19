import Link from "next/link";
import type { ReactNode } from "react";
import { requirePayer } from "../../lib/auth";
import { LogoutButton } from "./logout-button";

export const dynamic = "force-dynamic";

/**
 * Authenticated portal layout. `requirePayer()` resolves the SERVER-HELD session
 * (or redirects to /login), so every page under this group is guaranteed a payer
 * principal — and every data call binds to THAT payer's id (XB-A). The header
 * shows only a non-PII display label; the opaque payer_id is never rendered.
 */
export default async function PortalLayout({ children }: { children: ReactNode }) {
  const session = await requirePayer();
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          BadaBhai for Employers
          <small>Self-serve hiring · staging (mock)</small>
        </div>
        <nav className="topnav">
          <Link href="/dashboard">Dashboard</Link>
          <Link href="/postings/new">Post a job</Link>
          <Link href="/credits">Credits</Link>
        </nav>
        <div className="session-chip">
          <span>
            {session.displayLabel} · <span className="badge">{session.role}</span>
          </span>
          <LogoutButton />
        </div>
      </header>
      <main className="main">{children}</main>
    </div>
  );
}
