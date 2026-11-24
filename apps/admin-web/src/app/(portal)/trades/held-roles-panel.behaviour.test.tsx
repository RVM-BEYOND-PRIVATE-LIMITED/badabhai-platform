import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { createHookHarness, type HookHarness } from "../../../../test/hook-harness";

/**
 * #3023 — the held list: names and counts only, sorted by count desc (server order kept on a
 * tie), and "Copy list" writes that exact short list to the clipboard with an announced
 * confirmation. A refused clipboard claims nothing.
 */
const h = vi.hoisted(() => ({ harness: null as unknown }));
const harness = () => h.harness as HookHarness;

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useState: (initial: unknown) => harness().useState(initial),
  };
});

const { HeldRolesPanel } = await import("./held-roles-panel");

const ROLES = [
  { role_label: "Lathe Setter", count: 2 },
  { role_label: "CNC Operator", count: 4 },
  { role_label: "Press Operator", count: 4 },
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
  harness().render(() => HeldRolesPanel({ roles: ROLES, state: "ready" })) as ReactElement;
const copyButton = () =>
  walk(tree()).find(
    (el) =>
      el.type === "button" &&
      (textOf(el).includes("Copy list") || textOf(el).includes("Copied")),
  );

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  h.harness = createHookHarness();
  writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
});
afterEach(() => vi.unstubAllGlobals());

describe("the held list", () => {
  it("renders each role name and count, sorted by count desc with ties in server order", () => {
    const out = renderToStaticMarkup(tree());
    const cnc = out.indexOf("CNC Operator");
    const press = out.indexOf("Press Operator");
    const lathe = out.indexOf("Lathe Setter");
    expect(cnc).toBeGreaterThanOrEqual(0);
    expect(cnc).toBeLessThan(press);
    expect(press).toBeLessThan(lathe);
    expect(out).toContain("CNC Operator · 4");
    expect(out).toContain("Lathe Setter · 2");
  });

  it("copies the short list and announces it", async () => {
    (copyButton()!.props.onClick as () => Promise<void>)();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(
      "CNC Operator — 4\nPress Operator — 4\nLathe Setter — 2",
    );
    const out = renderToStaticMarkup(tree());
    expect(out).toContain("Copied the held roles to the clipboard.");
    expect(textOf(copyButton()!.props.children as ReactNode)).toContain("Copied");
  });

  it("claims nothing when the clipboard is refused", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    await (copyButton()!.props.onClick as () => Promise<void>)();
    expect(renderToStaticMarkup(tree())).not.toContain("Copied the held roles");
  });
});
