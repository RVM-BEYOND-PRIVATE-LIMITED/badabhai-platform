import Link from "next/link";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/ops/workers", label: "Workers" },
  { href: "/ops/applicants", label: "Applicants" },
  { href: "/ops/reach", label: "Reach" },
  { href: "/ops/events", label: "Events" },
  { href: "/ops/ai-jobs", label: "AI Jobs" },
  { href: "/ops/job-postings", label: "Job Postings" },
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
