"use client";

/**
 * BadaBhai Design System — ToastProvider: THE place a success message appears (#2583).
 *
 * One toast stack per portal, in ONE polite live region that is in the page from the first
 * paint (a region created together with its message is often not announced at all). A toast is
 * announced ONCE: the region announces additions only, and the toasts inside it are not live
 * regions of their own (`<Toast live={false}>`), so nothing is read twice and a toast leaving is
 * not read at all. Each toast dismisses itself after {@link TOAST_DURATION_MS}; the clock stops
 * while the pointer is over the stack or focus is inside it (./toast-timers.ts). Toasts rise in
 * over --duration-base and leave over --duration-fast (ds-components.css); under reduced motion,
 * or where no exit animation applies, a dismissed toast goes at once.
 *
 * Screens call `useToast().show({ tone, title, message })`. Outside a provider the hook is a
 * no-op, so a component rendered on its own (a test, a story) does not throw.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AnimationEvent, ReactNode } from "react";
import { Toast, type ToastProps } from "./toast";
import { TOAST_DURATION_MS, ToastTimers } from "./toast-timers";

export { TOAST_DURATION_MS };

/** At most this many toasts show at once; a newer one retires the oldest. */
export const TOAST_LIMIT = 3;

export interface ToastInput {
  /** @default 'success' */
  tone?: ToastProps["tone"];
  /** Bold first line. */
  title?: ReactNode;
  /** Supporting message. */
  message?: ReactNode;
}

export interface ToastApi {
  /** Show a toast; returns its id. */
  show: (toast: ToastInput) => number;
  /** Dismiss a toast early. */
  dismiss: (id: number) => void;
}

interface Entry extends ToastInput {
  id: number;
  leaving: boolean;
}

const NOOP_API: ToastApi = { show: () => 0, dismiss: () => {} };
const ToastContext = createContext<ToastApi>(NOOP_API);

/** The portal's toast API (a no-op outside a {@link ToastProvider}). */
export function useToast(): ToastApi {
  return useContext(ToastContext);
}

/** True when a leaving toast can go at once: reduced motion, or no exit animation to wait for. */
function leavesAtOnce(el: Element | null): boolean {
  if (!el || typeof window === "undefined") return true;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return true;
  const name = window.getComputedStyle?.(el).animationName;
  return !name || name === "none";
}

export function ToastProvider({ children }: { children?: ReactNode }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const seq = useRef(0);
  const hovered = useRef(false);
  const focused = useRef(false);

  const startLeaving = useCallback((id: number) => {
    setEntries((list) => list.map((e) => (e.id === id ? { ...e, leaving: true } : e)));
  }, []);
  const timers = useRef<ToastTimers | null>(null);
  timers.current ??= new ToastTimers(startLeaving);

  useEffect(() => () => timers.current?.dispose(), []);

  const dismiss = useCallback(
    (id: number) => {
      timers.current?.remove(id);
      startLeaving(id);
    },
    [startLeaving],
  );

  const show = useCallback((toast: ToastInput) => {
    const id = ++seq.current;
    setEntries((list) => {
      const live = list.filter((e) => !e.leaving);
      // Over the limit: the oldest live toast starts leaving to make room.
      const retire = live.length >= TOAST_LIMIT ? live[0]!.id : null;
      if (retire !== null) timers.current?.remove(retire);
      return [
        ...list.map((e) => (e.id === retire ? { ...e, leaving: true } : e)),
        { tone: "success", ...toast, id, leaving: false },
      ];
    });
    timers.current?.add(id);
    return id;
  }, []);

  const remove = useCallback((id: number) => {
    setEntries((list) => list.filter((e) => e.id !== id));
  }, []);

  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss]);

  const syncPause = () => {
    if (hovered.current || focused.current) timers.current?.pause();
    else timers.current?.resume();
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="bb-toast-viewport"
        role="status"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Notifications"
        onPointerEnter={() => {
          hovered.current = true;
          syncPause();
        }}
        onPointerLeave={() => {
          hovered.current = false;
          syncPause();
        }}
        onFocus={() => {
          focused.current = true;
          syncPause();
        }}
        onBlur={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          focused.current = false;
          syncPause();
        }}
      >
        {entries.map((e) => (
          <ToastItem key={e.id} entry={e} onDismiss={dismiss} onGone={remove} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({
  entry,
  onDismiss,
  onGone,
}: {
  entry: Entry;
  onDismiss: (id: number) => void;
  onGone: (id: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { id, leaving } = entry;

  useEffect(() => {
    if (!leaving) return undefined;
    if (leavesAtOnce(ref.current)) {
      onGone(id);
      return undefined;
    }
    // A hidden tab may never deliver animationend: the toast still goes.
    const fallback = window.setTimeout(() => onGone(id), TOAST_DURATION_MS / 5);
    return () => window.clearTimeout(fallback);
  }, [leaving, id, onGone]);

  const onAnimationEnd = (e: AnimationEvent<HTMLDivElement>) => {
    if (leaving && e.target === e.currentTarget) onGone(id);
  };

  return (
    <Toast
      ref={ref}
      live={false}
      tone={entry.tone}
      title={entry.title}
      className={leaving ? "bb-toast--leaving" : undefined}
      aria-hidden={leaving || undefined}
      onAnimationEnd={onAnimationEnd}
      onClose={leaving ? undefined : () => onDismiss(id)}
    >
      {entry.message}
    </Toast>
  );
}
