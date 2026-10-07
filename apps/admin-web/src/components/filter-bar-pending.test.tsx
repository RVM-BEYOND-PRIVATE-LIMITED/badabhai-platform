import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { createHookHarness, type HookHarness } from "../../test/hook-harness";

/**
 * A filter bar's Apply shows that its navigation is under way (delta review of #2095).
 *
 * Apply is a form submit that `router.push`es a new query — the same-page navigation the console's
 * no-boundary rule is about, with no `<Link>` for `useLinkStatus` to read. So every bar pushes
 * inside its own transition (`usePendingPush`), and its submit button carries `SubmitPendingCue`
 * fed by that transition's pending flag: the dot, and the shell's bar and status line. No
 * boundary, and it ends exactly when the navigation commits.
 *
 * The node env has no reconciler: `useState` / `useId` run on the hook harness, `useTransition`
 * is a recorder — each call in a render is a numbered transition whose pending flag a test sets,
 * and a push records which transition it ran in — and each bar's tree is walked, not rendered.
 */
const h = vi.hoisted(() => ({
  harness: null as unknown,
  pushed: [] as string[],
  /** The transition a push is running in (by its call order in the render), or null. */
  inTransition: null as number | null,
  pushedInTransition: [] as (number | null)[],
  /** Which transition reads as pending (by call order); -1 for none. */
  pendingAt: -1,
  calls: 0,
}));
const harness = () => h.harness as HookHarness;

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useState: (initial: unknown) => harness().useState(initial),
    useId: () => harness().useId(),
    useTransition: () => {
      const at = h.calls++;
      return [
        h.pendingAt === at,
        (fn: () => void) => {
          h.inTransition = at;
          try {
            fn();
          } finally {
            h.inTransition = null;
          }
        },
      ];
    },
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => {
      h.pushed.push(href);
      h.pushedInTransition.push(h.inTransition);
    },
  }),
}));

const { SubmitPendingCue } = await import("./nav-pending");
const { EventFilterBar } = await import("../app/(portal)/events/filter-bar");
const { AiCallFilterBar } = await import("../app/(portal)/ai-calls/filter-bar");
const { JobFilterBar } = await import("../app/(portal)/jobs/filter-bar");
const { WorkerFilterBar } = await import("../app/(portal)/workers/filter-bar");
const { PayerFilterBar } = await import("./payer-filter-bar");
const { SkillDiscoveryFilterBar } = await import("../app/(portal)/skills/discovery/filter-bar");

beforeEach(() => {
  h.harness = createHookHarness();
  h.pushed = [];
  h.pushedInTransition = [];
  h.pendingAt = -1;
});

/** One render of `bar`, its transitions numbered from 0 in call order. */
const draw = (bar: () => ReactNode) =>
  harness().render(() => {
    h.calls = 0;
    return bar();
  });

function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const props = node.props as { children?: ReactNode };
  return [node, ...elements(props.children)];
}

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

const BARS: Array<[string, () => ReactNode]> = [
  [
    "events",
    () => EventFilterBar({ eventName: "", actorType: "", subjectType: "", correlationId: "" }),
  ],
  ["ai-calls", () => AiCallFilterBar({ taskType: "", success: "", workerId: "" })],
  ["jobs", () => JobFilterBar({ status: "", verificationStatus: "", payerId: "" })],
  ["workers", () => WorkerFilterBar({ status: "", pendingDeletion: false })],
  ["companies / agencies", () => PayerFilterBar({ basePath: "/companies", status: "" })],
  [
    "skill discovery",
    () =>
      SkillDiscoveryFilterBar({
        basePath: "/skills/discovery",
        view: "flat",
        carry: {},
        initial: SKILLS_EMPTY,
      }),
  ],
];

/** The bar's submit button and the pending cue inside it. */
function submitCue(tree: ReactNode) {
  const button = elements(tree).find(
    (e) => e.type === "button" && (e.props as { type?: string }).type === "submit",
  );
  expect(button, "the submit button").toBeDefined();
  return elements((button!.props as { children?: ReactNode }).children).find(
    (e) => e.type === SubmitPendingCue,
  ) as ReactElement<{ pending: boolean; message: string }> | undefined;
}

describe("every filter bar's Apply shows that its navigation is under way", () => {
  it.each(BARS)(
    "%s: Apply pushes inside a transition — the pending flag's source",
    (_name, bar) => {
      const tree = draw(bar);
      const form = elements(tree).find((e) => e.type === "form") as
        | ReactElement<{ onSubmit: (e: { preventDefault: () => void }) => void }>
        | undefined;
      expect(form, "the bar's form").toBeDefined();
      form!.props.onSubmit({ preventDefault: () => undefined });
      expect(h.pushed).toHaveLength(1);
      // In the bar's FIRST transition — the one its Apply cue reads.
      expect(h.pushedInTransition).toEqual([0]);
    },
  );

  it.each(BARS)("%s: the submit button carries the cue, fed by that transition", (_name, bar) => {
    const idle = submitCue(draw(bar));
    expect(idle, "the cue on the submit button").toBeDefined();
    expect(idle!.props.pending).toBe(false);
    expect(idle!.props.message).toBe("Applying the filters…");
    h.pendingAt = 0;
    expect(submitCue(draw(bar))!.props.pending).toBe(true);
  });
});

/**
 * Skill discovery's "Clear these fields" navigates too — but it is not Apply (approval review of
 * #2095): it runs in its OWN transition, its own button says so ("Clearing the fields…"), and
 * Apply's cue stays idle while it does.
 */
describe("skill discovery — Clear these fields has its own cue", () => {
  const bar = BARS.find(([name]) => name === "skill discovery")![1];
  const clearButton = (tree: ReactNode) => {
    const button = elements(tree).find((e) =>
      [(e.props as { children?: ReactNode }).children].flat().includes("Clear these fields"),
    ) as ReactElement<{ onClick: () => void; children?: ReactNode }> | undefined;
    expect(button, "the Clear these fields button").toBeDefined();
    return button!;
  };
  const cueIn = (button: ReactElement<{ children?: ReactNode }>) =>
    elements(button.props.children).find((e) => e.type === SubmitPendingCue) as
      | ReactElement<{ pending: boolean; message: string }>
      | undefined;

  it("pushes in its own transition, not Apply's", () => {
    clearButton(draw(bar)).props.onClick();
    expect(h.pushed).toEqual(["/skills/discovery"]);
    expect(h.pushedInTransition).toEqual([1]);
  });

  it("its button carries its own cue and words; Apply's cue does not light for it", () => {
    const idle = cueIn(clearButton(draw(bar)));
    expect(idle, "the cue on Clear these fields").toBeDefined();
    expect(idle!.props.message).toBe("Clearing the fields…");
    expect(idle!.props.pending).toBe(false);
    h.pendingAt = 1;
    const tree = draw(bar);
    expect(cueIn(clearButton(tree))!.props.pending).toBe(true);
    expect(submitCue(tree)!.props.pending).toBe(false);
  });
});
