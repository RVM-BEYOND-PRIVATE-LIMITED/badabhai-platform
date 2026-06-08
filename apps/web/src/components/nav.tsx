import Link from "next/link";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/ops/workers", label: "Workers" },
  { href: "/ops/events", label: "Events" },
  { href: "/ops/ai-jobs", label: "AI Jobs" },
];

export function Nav() {
  return (
    <nav className="nav">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
