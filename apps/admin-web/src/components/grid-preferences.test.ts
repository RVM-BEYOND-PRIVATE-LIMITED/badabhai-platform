import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DENSITY,
  readColumnChoices,
  readDensity,
  resetGridPreferencesForTests,
  subscribeGridPreferences,
  writeColumnChoices,
  writeDensity,
} from "./grid-preferences";

/**
 * The data grid's per-viewer preferences (A4, #2574) — the column choices and the row density,
 * in this browser's localStorage. Every storage access is guarded: a profile that disables or
 * fills storage must still get a grid that renders, and a choice that holds for the page's life.
 *
 * The node env has no `window`; each test stubs the one it needs.
 */
class MemoryStorage {
  readonly data = new Map<string, string>();
  getItem(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

type Listener = (event: { key: string | null }) => void;

function fakeWindow(localStorage: unknown) {
  const listeners = new Set<Listener>();
  return {
    window: {
      get localStorage() {
        if (localStorage instanceof Error) throw localStorage;
        return localStorage;
      },
      addEventListener: (type: string, fn: Listener) => {
        if (type === "storage") listeners.add(fn);
      },
      removeEventListener: (type: string, fn: Listener) => {
        if (type === "storage") listeners.delete(fn);
      },
    },
    listeners,
    fire: (key: string | null) => listeners.forEach((fn) => fn({ key })),
  };
}

beforeEach(() => resetGridPreferencesForTests());
afterEach(() => vi.unstubAllGlobals());

describe("with no browser storage at all (the server, a test)", () => {
  it("reads the defaults: comfortable rows, no column choices", () => {
    expect(readDensity()).toBe(DEFAULT_DENSITY);
    expect(DEFAULT_DENSITY).toBe("comfortable");
    expect(readColumnChoices("workers")).toBeNull();
  });

  it("still holds a choice in memory, and tells its subscribers", () => {
    const listener = vi.fn();
    subscribeGridPreferences(listener);
    writeDensity("compact");
    expect(readDensity()).toBe("compact");
    writeColumnChoices("workers", { language: false });
    expect(readColumnChoices("workers")).toBe('{"language":false}');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("with localStorage", () => {
  it("persists a choice, so the next page load reads it back", () => {
    const storage = new MemoryStorage();
    vi.stubGlobal("window", fakeWindow(storage).window);
    writeDensity("compact");
    writeColumnChoices("postings", { pay: false });
    expect([...storage.data.keys()].sort()).toEqual([
      "bb-admin:grid:columns:postings",
      "bb-admin:grid:density",
    ]);

    resetGridPreferencesForTests(); // a new page load: nothing cached
    expect(readDensity()).toBe("compact");
    expect(readColumnChoices("postings")).toBe('{"pay":false}');
  });

  it("choosing the default removes the key — a viewer who never deviates stores nothing", () => {
    const storage = new MemoryStorage();
    vi.stubGlobal("window", fakeWindow(storage).window);
    writeDensity("compact");
    writeDensity("comfortable");
    writeColumnChoices("postings", { pay: false });
    writeColumnChoices("postings", {});
    expect(storage.data.size).toBe(0);
    writeColumnChoices("postings", { pay: false });
    writeColumnChoices("postings", null);
    expect(storage.data.size).toBe(0);
  });

  it("column choices are per grid; density is one choice for every grid", () => {
    vi.stubGlobal("window", fakeWindow(new MemoryStorage()).window);
    writeColumnChoices("workers", { language: false });
    expect(readColumnChoices("postings")).toBeNull();
    writeDensity("compact");
    expect(readDensity()).toBe("compact");
  });

  it("a stored density that is not one of the two reads as the default", () => {
    const storage = new MemoryStorage();
    storage.setItem("bb-admin:grid:density", "tiny");
    vi.stubGlobal("window", fakeWindow(storage).window);
    expect(readDensity()).toBe("comfortable");
  });
});

describe("storage that refuses (disabled, sandboxed, full)", () => {
  it("a localStorage that throws on access: defaults to read, memory to write, no crash", () => {
    vi.stubGlobal("window", fakeWindow(new Error("SecurityError")).window);
    expect(() => readDensity()).not.toThrow();
    expect(readDensity()).toBe("comfortable");
    expect(() => writeDensity("compact")).not.toThrow();
    expect(readDensity()).toBe("compact");
  });

  it("a localStorage that throws on every call (a full quota on write)", () => {
    const refusing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    vi.stubGlobal("window", fakeWindow(refusing).window);
    expect(readColumnChoices("workers")).toBeNull();
    expect(() => writeColumnChoices("workers", { city: true })).not.toThrow();
    expect(readColumnChoices("workers")).toBe('{"city":true}');
  });
});

describe("another tab changed a preference (the storage event)", () => {
  it("drops this tab's copy and tells the grids to re-read", () => {
    const storage = new MemoryStorage();
    const win = fakeWindow(storage);
    vi.stubGlobal("window", win.window);
    const listener = vi.fn();
    subscribeGridPreferences(listener);
    expect(readDensity()).toBe("comfortable"); // cached

    storage.setItem("bb-admin:grid:density", "compact"); // the other tab's write
    win.fire("bb-admin:grid:density");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(readDensity()).toBe("compact");
  });

  it("ignores every other key; a cleared storage (key null) re-reads everything", () => {
    const storage = new MemoryStorage();
    const win = fakeWindow(storage);
    vi.stubGlobal("window", win.window);
    const listener = vi.fn();
    subscribeGridPreferences(listener);
    win.fire("some-other-app");
    expect(listener).not.toHaveBeenCalled();

    writeDensity("compact");
    listener.mockClear();
    storage.data.clear(); // the other tab cleared everything
    win.fire(null);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(readDensity()).toBe("comfortable");
  });

  it("listens only while a grid is subscribed", () => {
    const win = fakeWindow(new MemoryStorage());
    vi.stubGlobal("window", win.window);
    const a = subscribeGridPreferences(() => undefined);
    const b = subscribeGridPreferences(() => undefined);
    expect(win.listeners.size).toBe(1);
    a();
    expect(win.listeners.size).toBe(1);
    b();
    expect(win.listeners.size).toBe(0);
  });
});
