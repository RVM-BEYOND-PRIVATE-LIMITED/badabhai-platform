import { FilterChip } from "../../../components/filter-chip-link";

export type NumbersTab = "weekly" | "out-of-credits" | "launch-test-a" | "launch-test-b";

const TABS: readonly { value: NumbersTab; label: string; href: string }[] = [
  { value: "weekly", label: "Weekly numbers", href: "/numbers" },
  { value: "out-of-credits", label: "Out-of-credits calls", href: "/numbers/out-of-credits" },
  { value: "launch-test-a", label: "Launch test A", href: "/numbers/launch-test-a" },
  { value: "launch-test-b", label: "Launch test B", href: "/numbers/launch-test-b" },
];

/** The four surfaces of the numbers screen (#2884), one nav entry deep. */
export function NumbersTabs({ active }: { active: NumbersTab }) {
  return (
    <nav className="filters--inline" aria-label="Numbers">
      {TABS.map((tab) => (
        <FilterChip
          key={tab.value}
          selected={tab.value === active}
          href={tab.href}
          cursor={undefined}
          size="md"
        >
          {tab.label}
        </FilterChip>
      ))}
    </nav>
  );
}
