"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { IconButton } from "./icon-button";
import { usePresence } from "./presence";
import { makeToast, pushToast, removeToast, type Toast, type ToastOptions } from "./toast-store";
import { runReversible, type ReversibleRun } from "../lib/confirm-tiers";

export interface ToastApi {
  /** Shows a toast; returns its id. */
  show(opts: ToastOptions): number;
}

/** Outside a provider (a unit render), toasts go nowhere rather than throwing. */
const NOOP: ToastApi = { show: () => -1 };
const ToastContext = createContext<ToastApi>(NOOP);

/** The portal's toast stack (A5, #2575). */
export function useToast(): ToastApi {
  return useContext(ToastContext);
}

/**
 * A T1 (reversible) action runner bound to the portal's toasts: act at once, then an Undo toast
 * for the undo window (`runReversible`).
 */
export function useReversibleAction(): (
  run: Omit<ReversibleRun, "show">,
) => ReturnType<typeof runReversible> {
  const { show } = useToast();
  return useCallback((run) => runReversible({ ...run, show }), [show]);
}

/**
 * Holds the toast stack for the portal (mounted once, in the portal layout) and draws it
 * bottom-right above every overlay (`--z-toast`).
 *
 * The list is a polite live region that is ALWAYS in the DOM, so a toast added to it is announced.
 * Each toast rises 6px with a fade over --duration-base and leaves over --duration-fast; an Undo
 * toast draws a thin bar draining over its window. All of it is static under reduced motion.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const show = useCallback((opts: ToastOptions) => {
    const id = nextId.current++;
    setStack((s) => pushToast(s, makeToast(id, opts)));
    return id;
  }, []);
  const remove = useCallback((id: number) => setStack((s) => removeToast(s, id)), []);
  const api = useMemo<ToastApi>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastStack toasts={stack} onRemoved={remove} />
    </ToastContext.Provider>
  );
}

export function ToastStack({
  toasts,
  onRemoved,
}: {
  toasts: readonly Toast[];
  onRemoved: (id: number) => void;
}) {
  return (
    <section className="toasts" aria-label="Notifications">
      <ol className="toasts__list" aria-live="polite" aria-relevant="additions">
        {toasts.map((t) => (
          <ToastView key={t.id} toast={t} onRemoved={onRemoved} />
        ))}
      </ol>
    </section>
  );
}

function ToastView({ toast, onRemoved }: { toast: Toast; onRemoved: (id: number) => void }) {
  const [open, setOpen] = useState(true);
  const [paused, setPaused] = useState(false);
  const presence = usePresence(open);
  const { id, durationMs, undo, action } = toast;

  useEffect(() => {
    // Rule 2: the clock pauses while the toast is hovered or holds focus. Resuming restarts the
    // full window rather than shaving a few milliseconds off a notice nobody is reading.
    if (!open || paused) return;
    const timer = setTimeout(() => setOpen(false), durationMs);
    return () => clearTimeout(timer);
  }, [durationMs, open, paused]);

  useEffect(() => {
    if (presence === "closed") onRemoved(id);
  }, [presence, id, onRemoved]);

  if (presence === "closed") return null;

  return (
    <li
      className={`toast toast--${toast.tone}`}
      data-state={presence}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <p className="toast__message">{toast.message}</p>
      {undo ? (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => {
            setOpen(false);
            undo();
          }}
        >
          <Icon name={ACTION_ICON.reinstate} />
          <span>Undo</span>
        </button>
      ) : null}
      {action ? (
        action.href ? (
          <a
            className="btn btn--ghost btn--sm"
            href={action.href}
            onClick={() => setOpen(false)}
          >
            <Icon name={ACTION_ICON.timeline} />
            <span>{action.label}</span>
          </a>
        ) : (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setOpen(false);
              action.onClick?.();
            }}
          >
            <Icon name={ACTION_ICON.retry} />
            <span>{action.label}</span>
          </button>
        )
      ) : null}
      <IconButton
        icon={ACTION_ICON.dismiss}
        label="Dismiss"
        size="sm"
        onClick={() => setOpen(false)}
      />
      {undo || action ? (
        <span
          className="toast__timer"
          aria-hidden="true"
          style={{ animationDuration: `${durationMs}ms` }}
        />
      ) : null}
    </li>
  );
}
