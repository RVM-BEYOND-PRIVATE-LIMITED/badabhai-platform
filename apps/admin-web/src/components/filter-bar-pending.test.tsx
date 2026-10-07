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
 * is a recorder whose pending flag a test sets, and each bar's tree is walked, not rendered.
 */
const h = vi.hoisted(() => ({
  harness: null as unknown,
  pushed: [] as string[],
  inTransition: false,
  pushedInTransition: [] as boolean[],
  pending: false,
}));
const harness = () => h.harness as HookHarness;

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useState: (initial: unknown) => harness().useState(initial),
    useId: () => harness().useId(),
    useTransition: () => [
      h.pending,
      (fn: () => void) => {
        h.inTransition = true;
        try {
          fn();
        } finally {
          h.inTransition = false;
        }
      },
    ],
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
  h.pending = false;
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
      const tree = harness().render(bar);
      const form = elements(tree).find((e) => e.type === "form") as
        | ReactElement<{ onSubmit: (e: { preventDefault: () => void }) => void }>
        | undefined;
      expect(form, "the bar's form").toBeDefined();
      form!.props.onSubmit({ preventDefault: () => undefined });
      expect(h.pushed).toHaveLength(1);
      expect(h.pushedInTransition).toEqual([true]);
    },
  );

  it.each(BARS)("%s: the submit button carries the cue, fed by that transition", (_name, bar) => {
    const idle = submitCue(harness().render(bar));
    expect(idle, "the cue on the submit button").toBeDefined();
    expect(idle!.props.pending).toBe(false);
    expect(idle!.props.message).toBe("Applying the filters…");
    h.pending = true;
    expect(submitCue(harness().render(bar))!.props.pending).toBe(true);
  });
});
