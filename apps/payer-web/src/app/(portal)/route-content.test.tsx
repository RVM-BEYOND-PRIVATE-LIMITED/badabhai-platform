import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactElement } from "react";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

/**
 * #2586 (W6) — the content column, ONE PER PATH (route-content.tsx): the behaviour half (the
 * stylesheet half is app/w6-transitions.css.test.ts).
 *
 *  - keyed on the PATH: a route change mounts a fresh column (its entrance plays); a query change
 *    — `?reached=`, the candidates pager — keeps the same one (React keeps an element of the same
 *    type and key: nothing remounts, nothing replays);
 *  - the fresh column carries `data-entering` until its entrance has played, and the list stagger
 *    keys on it, so a list's entrance runs on its FIRST render only;
 *  - it is a key, not a boundary: no Suspense / lazy / dynamic (app/no-suspense-above-a-page.test.ts
 *    scans this file with every other source).
 *
 * Node env: `usePathname` reads the path of a URL the test sets; React's hooks are the real ones
 * for the server render, and stand-ins (`hooks.stub`) when the column is called as a function.
 */
const hooks = vi.hoisted(() => ({
  url: "/dashboard",
  stub: false,
  entering: true,
  setEntering: (() => undefined) as (v: boolean) => void,
  ref: { current: null as unknown },
  effects: [] as Array<{ run: () => unknown; deps: readonly unknown[] | undefined }>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => new URL(hooks.url, "https://portal.test").pathname,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useState: (init: unknown) =>
      hooks.stub ? [hooks.entering, hooks.setEntering] : actual.useState(init),
    useRef: (init: unknown) => (hooks.stub ? hooks.ref : actual.useRef(init)),
    useEffect: (run: ReactModule.EffectCallback, deps?: ReactModule.DependencyList) =>
      hooks.stub ? void hooks.effects.push({ run, deps }) : actual.useEffect(run, deps),
  };
});

const { RouteContent, ContentColumn, afterEntrance, ENTERING_ATTR } =
  await import("./route-content");

beforeEach(() => {
  hooks.url = "/dashboard";
  hooks.stub = false;
  hooks.entering = true;
  hooks.ref = { current: null };
  hooks.effects = [];
});
afterEach(() => vi.restoreAllMocks());

/** What RouteContent hands React for the address `url`. */
function columnAt(url: string): ReactElement {
  hooks.url = url;
  return RouteContent({ children: <p>page</p> }) as ReactElement;
}

/** Let every settled promise's callbacks run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A rejected `finished` (a cancelled animation) is handled by allSettled; keep node quiet here.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

describe("the column is keyed on the PATH", () => {
  it("a query change keeps the same column — same type, same key: React does not remount it", () => {
    for (const [a, b] of [
      ["/candidates?page=1", "/candidates?page=2"],
      ["/candidates", "/candidates?posting=all"],
      ["/postings/p-1?reached=1", "/postings/p-1"],
      ["/dashboard#recent", "/dashboard"],
    ] as const) {
      const before = columnAt(a);
      const after = columnAt(b);
      expect(before.type, a).toBe(ContentColumn);
      expect(after.type, b).toBe(ContentColumn);
      expect(after.key, `${a} → ${b}`).toBe(before.key);
    }
  });

  it("a route change gives a different key — a fresh column, whose entrance plays", () => {
    expect(columnAt("/candidates?page=2").key).toBe("/candidates");
    expect(columnAt("/candidates/applied").key).toBe("/candidates/applied");
    expect(columnAt("/postings").key).toBe("/postings");
    expect(columnAt("/postings/p-1").key).not.toBe(columnAt("/postings/p-2").key);
  });

  it("the key is the only thing the address changes: the page is handed through untouched", () => {
    const page = <p>page</p>;
    hooks.url = "/team";
    const el = RouteContent({ children: page }) as ReactElement<{ children: unknown }>;
    expect(el.props.children).toBe(page);
  });

  it("it reads the path alone — never the query, the params or the location", () => {
    const code = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "route-content.tsx"),
      "utf8",
    );
    const sf = ts.createSourceFile(
      "route-content.tsx",
      code,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const names = new Set<string>();
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n)) names.add(n.text);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(names.has("usePathname")).toBe(true);
    for (const banned of ["useSearchParams", "useParams", "useSelectedLayoutSegment", "location"]) {
      expect(names.has(banned), banned).toBe(false);
    }
  });
});

describe("the column's markup", () => {
  it("is the shell's <main> (the skip link's target), entering from its first paint", () => {
    hooks.url = "/postings";
    expect(renderToStaticMarkup(<RouteContent>{<p>page</p>}</RouteContent>)).toBe(
      `<main class="pshell__content" id="main" ${ENTERING_ATTR}=""><p>page</p></main>`,
    );
  });
});

describe("lists stagger on the FIRST render only — the column stops entering once its entrance played", () => {
  /** Call the column as a function with stand-in hooks; returns its <main> element. */
  function column(entering: boolean): ReactElement<Record<string, unknown>> {
    hooks.stub = true;
    hooks.entering = entering;
    return ContentColumn({ children: <p>page</p> }) as ReactElement<Record<string, unknown>>;
  }

  it("entering, then — once nothing of its entrance is left running — not", async () => {
    const setEntering = vi.fn();
    hooks.setEntering = setEntering;
    hooks.ref = { current: { getAnimations: () => [] } };
    expect(column(true).props[ENTERING_ATTR]).toBe("");
    const mount = hooks.effects.filter((e) => e.deps?.length === 0);
    expect(mount).toHaveLength(1); // once per column, i.e. once per path
    mount[0]!.run();
    await flush();
    expect(setEntering).toHaveBeenCalledWith(false);
    expect(column(false).props[ENTERING_ATTR]).toBeUndefined();
  });

  it("a column that leaves before its entrance ends never flips (the effect's cleanup)", async () => {
    const setEntering = vi.fn();
    hooks.setEntering = setEntering;
    const playing = deferred();
    hooks.ref = {
      current: {
        getAnimations: () => [{ animationName: "page-enter", finished: playing.promise }],
      },
    };
    column(true);
    const cleanup = hooks.effects.find((e) => e.deps?.length === 0)!.run() as () => void;
    cleanup();
    playing.resolve();
    await flush();
    expect(setEntering).not.toHaveBeenCalled();
  });
});

describe("afterEntrance — waits for the entrance, and only the entrance", () => {
  it("calls back once the column's own entrance AND its lists' have settled — finished or cancelled", async () => {
    const page = deferred();
    const item = deferred();
    const spinner = new Promise<void>(() => undefined); // a spinner turns forever: never waited for
    const asked: unknown[] = [];
    const column = {
      getAnimations: (options?: unknown) => {
        asked.push(options);
        return [
          { animationName: "page-enter", finished: page.promise },
          { animationName: "list-enter", finished: item.promise },
          { animationName: "bb-spin", finished: spinner },
        ] as unknown as Animation[];
      },
    };
    const done = vi.fn();
    afterEntrance(column, done);
    expect(asked).toEqual([{ subtree: true }]); // the lists' items are in the column's subtree
    await flush();
    expect(done).not.toHaveBeenCalled();
    page.resolve();
    await flush();
    expect(done).not.toHaveBeenCalled();
    item.reject(new DOMException("cancelled", "AbortError"));
    await flush();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("nothing running — reduced motion, or a first load that played it before hydration: at once", async () => {
    const done = vi.fn();
    afterEntrance({ getAnimations: () => [] }, done);
    await flush();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("no Web Animations API: it does not wait (the lists simply stop entering)", async () => {
    const done = vi.fn();
    afterEntrance({}, done);
    await flush();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("cancelled before it settles: never calls back", async () => {
    const done = vi.fn();
    const page = deferred();
    const stop = afterEntrance(
      {
        getAnimations: () =>
          [{ animationName: "page-enter", finished: page.promise }] as unknown as Animation[],
      },
      done,
    );
    stop();
    page.resolve();
    await flush();
    expect(done).not.toHaveBeenCalled();
  });
});
