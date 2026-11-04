import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { createHookHarness, type HookHarness } from "../../test/hook-harness";

/**
 * The copy affordance beside every shortened id (#2572): the FULL id goes to the clipboard, the
 * icon becomes a check and a "Copied" toast shows for 1.2s, then both revert. A refused
 * clipboard claims nothing.
 *
 * The node env has no reconciler: `useState` runs on the hook harness, `useRef` is a plain box
 * and `useEffect` is inert (its only job is clearing the timer on unmount).
 */
const h = vi.hoisted(() => ({ harness: null as unknown }));
const harness = () => h.harness as HookHarness;

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useState: (initial: unknown) => harness().useState(initial),
    useRef: (initial: unknown) => ({ current: initial }),
    useEffect: () => undefined,
  };
});

const { CopyId, COPIED_FEEDBACK_MS } = await import("./copy-id");

const ID = "be16b2a0-3633-482b-8f5a-4f092c06a3f2";

interface ButtonProps {
  icon: string;
  label: string;
  onClick: () => Promise<void>;
}

function renderTree(): ReactElement<{ children: ReactElement[] }> {
  return harness().render(() => CopyId({ id: ID, label: "worker id" })) as ReactElement<{
    children: ReactElement[];
  }>;
}
const button = (tree: ReturnType<typeof renderTree>) =>
  (tree.props.children[0] as ReactElement<ButtonProps>).props;
const toast = (tree: ReturnType<typeof renderTree>) =>
  (tree.props.children[1] as ReactElement<{ className: string; children: string }>).props;

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  h.harness = createHookHarness();
  vi.useFakeTimers();
  writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CopyId", () => {
  it("at rest: a copy icon named for what it copies, and an empty polite status", () => {
    const tree = renderTree();
    expect(button(tree).icon).toBe("copy");
    expect(button(tree).label).toBe("Copy worker id");
    expect(toast(tree).children).toBe("");
    expect(toast(tree).className).toBe("copy-id__toast");
  });

  it("copies the FULL id, morphs to a check and shows 'Copied' for 1.2s, then reverts", async () => {
    await button(renderTree()).onClick();
    expect(writeText).toHaveBeenCalledWith(ID);

    let tree = renderTree();
    expect(button(tree).icon).toBe("check");
    expect(button(tree).label).toBe("Copied");
    expect(toast(tree).children).toBe("Copied");
    expect(toast(tree).className).toBe("copy-id__toast copy-id__toast--on");

    expect(COPIED_FEEDBACK_MS).toBe(1200);
    vi.advanceTimersByTime(COPIED_FEEDBACK_MS - 1);
    expect(button(renderTree()).icon).toBe("check");
    vi.advanceTimersByTime(1);
    tree = renderTree();
    expect(button(tree).icon).toBe("copy");
    expect(toast(tree).children).toBe("");
  });

  it("claims nothing when the clipboard is refused", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    await button(renderTree()).onClick();
    const tree = renderTree();
    expect(button(tree).icon).toBe("copy");
    expect(toast(tree).children).toBe("");
  });

  it("renders a real button beside the id, never inside its link", () => {
    const out = renderToStaticMarkup(renderTree());
    expect(out).toMatch(/^<span class="copy-id"><button type="button"/);
    expect(out).not.toContain("<a ");
    expect(out).toContain('role="status" aria-live="polite"');
  });
});
