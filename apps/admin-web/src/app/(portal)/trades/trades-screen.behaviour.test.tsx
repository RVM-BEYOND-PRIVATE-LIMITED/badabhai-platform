import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { createHookHarness, type HookHarness } from "../../../../test/hook-harness";

/**
 * #3023 — the trade catalogue's client half, render by render: the two filters only NARROW the
 * server order; a switch opens an explicit dialog; Cancel changes nothing; Confirm calls the
 * action and shows the new state; a refusal keeps the old state and shows the server's message.
 */
const h = vi.hoisted(() => ({
  harness: null as unknown,
  overlay: null as Record<string, unknown> | null,
}));
const harness = () => h.harness as HookHarness;

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useState: (initial: unknown) => harness().useState(initial),
    useId: () => ":r0:",
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("../../../components/overlay", () => ({
  Overlay: (props: Record<string, unknown> & { open: boolean; children?: ReactNode }) => {
    h.overlay = props;
    return props.open ? <div data-dialog>{props.children}</div> : null;
  },
}));
vi.mock("./held-roles-panel", () => ({
  HeldRolesPanel: () => <section data-held />,
}));

const updateTradeReleaseAction = vi.fn();
vi.mock("./actions", () => ({
  updateTradeReleaseAction: (...args: unknown[]) => updateTradeReleaseAction(...args),
}));

const { TradesScreen } = await import("./trades-screen");

const row = (over: Record<string, unknown> = {}) => ({
  role_kind: "cnc_turner",
  role_label: "CNC Turner",
  department: "production",
  department_label: "Production",
  kind: "shop_floor" as const,
  wave: 1,
  posting_enabled: false,
  form_enabled: false,
  posting_changed_at: null,
  form_changed_at: null,
  updated_by: "a-1",
  updated_at: "2026-11-21T10:30:00.000Z",
  ...over,
});

const ROWS = [
  row(),
  row({
    role_kind: "arc_welder",
    role_label: "Arc Welder",
    department: "fabrication",
    department_label: "Fabrication",
    wave: 2,
    posting_enabled: true,
  }),
  row({
    role_kind: "design_checker",
    role_label: "Design Checker",
    department: "design",
    department_label: "Design",
    kind: "desk" as const,
    wave: null,
  }),
];

function walk(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(walk);
  if (node === null || typeof node !== "object" || !("props" in node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  return [el, ...walk(el.props.children as ReactNode)];
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node === null || typeof node !== "object" || !("props" in node)) return "";
  return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
}

const tree = () =>
  harness().render(() =>
    TradesScreen({ rows: ROWS, canWrite: true, held: [], heldState: "ready" }),
  ) as ReactElement;

const html = () => renderToStaticMarkup(tree());
const button = (label: string) =>
  walk(tree()).find((el) => el.type === "button" && textOf(el).includes(label));
const switchFor = (label: string) =>
  walk(tree()).find((el) => el.type === "button" && el.props["aria-label"] === label);
const click = (el: ReactElement<Record<string, unknown>> | undefined) =>
  (el!.props.onClick as () => void)();
const change = (
  el: ReactElement<Record<string, unknown>> | undefined,
  value: string,
) =>
  (el!.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value },
  });
const selectWith = (option: string) =>
  walk(tree()).find(
    (el) =>
      el.type === "select" &&
      walk(el.props.children as ReactNode).some(
        (child) => child.type === "option" && textOf(child).includes(option),
      ),
  );

async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

beforeEach(() => {
  h.harness = createHookHarness();
  h.overlay = null;
  updateTradeReleaseAction.mockReset();
});

describe("the filters", () => {
  it("narrows by department and keeps the server order", () => {
    change(selectWith("All departments"), "fabrication");
    const out = html();
    expect(out).toContain("Arc Welder");
    expect(out).not.toContain("CNC Turner");
    expect(out).not.toContain("Design Checker");
  });

  it("narrows by posting and form status", () => {
    change(selectWith("All trades"), "posting_on");
    expect(html()).toContain("Arc Welder");
    expect(html()).not.toContain("CNC Turner");

    change(selectWith("All trades"), "form_off");
    expect(html()).toContain("CNC Turner");
    expect(html()).toContain("Arc Welder");
  });

  it("says when no trade matches", () => {
    change(selectWith("All departments"), "design");
    change(selectWith("All trades"), "posting_on");
    expect(html()).toContain("No trades match these filters");
  });
});

describe("a switch's confirm dialog", () => {
  it("names the trade and the exact change, and is not dismissible by the scrim or Escape", () => {
    click(switchFor("Posting for CNC Turner"));
    expect(html()).toContain("Turn posting on for CNC Turner");
    expect(h.overlay?.dismissible).toBe(false);
  });

  it("Cancel closes it and changes nothing", () => {
    click(switchFor("Form hand-over for CNC Turner"));
    click(button("Cancel"));
    expect(html()).not.toContain("Turn the form hand-over on for CNC Turner");
    expect(updateTradeReleaseAction).not.toHaveBeenCalled();
    expect(switchFor("Form hand-over for CNC Turner")!.props["aria-checked"]).toBe(false);
  });

  it("Confirm calls the action and shows the new state", async () => {
    updateTradeReleaseAction.mockResolvedValueOnce({
      ok: true,
      row: row({
        posting_enabled: true,
        posting_changed_at: "2026-11-24T09:00:00.000Z",
      }),
    });
    click(switchFor("Posting for CNC Turner"));
    click(button("Confirm"));
    await flush();
    expect(updateTradeReleaseAction).toHaveBeenCalledWith({
      roleKind: "cnc_turner",
      postingEnabled: true,
    });
    expect(switchFor("Posting for CNC Turner")!.props["aria-checked"]).toBe(true);
    expect(html()).toContain("Turn posting on for CNC Turner — saved.");
    expect(html()).not.toContain('data-dialog=""');
  });

  it("keeps the old state and shows the server's refusal in the dialog", async () => {
    updateTradeReleaseAction.mockResolvedValueOnce({
      ok: false,
      error: "Wave 1 is frozen for review.",
    });
    click(switchFor("Posting for CNC Turner"));
    click(button("Confirm"));
    await flush();
    expect(switchFor("Posting for CNC Turner")!.props["aria-checked"]).toBe(false);
    expect(html()).toContain("Wave 1 is frozen for review.");
    expect(html()).toContain("Turn posting on for CNC Turner");
  });
});
