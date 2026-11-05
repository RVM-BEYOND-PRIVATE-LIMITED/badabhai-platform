import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ToastProvider, ToastStack } from "./toast";
import {
  MAX_TOASTS,
  TOAST_ACTION_MS,
  TOAST_ERROR_MS,
  TOAST_MS,
  UNDO_WINDOW_MS,
  makeToast,
  pushToast,
  removeToast,
} from "./toast-store";

/** A5 (#2575) — the Toast primitive: a stack with Undo. */
describe("toast store", () => {
  it("uses the #2689 timings: 4s quiet, 6s error, 8s with an action or Undo", () => {
    expect(UNDO_WINDOW_MS).toBe(8000);
    expect(TOAST_MS).toBe(4000);
    expect(TOAST_ERROR_MS).toBe(6000);
    expect(TOAST_ACTION_MS).toBe(8000);
    expect(makeToast(1, { message: "Hidden", undo: () => {} }).durationMs).toBe(8000);
    expect(makeToast(2, { message: "Saved" }).durationMs).toBe(4000);
    expect(makeToast(5, { message: "Refused", tone: "danger" }).durationMs).toBe(6000);
    expect(
      makeToast(6, { message: "Saved", action: { label: "View", href: "/events" } }).durationMs,
    ).toBe(8000);
    expect(makeToast(3, { message: "Saved", durationMs: 100 }).durationMs).toBe(100);
    expect(makeToast(4, { message: "Saved" }).tone).toBe("info");
  });

  it("stacks newest last and keeps at most MAX_TOASTS, dropping the oldest", () => {
    let stack = [] as ReturnType<typeof pushToast>;
    for (let id = 1; id <= MAX_TOASTS + 2; id++)
      stack = pushToast(stack, makeToast(id, { message: `#${id}` }));
    expect(stack.map((t) => t.id)).toEqual([3, 4, 5]);
    expect(removeToast(stack, 4).map((t) => t.id)).toEqual([3, 5]);
  });
});

describe("the toast stack", () => {
  it("keeps an always-present polite live region, so a new toast is announced", () => {
    const out = renderToStaticMarkup(
      <ToastProvider>
        <p>page</p>
      </ToastProvider>,
    );
    expect(out).toBe(
      '<p>page</p><section class="toasts" aria-label="Notifications">' +
        '<ol class="toasts__list" aria-live="polite" aria-relevant="additions"></ol></section>',
    );
  });

  it("an Undo toast offers Undo and drains its bar over the undo window", () => {
    const out = renderToStaticMarkup(
      <ToastStack
        toasts={[makeToast(1, { message: "Posting hidden", tone: "success", undo: () => {} })]}
        onRemoved={() => {}}
      />,
    );
    expect(out).toContain('<li class="toast toast--success" data-state="open">');
    expect(out).toContain('<p class="toast__message">Posting hidden</p>');
    expect(out).toContain("<span>Undo</span>");
    expect(out).toContain('aria-label="Dismiss"');
    expect(out).toContain(
      '<span class="toast__timer" aria-hidden="true" style="animation-duration:8000ms"></span>',
    );
  });

  it("a plain toast has no Undo and no timer bar", () => {
    const out = renderToStaticMarkup(
      <ToastStack toasts={[makeToast(1, { message: "Saved" })]} onRemoved={() => {}} />,
    );
    expect(out).toContain('<li class="toast toast--info" data-state="open">');
    expect(out).not.toContain("Undo");
    expect(out).not.toContain("toast__timer");
  });

  it("a toast carries at most one named action, with its timer", () => {
    const out = renderToStaticMarkup(
      <ToastStack
        toasts={[
          makeToast(1, {
            message: "Account suspended.",
            tone: "success",
            action: { label: "View in timeline", href: "/companies/p-1/timeline" },
          }),
        ]}
        onRemoved={() => {}}
      />,
    );
    expect(out).toContain('href="/companies/p-1/timeline"');
    expect(out).toContain(">View in timeline<");
    expect(out).toContain("toast__timer");
  });
});
