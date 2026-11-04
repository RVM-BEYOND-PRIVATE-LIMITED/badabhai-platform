import { describe, expect, it } from "vitest";
import { EXIT_DURATION_TOKEN, exitDurationMs, nextPresence, parseCssDurationMs } from "./presence";

/**
 * A5 (#2575) — an overlay plays its exit motion, then unmounts after exactly the token the CSS
 * exit runs for (0ms under reduced motion, so it leaves at once).
 */
describe("nextPresence", () => {
  it("opens from any state", () => {
    expect(nextPresence(true, "closed")).toBe("open");
    expect(nextPresence(true, "closing")).toBe("open");
    expect(nextPresence(true, "open")).toBe("open");
  });

  it("an open overlay starts closing; it does not vanish mid-exit", () => {
    expect(nextPresence(false, "open")).toBe("closing");
    expect(nextPresence(false, "closing")).toBe("closing");
    expect(nextPresence(false, "closed")).toBe("closed");
  });
});

describe("parseCssDurationMs", () => {
  it("reads ms and s", () => {
    expect(parseCssDurationMs("140ms")).toBe(140);
    expect(parseCssDurationMs(" 0.2s ")).toBe(200);
  });

  it("reads the reduced-motion 0ms, and anything unreadable, as 0", () => {
    expect(parseCssDurationMs("0ms")).toBe(0);
    expect(parseCssDurationMs("")).toBe(0);
    expect(parseCssDurationMs("var(--x)")).toBe(0);
    expect(parseCssDurationMs("-5ms")).toBe(0);
  });
});

describe("exitDurationMs", () => {
  it("is the --duration-fast token — the one the CSS exit animations name", () => {
    expect(EXIT_DURATION_TOKEN).toBe("--duration-fast");
  });

  it("is 0 outside a browser", () => {
    expect(exitDurationMs()).toBe(0);
  });
});
