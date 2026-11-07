"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export type CompanyTabValue =
  | "overview"
  | "postings"
  | "payments"
  | "credits"
  | "users"
  | "timeline";

/**
 * The company record's tabs (A9, #2579).
 *
 * Each tab is a LINK, so the view is addressable (`?tab=payments`) and works without JS. The
 * underline indicator glides between the active links over `--duration-base` (220ms) and drops to
 * zero under reduced motion via the shared duration tokens.
 */
export function CompanyTabs({
  tabs,
  active,
  basePath,
}: {
  tabs: readonly { value: CompanyTabValue; label: string }[];
  active: CompanyTabValue;
  basePath: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const params = useSearchParams();
  const listRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!selected) return;
    setIndicator({ left: selected.offsetLeft, width: selected.offsetWidth });
  }, [active, tabs]);

  function href(value: CompanyTabValue): string {
    const q = new URLSearchParams(params.toString());
    q.set("tab", value);
    // A tab's own cursors must not follow it to another tab.
    q.delete("ledger");
    q.delete("payments");
    q.delete("events");
    const s = q.toString();
    return s ? `${pathname || basePath}?${s}` : pathname || basePath;
  }

  /** The ARIA tabs pattern: arrows move between tabs, Home/End jump to the ends. */
  function moveFocus(event: KeyboardEvent<HTMLAnchorElement>, index: number) {
    const last = tabs.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next === null) return;
    event.preventDefault();
    router.push(href(tabs[next]!.value));
  }

  return (
    <div className="tabs" role="tablist" aria-label="Company record" ref={listRef}>
      {tabs.map((tab, index) => {
        const selected = tab.value === active;
        return (
          <Link
            key={tab.value}
            className="tabs__link"
            href={href(tab.value)}
            role="tab"
            aria-selected={selected}
            aria-controls="company-tabpanel"
            tabIndex={selected ? undefined : -1}
            onKeyDown={(event) => moveFocus(event, index)}
          >
            {tab.label}
          </Link>
        );
      })}
      {indicator ? (
        <span
          className="tabs__indicator"
          aria-hidden="true"
          style={{ transform: `translateX(${indicator.left}px)`, width: indicator.width }}
        />
      ) : null}
    </div>
  );
}
