import type { ReactElement, ReactNode } from "react";

/**
 * A small STATEFUL stand-in for React's hooks, for the node-env component tests (no DOM, no
 * renderer — the same constraint the element-walk suites work under).
 *
 * The call-order seed those suites use (`useState` → `[seed[i], vi.fn()]`) renders one frozen
 * frame: a setter does nothing, so a flow — type, submit, the action answers, the next screen —
 * cannot be followed. This keeps each `useState` slot across renders, so a test can call a
 * handler, re-render, and read the next frame: React's model, minus the scheduler.
 *
 *   const h = createHookHarness();
 *   vi.mock("react", async () => ({ ...(await vi.importActual("react")),
 *     useState: (i) => h.useState(i), useTransition: () => h.useTransition(),
 *     useEffect: (fx, deps) => h.useEffect(fx, deps) }));
 *   let tree = h.render(MyForm, props);   // frame 1
 *   onSubmit(tree)(…); await h.settle();  // the transition's action resolves
 *   tree = h.render(MyForm, props);       // frame 2
 *
 * Rules it keeps from React: hooks are read in call order (a component must call them
 * unconditionally); a setter takes a value or an updater; an effect runs after the render whose
 * deps changed it (no deps = every render). What it drops: batching, cleanups, concurrency, and
 * `isPending` (always false). The factory closures above read `h` lazily, so vi.mock's hoisting
 * is safe.
 */
export interface HookHarness {
  useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void];
  useTransition(): [boolean, (work: () => unknown) => void];
  useEffect(effect: () => unknown, deps?: readonly unknown[]): void;
  /** Render a component function against the kept state; effects whose deps changed run after. */
  render<P, R>(component: (props: P) => R, props: P): R;
  /** Wait for every transition started so far, and any those start. */
  settle(): Promise<void>;
  /** A fresh mount: forget every slot and effect. `seed` presets slots by call order. */
  reset(seed?: readonly unknown[]): void;
  /** A copy of every kept slot — what the component is holding right now (e.g. no password). */
  state(): readonly unknown[];
}

export function createHookHarness(): HookHarness {
  let slots: unknown[] = [];
  let seed: readonly unknown[] = [];
  let cursor = 0;
  let effectDeps: (readonly unknown[] | undefined)[] = [];
  let effectCursor = 0;
  let queued: (() => unknown)[] = [];
  const work: Promise<unknown>[] = [];

  return {
    useState<T>(initial: T | (() => T)) {
      const i = cursor++;
      if (!(i in slots)) {
        slots[i] =
          i < seed.length && seed[i] !== undefined
            ? seed[i]
            : typeof initial === "function"
              ? (initial as () => T)()
              : initial;
      }
      const set = (next: T | ((prev: T) => T)) => {
        slots[i] = typeof next === "function" ? (next as (prev: T) => T)(slots[i] as T) : next;
      };
      return [slots[i] as T, set];
    },
    useTransition() {
      // Like React: the callback starts synchronously; its async continuation is tracked.
      return [false, (fn: () => unknown) => void work.push(Promise.resolve(fn()))];
    },
    useEffect(effect: () => unknown, deps?: readonly unknown[]) {
      const i = effectCursor++;
      const prev = effectDeps[i];
      const changed =
        deps === undefined ||
        prev === undefined ||
        deps.length !== prev.length ||
        deps.some((d, k) => !Object.is(d, prev[k]));
      if (changed) {
        effectDeps[i] = deps;
        queued.push(effect);
      }
    },
    render<P, R>(component: (props: P) => R, props: P): R {
      cursor = 0;
      effectCursor = 0;
      const out = component(props);
      const run = queued;
      queued = [];
      for (const effect of run) effect();
      return out;
    },
    async settle() {
      while (work.length > 0) await Promise.all(work.splice(0));
    },
    reset(next: readonly unknown[] = []) {
      slots = [];
      seed = next;
      effectDeps = [];
      queued = [];
      work.length = 0;
    },
    state() {
      return [...slots];
    },
  };
}

/* ---- Element-tree walkers (the same reads every element-walk suite does) ---- */

/** The props of an element, untyped — a test reads what the source passed. */
export const propsOf = (el: ReactElement): Record<string, unknown> =>
  el.props as Record<string, unknown>;

/** Every text node under `node`, space-joined (props other than children are not text). */
export function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const el = node as ReactElement<{ children?: ReactNode }>;
  return el.props && "children" in el.props ? textOf(el.props.children) : "";
}

/** Every element under `node` (itself included) that `match` accepts, in document order. */
export function findElements(
  node: ReactNode,
  match: (el: ReactElement) => boolean,
  acc: ReactElement[] = [],
): ReactElement[] {
  if (node === null || node === undefined || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, match, acc);
    return acc;
  }
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (match(el)) acc.push(el);
  if (el.props && "children" in el.props) findElements(el.props.children, match, acc);
  return acc;
}

/** Every element of a given type (an intrinsic tag or a component function). */
export const findByType = (node: ReactNode, type: unknown) =>
  findElements(node, (el) => el.type === type);

/** Every element whose prop `key` is `value`. */
export const findByProp = (node: ReactNode, key: string, value: unknown) =>
  findElements(node, (el) => !!el.props && propsOf(el)[key] === value);
