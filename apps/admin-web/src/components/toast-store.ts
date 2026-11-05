/**
 * The toast stack's pure state (A5, #2575) — what `ToastProvider` holds, without React, so the
 * stacking, timing and Undo rules are unit-testable in the node env (toast-store.test.ts).
 */

/** How long a reversible (T1) action can be undone: the Undo toast stays this long. */
export const UNDO_WINDOW_MS = 8000;
/** How long a plain notice stays. */
export const TOAST_MS = 5000;
/** The most toasts on screen at once; the oldest leaves first. */
export const MAX_TOASTS = 3;

export type ToastTone = "info" | "success" | "danger";

export interface ToastOptions {
  message: string;
  tone?: ToastTone;
  /** Offered as an Undo button; a toast with an Undo stays UNDO_WINDOW_MS unless told otherwise. */
  undo?: () => void;
  durationMs?: number;
}

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
  undo?: () => void;
  durationMs: number;
}

/** A toast with its defaults filled in. */
export function makeToast(id: number, opts: ToastOptions): Toast {
  return {
    id,
    message: opts.message,
    tone: opts.tone ?? "info",
    undo: opts.undo,
    durationMs: opts.durationMs ?? (opts.undo ? UNDO_WINDOW_MS : TOAST_MS),
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
