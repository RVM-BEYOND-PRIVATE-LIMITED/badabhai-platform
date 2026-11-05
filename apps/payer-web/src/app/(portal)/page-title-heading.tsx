"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { navTrail, type NavSection } from "./nav-model";

/**
 * The current page's heading, drawn at the START of the sticky top bar — the same row as the
 * theme switch and the account menu.
 *
 * The page owns its title (`PageHeader` renders the real H1); the shell owns the chrome. They
 * meet without a context/portal: after each route commit this reads the page's H1 text from
 * `#main` and paints the same string in the header. The nav trail is the first-paint fallback
 * (and the fallback for a page with no H1), so the header is never blank.
 */
export function PageTitleHeading({
  sections,
  isAgency,
}: {
  sections: NavSection[];
  isAgency: boolean;
}) {
  const pathname = usePathname();
  const fallback = navTrail(sections, pathname)?.item.label ?? "";
  const [title, setTitle] = useState(fallback);

  useEffect(() => {
    const read = () => {
      const heading = document.querySelector<HTMLElement>("#main .page-head__title");
      const text = heading?.textContent?.trim();
      setTitle(text !== undefined && text.length > 0 ? text : fallback);
    };
    read();
    const frame = window.requestAnimationFrame(read);
    return () => window.cancelAnimationFrame(frame);
  }, [pathname, fallback]);

  if (title.length === 0) return null;
  return (
    <div className="pshell__pagetitle">
      <span className="pshell__pagetitle-text">{title}</span>
      {pathname === "/dashboard" ? (
        <span className="dash-workspace-badge">
          {isAgency ? "Agency" : "Employer Workspace"}
        </span>
      ) : null}
    </div>
  );
}
