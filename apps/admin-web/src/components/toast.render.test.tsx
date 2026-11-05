import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ToastProvider, ToastStack } from "./toast";
import {
  MAX_TOASTS,
  TOAST_MS,
  UNDO_WINDOW_MS,
  makeToast,
  pushToast,
  removeToast,
} from "./toast-store";

/** A5 (#2575) — the Toast primitive: a stack with Undo. */
describe("toast store", () => {
  it("an Undo toast stays the 8-second undo window; a plain one the shorter notice time", () => {
    expect(UNDO_WINDOW_MS).toBe(8000);
    expect(makeToast(1, { message: "Hidden", undo: () => {} }).durationMs).toBe(8000);
    expect(makeToast(2, { message: "Saved" }).durationMs).toBe(TOAST_MS);
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
});
