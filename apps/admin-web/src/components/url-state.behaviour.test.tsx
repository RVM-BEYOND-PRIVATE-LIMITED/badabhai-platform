import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { createHookHarness, type HookHarness } from "../../test/hook-harness";

/**
 * Filter state that follows the URL WITHOUT REMOUNTING (review of #2046).
 *
 * Next keeps a client component's state across a navigation that changes only the search
 * params. The filter panel's open state and every filter bar's fields were decided once, at
 * mount, so a row's correlation-id link on /events landed on a filtered list with a phone's panel
 * still closed and an EMPTY Correlation id field — which Apply then dropped. #2046 fixed that by
 * keying a remount on the filter values; a remount destroys the focused control, so a keyboard
 * Apply had to be patched back by a timed focus memory, and clearing every filter on a phone still
 * dropped focus to <body>. Now nothing remounts: the panel and the bars re-sync their state from
 * the URL during render when the URL's values change (`useUrlState`), and keep it otherwise.
 *
 * The node env has no reconciler, so `useState` / `useId` run on a hook harness
 * (test/hook-harness.ts) that keeps state across re-renders of ONE instance — exactly what the
 * navigation does — and re-runs a render-phase update the way React does.
 */
const h = vi.hoisted(() => ({ harness: null as unknown }));
const harness = () => h.harness as HookHarness;

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useState: (initial: unknown) => harness().useState(initial),
    useId: () => harness().useId(),
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));

const { useUrlState } = await import("./use-url-state");
const { FilterPanel } = await import("./filter-panel");
const { EventFilterBar } = await import("../app/(portal)/events/filter-bar");
const { AiCallFilterBar } = await import("../app/(portal)/ai-calls/filter-bar");
const { JobFilterBar } = await import("../app/(portal)/jobs/filter-bar");
const { WorkerFilterBar } = await import("../app/(portal)/workers/filter-bar");
const { PayerFilterBar } = await import("./payer-filter-bar");
const { SkillDiscoveryFilterBar } = await import("../app/(portal)/skills/discovery/filter-bar");

beforeEach(() => {
  h.harness = createHookHarness();
});

/** Every element in a tree, in document order (no custom component is rendered, only walked). */
function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const props = node.props as { children?: ReactNode };
  return [node, ...elements(props.children)];
}

// ---------------------------------------------------------------------------------------------
// the hook
// ---------------------------------------------------------------------------------------------

describe("useUrlState — state that follows the URL without a remount", () => {
  /** One component instance using the hook; `edit` reaches its setter between renders. */
  function instance<T>(reconcile?: (current: T, fromUrl: T) => T) {
    let set: ((v: T) => void) | null = null;
    const render = (fromUrl: T, key: string) =>
      harness().render(() => {
        const [value, setValue] = useUrlState(fromUrl, key, reconcile);
        set = setValue;
        return value;
      });
    return { render, edit: (v: T) => set!(v) };
  }

  it("starts from the URL's value", () => {
    expect(instance<string>().render("arc", "a").valueOf()).toBe("arc");
  });

  it("keeps the operator's edit while the URL's value is unchanged (paging, a re-render)", () => {
    const c = instance<string>();
    c.render("arc", "a");
    c.edit("arc weld");
    expect(c.render("arc", "a")).toBe("arc weld");
  });

  it("takes the URL's new value the moment it changes — in the same render, no stale frame", () => {
    const c = instance<string>();
    c.render("", "none");
    c.edit("half-typed");
    expect(c.render("5eeded00-00c0", "corr")).toBe("5eeded00-00c0");
  });

  it("a reconcile function decides what a change does (the panel only ever opens)", () => {
    const c = instance<boolean>((open, opens) => open || opens);
    expect(c.render(true, "one")).toBe(true);
    expect(c.render(false, "none")).toBe(true);
    c.edit(false);
    expect(c.render(true, "two")).toBe(true);
  });

  it("appends its bookkeeping AFTER the value: the value is still the first state slot", () => {
    instance<string>().render("arc", "k");
    expect(harness().slots[0]).toBe("arc");
    expect(harness().slots[1]).toBe("k");
  });
});

// ---------------------------------------------------------------------------------------------
// the panel
// ---------------------------------------------------------------------------------------------

describe("FilterPanel — the open state follows the filter set, never by remounting", () => {
  type Filters = Record<string, string | boolean | undefined>;
  const panel = (filters: Filters) =>
    harness().render(() =>
      FilterPanel({ headingId: "h", heading: "Filter events", filters, children: null }),
    ) as ReactElement<Record<string, unknown>>;
  const open = (el: ReactElement<Record<string, unknown>>) => el.props["data-open"];
  const toggle = (el: ReactElement) => {
    const button = elements(el).find((e) =>
      String((e.props as { className?: string }).className).includes("filter-panel__toggle"),
    ) as ReactElement<{ onClick: () => void; children: ReactNode }>;
    expect(button).toBeDefined();
    return button;
  };
  const label = (el: ReactElement) =>
    [toggle(el).props.children]
      .flat()
      .filter((c) => typeof c === "string")
      .join("");

  it("a correlation-id link (none → one) opens a closed panel and counts the filter", () => {
    expect(open(panel({ correlationId: undefined }))).toBe("false");
    const after = panel({ correlationId: "5eeded00-00c0" });
    expect(open(after)).toBe("true");
    expect(label(after)).toBe("Filters (1)");
  });

  it("a CHANGED filter set opens it again after the operator closed it (same count)", () => {
    panel({ correlationId: "a" });
    toggle(panel({ correlationId: "a" })).props.onClick();
    expect(open(panel({ correlationId: "a" }))).toBe("false");
    expect(open(panel({ correlationId: "b" }))).toBe("true");
  });

  it("paging (the same filters) neither re-syncs nor collapses anything", () => {
    expect(open(panel({ status: "active" }))).toBe("true");
    toggle(panel({ status: "active" })).props.onClick();
    expect(open(panel({ status: "active" }))).toBe("false");
    expect(open(panel({ status: "active" }))).toBe("false");
  });

  it("clearing every filter leaves it as it was — a focused Apply is never hidden under the operator", () => {
    expect(open(panel({ status: "active" }))).toBe("true");
    const cleared = panel({ status: "" });
    expect(open(cleared)).toBe("true");
    expect(label(cleared)).toBe("Filters");
  });

  it("is ONE instance throughout: the panel carries no key, nothing is remounted", () => {
    expect(panel({}).key).toBeNull();
    expect(panel({ correlationId: "x" }).key).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// every filter bar
// ---------------------------------------------------------------------------------------------

type Control = ReactElement<{
  value?: unknown;
  checked?: unknown;
  type?: string;
  onChange: (e: unknown) => void;
}>;
const controls = (tree: ReactNode): Control[] =>
  elements(tree).filter((e) => e.type === "input" || e.type === "select") as Control[];
const shown = (c: Control) => (c.props.type === "checkbox" ? c.props.checked : c.props.value);

const SKILLS_EMPTY = {
  band: "",
  proposedAction: "",
  tradeFamily: "",
  sourceType: "",
  runId: "",
  clusterKey: "",
  phrase: "",
  createdFrom: "",
  createdTo: "",
  sort: "newest" as const,
};

/** name, a render from URL props, the URL before, the URL after (a link), and what each shows. */
const BARS: Array<{
  name: string;
  render: (url: Record<string, unknown>) => ReactNode;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  shows: (url: Record<string, unknown>) => unknown[];
}> = [
  {
    name: "events",
    render: (u) => EventFilterBar(u as Parameters<typeof EventFilterBar>[0]),
    before: { eventName: "", actorType: "", subjectType: "", correlationId: "" },
    after: { eventName: "", actorType: "", subjectType: "", correlationId: "5eeded00-00c0" },
    shows: (u) => [u.eventName, u.actorType, u.subjectType, u.correlationId],
  },
  {
    name: "ai-calls",
    render: (u) => AiCallFilterBar(u as Parameters<typeof AiCallFilterBar>[0]),
    before: { taskType: "", success: "", workerId: "" },
    after: { taskType: "profiling_chat_turn", success: "false", workerId: "5eeded00-0001" },
    shows: (u) => [u.taskType, u.success, u.workerId],
  },
  {
    name: "jobs",
    render: (u) => JobFilterBar(u as Parameters<typeof JobFilterBar>[0]),
    before: { status: "", verificationStatus: "", payerId: "" },
    after: { status: "open", verificationStatus: "verified", payerId: "5eeded00-0002" },
    shows: (u) => [u.status, u.verificationStatus, u.payerId],
  },
  {
    name: "workers",
    render: (u) => WorkerFilterBar(u as Parameters<typeof WorkerFilterBar>[0]),
    before: { status: "", pendingDeletion: false },
    after: { status: "active", pendingDeletion: true },
    shows: (u) => [u.status, u.pendingDeletion],
  },
  {
    name: "companies / agencies",
    render: (u) => PayerFilterBar({ basePath: "/companies", status: u.status as string }),
    before: { status: "" },
    after: { status: "suspended" },
    shows: (u) => [u.status],
  },
  {
    name: "skill discovery",
    render: (u) =>
      SkillDiscoveryFilterBar({
        basePath: "/skills/discovery",
        view: "flat",
        carry: {},
        initial: { ...SKILLS_EMPTY, ...(u as Partial<typeof SKILLS_EMPTY>) },
      }),
    before: {},
    after: { band: "high", phrase: "arc", sort: "oldest" },
    shows: (u) => {
      const v = { ...SKILLS_EMPTY, ...u };
      return [
        v.band,
        v.proposedAction,
        v.sourceType,
        v.tradeFamily,
        v.runId,
        v.clusterKey,
        v.phrase,
        v.createdFrom,
        v.createdTo,
        v.sort,
      ];
    },
  },
];

describe.each(BARS)(
  "$name filter bar — its fields follow the URL",
  ({ render, before, after, shows }) => {
    const draw = (url: Record<string, unknown>) => controls(harness().render(() => render(url)));

    it("shows the URL's values", () => {
      expect(draw(before).map(shown)).toEqual(shows(before));
    });

    it("keeps an unapplied edit while the URL is unchanged (a re-render, a page turn)", () => {
      draw(before)[0]!.props.onChange({ target: { value: "typed", checked: true } });
      const again = draw(before);
      expect(shown(again[0]!)).toBe(again[0]!.props.type === "checkbox" ? true : "typed");
    });

    it("a link that changes the URL's filters puts THEIR values in the fields (no remount)", () => {
      draw(before)[0]!.props.onChange({ target: { value: "typed", checked: true } });
      expect(draw(after).map(shown)).toEqual(shows(after));
    });
  },
);
