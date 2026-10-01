import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCK_MEASURED_PROPERTY, dockMeasurement, observeDockHeight } from "./dock-reserve";

/**
 * The page's room for the phone dock follows the dock's REAL height (a refused save's two status
 * lines made it 153–168px against a fixed 7rem reserve — fields sat up to 24px under it). The
 * dock's height is published on the root; the CSS keeps the 7rem floor. The DOM and the
 * ResizeObserver are faked structurally (node env).
 */

class FakeResizeObserver {
  static last: FakeResizeObserver | null = null;
  observed: unknown[] = [];
  disconnected = false;
  constructor(readonly callback: () => void) {
    FakeResizeObserver.last = this;
  }
  observe(target: unknown) {
    this.observed.push(target);
  }
  disconnect() {
    this.disconnected = true;
  }
}

function fakeDock(height: number) {
  const props = new Map<string, string>();
  const dock = {
    height,
    getBoundingClientRect: () => ({ height: dock.height }),
    ownerDocument: {
      documentElement: {
        style: {
          setProperty: (k: string, v: string) => void props.set(k, v),
          removeProperty: (k: string) => {
            props.delete(k);
            return "";
          },
        },
      },
    },
  };
  return { dock, props };
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeResizeObserver.last = null;
});

describe("observeDockHeight — the dock's real height is the page's reserve", () => {
  it("publishes the height on attach, rounded UP to whole pixels (never short)", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { dock, props } = fakeDock(152.4);
    observeDockHeight(dock as unknown as HTMLElement);
    expect(props.get(DOCK_MEASURED_PROPERTY)).toBe("153");
    expect(FakeResizeObserver.last!.observed).toEqual([dock]);
  });

  it("re-publishes when the dock grows (a refused save adds two status lines) and shrinks", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { dock, props } = fakeDock(79);
    observeDockHeight(dock as unknown as HTMLElement);
    dock.height = 168;
    FakeResizeObserver.last!.callback();
    expect(props.get(DOCK_MEASURED_PROPERTY)).toBe("168");
    dock.height = 79;
    FakeResizeObserver.last!.callback();
    expect(props.get(DOCK_MEASURED_PROPERTY)).toBe("79");
  });

  it("withdraws the measurement and stops observing when the dock unmounts", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { dock, props } = fakeDock(100);
    const cleanup = observeDockHeight(dock as unknown as HTMLElement)!;
    cleanup();
    expect(props.has(DOCK_MEASURED_PROPERTY)).toBe(false);
    expect(FakeResizeObserver.last!.disconnected).toBe(true);
  });

  it("does nothing without a dock or a ResizeObserver (server render) — the CSS floor stands", () => {
    expect(observeDockHeight(null)).toBeUndefined();
    vi.stubGlobal("ResizeObserver", undefined);
    const { dock, props } = fakeDock(100);
    expect(observeDockHeight(dock as unknown as HTMLElement)).toBeUndefined();
    expect(props.size).toBe(0);
  });

  it("measurements are whole pixels, rounded up", () => {
    expect(dockMeasurement(79)).toBe("79");
    expect(dockMeasurement(79.01)).toBe("80");
  });
});
