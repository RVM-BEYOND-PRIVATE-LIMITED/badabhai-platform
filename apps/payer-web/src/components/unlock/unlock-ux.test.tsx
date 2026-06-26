import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { Button } from "../ds";
import { NEUTRAL_UNLOCK_MESSAGE } from "../../lib/unlock-view";
import type { ContactView } from "../../lib/unlock-view";
import { ConfirmSpendDialog, RoutedContactCard, UnlockResultToast } from "./index";

/**
 * SHARED unlock→reveal UX tests (DS1.5) — assert on the extracted components directly.
 *
 * Env is node (no DOM). The components are presentational; we render each to an element tree and
 * walk it. ConfirmSpendDialog is a PURE wrapper over the hooked DS Dialog — we invoke ONLY the
 * wrapper (no hook) and read the inner Dialog's `footer` Buttons; we never invoke the inner Dialog.
 * Covers: (a) routed card shows relayHandle + channel and leaks no phone/number/email/10-digit
 * run; (b) confirm fires onConfirm once / cancel fires onCancel; (c) ONE neutral failure line.
 */

/** Flatten text — EXPANDS pure (hook-free) function components, never the hooked DS Dialog. */
function deepText(node: ReactNode, seen: WeakSet<object> = new WeakSet()): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return ` ${node} `;
  if (Array.isArray(node)) return node.map((n) => deepText(n, seen)).join("");
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode; footer?: ReactNode }>;
  if (seen.has(el)) return "";
  seen.add(el);
  const isDialog = typeof el.type === "function" && (el.type as { name?: string }).name === "Dialog";
  if (typeof el.type === "function" && !isDialog) {
    return deepText((el.type as (p: unknown) => ReactNode)(el.props), seen);
  }
  let out = "";
  if (el.props && "footer" in el.props) out += deepText(el.props.footer as ReactNode, seen);
  if (el.props && "children" in el.props) out += deepText(el.props.children as ReactNode, seen);
  return out;
}

/** Collect DS `Button` elements (text + onClick) anywhere in the tree, incl. a Dialog `footer`. */
function collectButtons(node: ReactNode, acc: Array<{ text: string; onClick?: () => void }> = []) {
  if (node === null || node === undefined || typeof node === "boolean") return acc;
  if (typeof node === "string" || typeof node === "number") return acc;
  if (Array.isArray(node)) {
    node.forEach((n) => collectButtons(n, acc));
    return acc;
  }
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode; footer?: ReactNode }>;
  if (el.type === Button) {
    acc.push({ text: deepText(el.props.children as ReactNode).trim(), onClick: el.props.onClick as (() => void) | undefined });
  }
  if (el.props && "footer" in el.props) collectButtons(el.props.footer as ReactNode, acc);
  if (el.props && "children" in el.props) collectButtons(el.props.children as ReactNode, acc);
  return acc;
}

describe("RoutedContactCard — routed relay ONLY, never a phone (ADR-0010 F-4)", () => {
  const view: Extract<ContactView, { kind: "routed" }> = {
    kind: "routed",
    relayHandle: "RELAY-7h3k9q",
    channel: "in_app_relay",
    expiresAt: "2026-07-01T00:00:00.000Z",
  };

  it("renders the opaque relay handle + channel label + expiry", () => {
    const text = deepText(RoutedContactCard({ view }) as ReactElement);
    expect(text).toContain("RELAY-7h3k9q"); // the opaque handle
    expect(text).toContain("In-app relay"); // channel is in_app_relay | proxy_number ONLY
    expect(text).toContain("2026-07-01"); // expiry (date-only)
    expect(text).toContain("not a phone number"); // the explicit faceless guarantee copy
  });

  it("leaks no phone digits / email / number field in its output", () => {
    const text = deepText(RoutedContactCard({ view }) as ReactElement);
    expect(text).not.toMatch(/\d{10,}/); // no 10+ digit phone run
    expect(text).not.toMatch(/\+\d{7,}/); // no +country-code phone
    expect(text).not.toMatch(/@/); // no email
    // Structural: the routed ContactView has no phone/number field for the card to render.
    expect(view).not.toHaveProperty("phone");
    expect(view).not.toHaveProperty("number");
  });

  it("renders the proxy_number channel label when the channel is a proxy number", () => {
    const text = deepText(RoutedContactCard({ view: { ...view, channel: "proxy_number" } }) as ReactElement);
    expect(text).toContain("Proxy number");
    expect(text).not.toMatch(/\d{10,}/); // still no phone digits — only a channel LABEL
  });
});

describe("ConfirmSpendDialog — fires onConfirm once on confirm, onCancel on cancel (state-free)", () => {
  function footerButtons(props: { open: boolean; onCancel: () => void; onConfirm: () => void }) {
    // Invoke ONLY the pure wrapper to get the inner <Dialog footer=…>; never invoke the Dialog.
    const inner = ConfirmSpendDialog(props) as ReactElement<{ footer?: ReactNode }>;
    return collectButtons(inner.props.footer as ReactNode);
  }

  it("the confirm Button calls onConfirm exactly once (and not onCancel)", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const btns = footerButtons({ open: true, onConfirm, onCancel });
    const confirm = btns.find((b) => b.text.includes("Unlock · 1 credit"));
    expect(confirm).toBeDefined();
    confirm!.onClick!();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("the cancel Button calls onCancel (and not onConfirm)", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const btns = footerButtons({ open: true, onConfirm, onCancel });
    const cancel = btns.find((b) => b.text === "Cancel");
    expect(cancel).toBeDefined();
    cancel!.onClick!();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("the body copy is neutral + faceless: '1 credit', no candidate detail", () => {
    const inner = ConfirmSpendDialog({ open: true, onCancel: () => {}, onConfirm: () => {} }) as ReactElement<{ children?: ReactNode }>;
    const body = deepText(inner.props.children as ReactNode);
    expect(body).toContain("1 credit");
    expect(body).toContain("never a phone number");
    expect(body).not.toMatch(/\d{10,}/);
  });
});

describe("UnlockResultToast — ONE neutral failure line, no cause (no-oracle, XB-C)", () => {
  it("the failure toast renders exactly the single neutral NEUTRAL_UNLOCK_MESSAGE (no extra cause)", () => {
    const text = deepText(UnlockResultToast({ kind: "unavailable" }) as ReactElement);
    // The toast reuses the mapper's single message verbatim — it adds NO cause-bearing string of
    // its own. The canonical message itself enumerates the causes ("no consent, capped, no
    // credits, and already-unlocked all look identical") precisely to assert none is THE cause;
    // so the no-oracle check is that the failure body IS the canonical line, not a cause-specific
    // one. We assert the rendered failure text contains ONLY tokens from the canonical message
    // (plus the neutral title) — no cause word appears OUTSIDE that single neutral sentence.
    expect(text).toContain(NEUTRAL_UNLOCK_MESSAGE);
    const residue = text.replace(NEUTRAL_UNLOCK_MESSAGE, "").replace(/\s+/g, " ");
    expect(residue).not.toMatch(/consent|capped|credits?|already.?unlocked|no[- ]consent/i);
    // And it stays faceless — no phone digits / email anywhere.
    expect(text).not.toMatch(/\d{10,}/);
    expect(text).not.toMatch(/@/);
  });

  it("the failure copy is identical regardless of how it was produced (byte-stable)", () => {
    const a = deepText(UnlockResultToast({ kind: "unavailable" }) as ReactElement);
    const b = deepText(UnlockResultToast({ kind: "unavailable" }) as ReactElement);
    expect(a).toEqual(b);
  });

  it("the success toast is a neutral confirmation with no cause and no PII", () => {
    const text = deepText(UnlockResultToast({ kind: "granted" }) as ReactElement);
    expect(text).toContain("Contact unlocked");
    expect(text).not.toMatch(/\d{10,}/);
    expect(text).not.toMatch(/@/);
  });
});
