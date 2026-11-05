/**
 * The toast stack's pure state (A5, #2575) — what `ToastProvider` holds, without React, so the
 * stacking, timing and Undo rules are unit-testable in the node env (toast-store.test.ts).
 */

/** How long a reversible (T1) action can be undone: the Undo toast stays this long. */
export const UNDO_WINDOW_MS = 8000;
/** How long a plain success/info notice stays (#2689 rule 2). */
export const TOAST_MS = 4000;
/** How long a failure stays: long enough to read and act on. */
export const TOAST_ERROR_MS = 6000;
/** A toast with a single action (Undo / Retry / View) stays this long. */
export const TOAST_ACTION_MS = 8000;
/** The most toasts on screen at once; the oldest leaves first. */
export const MAX_TOASTS = 3;

export type ToastTone = "info" | "success" | "danger";

/**
 * At most ONE action per toast (#2689 rule 2). `href` and `onClick` are mutually exclusive in
 * practice; neither is required, and a toast without an action is a plain notice.
 */
export interface ToastAction {
  label: string;
  href?: string;
  onClick?: () => void;
}

export interface ToastOptions {
  message: string;
  tone?: ToastTone;
  /** Offered as an Undo button; a toast with an Undo stays UNDO_WINDOW_MS unless told otherwise. */
  undo?: () => void;
  /** A single named action ("View in timeline", "Retry"). */
  action?: ToastAction;
  durationMs?: number;
}

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
  undo?: () => void;
  action?: ToastAction;
  durationMs: number;
}

/**
 * A toast with its defaults filled in. Explicit `durationMs` wins; otherwise an action or Undo
 * gets the 8-second action window, a failure 6 seconds, and a quiet success/info 4.
 */
export function makeToast(id: number, opts: ToastOptions): Toast {
  return {
    id,
    message: opts.message,
    tone: opts.tone ?? "info",
    undo: opts.undo,
    action: opts.action,
    durationMs:
      opts.durationMs ??
      (opts.undo || opts.action
        ? TOAST_ACTION_MS
        : opts.tone === "danger"
          ? TOAST_ERROR_MS
          : TOAST_MS),
  };
}

/** The stack with `toast` added at the end (newest last), trimmed to MAX_TOASTS. */
export function pushToast(stack: readonly Toast[], toast: Toast): Toast[] {
  return [...stack, toast].slice(-MAX_TOASTS);
}

/** The stack without toast `id`. */
export function removeToast(stack: readonly Toast[], id: number): Toast[] {
  return stack.filter((t) => t.id !== id);
}
