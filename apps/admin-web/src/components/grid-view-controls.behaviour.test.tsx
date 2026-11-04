import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createHookHarness, type HookHarness } from "../../test/hook-harness";
import type { GridColumnMeta as Meta } from "./data-grid-model";

/**
 * A grid's view controls (A4, #2574): the column chooser and the density toggle — the VIEWER's
 * preferences, kept in their own browser (`grid-preferences.ts`), changing nothing on the server.
 *
 * Markup through the real renderer; behaviour through the hook harness — `useState`/`useId` keep
 * the chooser's open state across renders, `useEffect` is recorded so a test can run the open
 * chooser's listeners by hand against a stub document.
 */
type Effect = () => void | (() => void);
const h = vi.hoisted(() => ({
  harness: null as unknown,
  effects: [] as Effect[],
  refs: [] as { current: unknown }[],
  refCalls: 0,
  live: false,
}));
const harness = () => h.harness as HookHarness;

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useState: (initial: unknown) => (h.live ? harness().useState(initial) : actual.useState(initial)),
    useId: () => (h.live ? harness().useId() : actual.useId()),
    useRef: (initial: unknown) => {
      if (!h.live) return actual.useRef(initial);
      const at = h.refCalls++;
      h.refs[at] ??= { current: initial };
      return h.refs[at]!;
    },
    useEffect: (run: Effect) => {
      if (h.live) h.effects.push(run);
    },
  };
});

const { GridViewControls } = await import("./grid-view-controls");
const { readColumnChoices, readDensity, resetGridPreferencesForTests, writeColumnChoices, writeDensity } =
  await import("./grid-preferences");


const COLUMNS: Meta[] = [
  { id: "name", header: "Name", width: "fill", locked: true, defaultHidden: false, group: "Identity" },
  { id: "status", header: "Status", width: "status", locked: false, defaultHidden: false, group: "Identity" },
  { id: "city", header: "City", width: "fill", locked: false, defaultHidden: true, group: "Work" },
];

function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const props = node.props as { children?: ReactNode };
  return [node, ...elements(props.children)];
}

const markup = (choices = {}, density: "comfortable" | "compact" = "comfortable") =>
  renderToStaticMarkup(
    <GridViewControls gridId="g" columns={COLUMNS} choices={choices} density={density} />,
  );

/** One render of the chooser (the component GridViewControls draws), with live hooks. */
function chooser(choices: Record<string, boolean> = {}) {
  const outer = GridViewControls({ gridId: "g", columns: COLUMNS, choices, density: "comfortable" });
  const el = elements(outer).find(
    (e) => typeof e.type === "function" && (e.type as { name?: string }).name === "ColumnChooser",
  ) as ReactElement<Record<string, unknown>>;
  expect(el, "the column chooser").toBeDefined();
  h.effects = [];
  return harness().render(() => {
    h.refCalls = 0;
    return (el.type as (p: unknown) => ReactNode)(el.props);
  });
}
const toggle = (tree: ReactNode) =>
  elements(tree).find((e) => e.type === "button" && "aria-expanded" in (e.props as object)) as ReactElement<{
    onClick: () => void;
    "aria-expanded": boolean;
    children?: ReactNode;
  }>;
const panel = (tree: ReactNode) =>
  elements(tree).find((e) => (e.props as { className?: string }).className === "grid-menu__panel") as ReactElement<{
    "data-open": string;
  }>;
const checkbox = (tree: ReactNode, label: string) => {
  const option = elements(tree).find(
    (e) =>
      e.type === "label" &&
      elements((e.props as { children?: ReactNode }).children).some(
        (c) => c.type === "span" && (c.props as { children?: ReactNode }).children === label,
      ),
  );
  expect(option, label).toBeDefined();
  return elements((option!.props as { children?: ReactNode }).children).find(
    (e) => e.type === "input",
  ) as ReactElement<{ checked: boolean; disabled: boolean; onChange: (e: unknown) => void }>;
};

beforeEach(() => {
  resetGridPreferencesForTests();
  h.harness = createHookHarness();
  h.refs = [];
  h.effects = [];
  h.live = false;
});
afterEach(() => vi.unstubAllGlobals());

describe("the column chooser's markup", () => {
  it("is a disclosure: a button naming the panel it controls, closed — hidden — at first", () => {
    const out = markup();
    const id = /aria-controls="([^"]+)"/.exec(out)?.[1];
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain(`<div class="grid-menu__panel" id="${id}" data-open="false" role="group"`);
    expect(out).toContain(">Show columns</p>");
  });

  it("lists every column under its group, the locked one checked, disabled and saying why", () => {
    const out = markup();
    expect([...out.matchAll(/<legend class="grid-menu__legend">([^<]*)</g)].map((m) => m[1])).toEqual([
      "Identity",
      "Work",
    ]);
    expect(out).toContain(
      '<input type="checkbox" disabled="" checked=""/><span>Name</span><span class="grid-menu__note">always shown</span>',
    );
    // City is hidden by default.
    expect(out).toContain('<input type="checkbox"/><span>City</span>');
  });

  it("says how many columns the viewer has hidden", () => {
    expect(markup()).toContain("Columns (1 hidden)</button>");
    expect(markup({ city: true })).toContain(">Columns</button>");
  });
});

describe("the column chooser's behaviour", () => {
  beforeEach(() => {
    h.live = true;
  });

  it("opens and closes from its button", () => {
    expect(panel(chooser())?.props["data-open"]).toBe("false");
    toggle(chooser()).props.onClick();
    const open = chooser();
    expect(toggle(open).props["aria-expanded"]).toBe(true);
    expect(panel(open).props["data-open"]).toBe("true");
  });

  it("unchecking a column stores the viewer's choice; checking it back stores nothing", () => {
    checkbox(chooser(), "Status").props.onChange({ target: { checked: false } });
    expect(readColumnChoices("g")).toBe('{"status":false}');
    checkbox(chooser({ status: false }), "Status").props.onChange({ target: { checked: true } });
    expect(readColumnChoices("g")).toBeNull();
  });

  it("showing a column hidden by default stores that one choice", () => {
    checkbox(chooser(), "City").props.onChange({ target: { checked: true } });
    expect(readColumnChoices("g")).toBe('{"city":true}');
  });

  it("never empties the grid: the last visible column cannot be unchecked", () => {
    const loose: Meta[] = COLUMNS.map((c) => ({ ...c, locked: false }));
    const outer = GridViewControls({ gridId: "g", columns: loose, choices: { name: false }, density: "comfortable" });
    const el = elements(outer).find((e) => typeof e.type === "function") as ReactElement<Record<string, unknown>>;
    const tree = harness().render(() => {
      h.refCalls = 0;
      return (el.type as (p: unknown) => ReactNode)(el.props);
    });
    expect(checkbox(tree, "Status").props.disabled).toBe(true);
    expect(checkbox(tree, "City").props.disabled).toBe(false);
  });

  it("Reset columns restores the defaults", () => {
    writeColumnChoices("g", { status: false });
    const reset = elements(chooser({ status: false })).find(
      (e) => e.type === "button" && (e.props as { children?: ReactNode }).children === "Reset columns",
    ) as ReactElement<{ onClick: () => void }>;
    reset.props.onClick();
    expect(readColumnChoices("g")).toBeNull();
  });

  it("while open, Escape closes it and gives focus back to its button; a click outside closes it", () => {
    const handlers = new Map<string, (e: unknown) => void>();
    vi.stubGlobal("document", {
      addEventListener: (type: string, fn: (e: unknown) => void) => handlers.set(type, fn),
      removeEventListener: (type: string) => handlers.delete(type),
    });
    const FakeNode = class {};
    vi.stubGlobal("Node", FakeNode);
    toggle(chooser()).props.onClick();
    chooser();
    const focus = vi.fn();
    h.refs[1]!.current = { focus }; // the toggle button
    h.refs[0]!.current = { contains: () => false }; // the chooser's root
    const cleanup = h.effects.at(-1)!() as () => void;
    expect([...handlers.keys()].sort()).toEqual(["focusin", "keydown", "pointerdown"]);

    handlers.get("keydown")!({ key: "Tab" });
    expect(toggle(chooser()).props["aria-expanded"]).toBe(true);
    handlers.get("keydown")!({ key: "Escape" });
    expect(toggle(chooser()).props["aria-expanded"]).toBe(false);
    expect(focus).toHaveBeenCalledTimes(1);
    cleanup();
    expect(handlers.size).toBe(0);

    // Open again; a press outside the chooser closes it, one inside does not.
    toggle(chooser()).props.onClick();
    chooser();
    let inside = true;
    h.refs[0]!.current = { contains: () => inside };
    h.effects.at(-1)!();
    handlers.get("pointerdown")!({ target: new FakeNode() });
    expect(toggle(chooser()).props["aria-expanded"]).toBe(true);
    inside = false;
    handlers.get("pointerdown")!({ target: new FakeNode() });
    expect(toggle(chooser()).props["aria-expanded"]).toBe(false);
  });
});

describe("the density toggle", () => {
  it("is a toggle button — its name fixed, aria-pressed carrying the state", () => {
    expect(markup()).toContain(
      '<button type="button" class="btn btn--sm btn--ghost grid__density" aria-pressed="false">',
    );
    expect(markup({}, "compact")).toContain(
      '<button type="button" class="btn btn--sm btn--selected grid__density" aria-pressed="true">',
    );
  });

  it("flips the viewer's density, for every grid", () => {
    const pressDensity = (density: "comfortable" | "compact") => {
      const button = elements(
        GridViewControls({ gridId: "g", columns: COLUMNS, choices: {}, density }),
      ).find((e) => (e.props as { className?: string }).className?.includes("grid__density")) as ReactElement<{
        onClick: () => void;
      }>;
      button.props.onClick();
    };
    pressDensity("comfortable");
    expect(readDensity()).toBe("compact");
    pressDensity("compact");
    expect(readDensity()).toBe("comfortable");
    writeDensity("comfortable");
  });
});
