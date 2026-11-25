import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { createHookHarness, type HookHarness } from "../../../../test/hook-harness";

/**
 * #3058 — one App versions card, render by render: a RAISED minimum asks first (and saves only on
 * confirm); a lowered minimum, or a latest-only change, saves at once; every save sends the whole
 * row with message_key unchanged; a bad value stops at its field; a 503 says the database step is
 * pending; success is the shared toast ("Saved" / "No change").
 */
const h = vi.hoisted(() => ({
  harness: null as unknown,
  show: null as unknown,
}));
const harness = () => h.harness as HookHarness;

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useState: (initial: unknown) => harness().useState(initial),
    useId: () => ":r0:",
    useTransition: () => [false, (run: () => Promise<void>) => void run()],
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
// The dialog itself is pinned in components/confirm-dialog.render.test.tsx; here it is a stand-in
// whose props (open, question, diff, onConfirm) are what the card decides.
vi.mock("../../../components/confirm-dialog", () => ({
  ConfirmDialog: (p: { open: boolean; description?: ReactNode }) =>
    p.open ? <div data-confirm>{p.description}</div> : null,
}));
vi.mock("../../../components/toast", () => ({
  useToast: () => ({ show: (...a: unknown[]) => (h.show as (...x: unknown[]) => void)(...a) }),
}));

const saveAppReleasePolicyAction = vi.fn();
vi.mock("./actions", () => ({
  saveAppReleasePolicyAction: (...args: unknown[]) => saveAppReleasePolicyAction(...args),
}));

const { AppVersionCard } = await import("./app-version-card");

const POLICY = {
  app: "payer" as const,
  platform: "ios" as const,
  min_supported_build: 40,
  latest_build: 45,
  store_url: "https://apps.apple.com/app/id1",
  message_key: "update_soon",
  updated_by: null,
  updated_at: "2026-11-25T04:00:00.000Z",
};

function walk(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(walk);
  if (node === null || typeof node !== "object" || !("props" in node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  return [el, ...walk(el.props.children as ReactNode)];
}

const tree = () =>
  harness().render(() => AppVersionCard({ policy: POLICY, selfId: "me" })) as ReactElement;
const html = () => renderToStaticMarkup(tree());
const input = (field: string) =>
  walk(tree()).find((el) => el.props.id === `app-version-payer-ios-${field}`)!;
const type = (field: string, value: string) =>
  (input(field).props.onChange as (e: { target: { value: string } }) => void)({
    target: { value },
  });
const submit = () =>
  (walk(tree()).find((el) => el.type === "form")!.props.onSubmit as (e: unknown) => void)({
    preventDefault: () => {},
  });
const confirmDialog = () => walk(tree()).find((el) => "confirmLabel" in el.props)!.props;

async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

const saved = (over: Record<string, unknown> = {}) => ({
  ok: true,
  changed: true,
  policy: { ...POLICY, updated_by: "me", updated_at: "2026-11-25T06:00:00.000Z", ...over },
});

beforeEach(() => {
  h.harness = createHookHarness();
  h.show = vi.fn();
  saveAppReleasePolicyAction.mockReset();
});

describe("raising the minimum asks first", () => {
  it("opens the confirm with the issue's question and the change, and sends nothing yet", () => {
    type("min_supported_build", "50");
    type("latest_build", "52");
    submit();
    const dialog = confirmDialog();
    expect(dialog.open).toBe(true);
    expect(dialog.tier).toBe("consequential");
    expect(dialog.askReason).toBe(false);
    expect(dialog.description).toBe(
      "Every company app on iOS older than build 50 will be stopped until it updates. Continue?",
    );
    expect(dialog.changes).toEqual([
      { label: "Minimum build", before: "40", after: "50" },
      { label: "Latest build", before: "45", after: "52" },
    ]);
    expect(saveAppReleasePolicyAction).not.toHaveBeenCalled();
  });

  it("Cancel sends nothing", () => {
    type("min_supported_build", "50");
    type("latest_build", "50");
    submit();
    (confirmDialog().onClose as () => void)();
    expect(confirmDialog().open).toBe(false);
    expect(saveAppReleasePolicyAction).not.toHaveBeenCalled();
  });

  it("confirming saves the whole row, message_key unchanged, and toasts Saved", async () => {
    saveAppReleasePolicyAction.mockResolvedValueOnce(
      saved({ min_supported_build: 50, latest_build: 50 }),
    );
    type("min_supported_build", "50");
    type("latest_build", "50");
    submit();
    const outcome = await (confirmDialog().onConfirm as () => Promise<unknown>)();
    expect(saveAppReleasePolicyAction).toHaveBeenCalledWith({
      app: "payer",
      platform: "ios",
      min_supported_build: 50,
      latest_build: 50,
      store_url: "https://apps.apple.com/app/id1",
      message_key: "update_soon",
    });
    expect(outcome).toEqual({ ok: true, changed: true, message: "Saved" });
    expect(h.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Saved", tone: "success" }),
    );
    expect(input("min_supported_build").props.value).toBe("50");
  });

  it("a 503 on confirm is the pending database step, returned to the dialog", async () => {
    saveAppReleasePolicyAction.mockResolvedValueOnce({
      ok: false,
      kind: "not_ready",
      error: "Not available yet: the database step is pending.",
    });
    type("min_supported_build", "50");
    type("latest_build", "50");
    submit();
    const outcome = await (confirmDialog().onConfirm as () => Promise<unknown>)();
    expect(outcome).toEqual({
      ok: false,
      error: "Not available yet: the database step is pending.",
    });
    expect(h.show).not.toHaveBeenCalled();
  });
});

describe("no confirm for anything else", () => {
  it("lowering the minimum saves at once", async () => {
    saveAppReleasePolicyAction.mockResolvedValueOnce(saved({ min_supported_build: 30 }));
    type("min_supported_build", "30");
    submit();
    await flush();
    expect(confirmDialog().open).toBe(false);
    expect(saveAppReleasePolicyAction).toHaveBeenCalledWith(
      expect.objectContaining({
        min_supported_build: 30,
        latest_build: 45,
        message_key: "update_soon",
      }),
    );
  });

  it("a latest-only or link-only change saves at once; an emptied link is sent as null", async () => {
    saveAppReleasePolicyAction.mockResolvedValue(saved());
    type("latest_build", "60");
    submit();
    await flush();
    type("store_url", "");
    submit();
    await flush();
    expect(confirmDialog().open).toBe(false);
    expect(saveAppReleasePolicyAction).toHaveBeenCalledTimes(2);
    expect(saveAppReleasePolicyAction.mock.calls[1]![0]).toMatchObject({ store_url: null });
  });

  it("a save that matched what was there toasts No change", async () => {
    saveAppReleasePolicyAction.mockResolvedValueOnce({ ...saved(), changed: false });
    submit();
    await flush();
    expect(h.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: "No change", tone: "info" }),
    );
  });
});

describe("errors stay at their field or in the card", () => {
  it("a latest below the minimum, a decimal and an http link stop before the network", () => {
    type("min_supported_build", "1.5");
    type("latest_build", "10");
    type("store_url", "http://example.com");
    submit();
    const out = html();
    expect(out).toContain("Enter a whole number from 0 to 2147483647.");
    expect(out).toContain("Enter a full link that starts with https:// and has no spaces.");
    expect(input("min_supported_build").props["aria-invalid"]).toBe("true");
    expect(saveAppReleasePolicyAction).not.toHaveBeenCalled();
    expect(confirmDialog().open).toBe(false);

    type("min_supported_build", "20");
    type("store_url", "");
    submit();
    expect(html()).toContain("The latest build must be at least the minimum build.");
    expect(saveAppReleasePolicyAction).not.toHaveBeenCalled();
  });

  it("a 503 on a direct save says the database step is pending, in the card", async () => {
    saveAppReleasePolicyAction.mockResolvedValueOnce({
      ok: false,
      kind: "not_ready",
      error: "Not available yet: the database step is pending.",
    });
    type("latest_build", "60");
    submit();
    await flush();
    const out = html();
    expect(out).toContain("Company app iOS was not saved");
    expect(out).toContain("Not available yet: the database step is pending.");
    expect(input("latest_build").props.value).toBe("60");
  });
});
