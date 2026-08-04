import { describe, it, expect } from "vitest";
import {
  creditReasonLabel,
  formatCount,
  formatDelta,
  formatPayBand,
  formatRupees,
  formatRelative,
  formatSuppressible,
  formatTimestamp,
  healthTone,
  humanizeEventName,
  shortId,
} from "./format";

/**
 * Display formatting.
 *
 * The load-bearing test in this file is `formatSuppressible`. The server floors a
 * k-anonymity-suppressed statistic to 0, and rendering that 0 as a count would state
 * "nobody reached this stage" when the truth is "too few to report" — a false claim on an
 * operations console. Everything else here is ordinary correctness.
 */

describe("formatSuppressible — a withheld figure must never render as zero", () => {
  it("renders a suppressed stat as a floor marker, NOT the floored 0", () => {
    const r = formatSuppressible(0, true, 5);
    expect(r.isSuppressed).toBe(true);
    expect(r.text).toBe("< 5");
    // The literal "0" must not be what an operator reads.
    expect(r.text).not.toBe("0");
    expect(r.hint).toMatch(/withheld/i);
  });

  it("renders a genuine zero as 0 — an unsuppressed nothing IS information", () => {
    const r = formatSuppressible(0, false, 5);
    expect(r.isSuppressed).toBe(false);
    expect(r.text).toBe("0");
    expect(r.hint).toBeUndefined();
  });

  it("renders a real count normally", () => {
    expect(formatSuppressible(1234, false, 5).text).toBe("1,234");
  });

  it("suppression wins even when the server sent a non-zero value", () => {
    // Defence in depth: if a future server ever flags suppressed while leaking a real
    // count, the UI still refuses to print it.
    const r = formatSuppressible(3, true, 5);
    expect(r.text).toBe("< 5");
    expect(r.text).not.toContain("3");
  });
});

describe("timestamps", () => {
  it("formats an ISO instant as absolute UTC to the second", () => {
    expect(formatTimestamp("2026-08-04T09:39:54.919Z")).toBe("2026-08-04 09:39:54Z");
  });

  it("returns a dash for an unparseable value instead of 'Invalid Date'", () => {
    expect(formatTimestamp("not-a-date")).toBe("—");
    expect(formatRelative("not-a-date")).toBe("—");
  });

  it("relative time steps through the units", () => {
    const now = Date.parse("2026-08-04T12:00:00Z");
    expect(formatRelative("2026-08-04T11:59:30Z", now)).toBe("30s ago");
    expect(formatRelative("2026-08-04T11:45:00Z", now)).toBe("15m ago");
    expect(formatRelative("2026-08-04T09:00:00Z", now)).toBe("3h ago");
    expect(formatRelative("2026-08-01T12:00:00Z", now)).toBe("3d ago");
  });

  it("a future timestamp reads 'just now', never a negative age", () => {
    // Clock skew between the API host and this one is normal; "in -4s" is not.
    const now = Date.parse("2026-08-04T12:00:00Z");
    expect(formatRelative("2026-08-04T12:00:04Z", now)).toBe("just now");
  });
});

describe("ids", () => {
  it("truncates long ids and leaves short ones alone", () => {
    expect(shortId("80e2b2a0-3633-482b-8f5a-4f092c06e62e")).toBe("80e2b2a0…");
    expect(shortId("abc")).toBe("abc");
  });

  it("renders a null id as a dash, not 'null'", () => {
    expect(shortId(null)).toBe("—");
  });
});

describe("event names", () => {
  it("splits domain from action and de-snakes it", () => {
    expect(humanizeEventName("worker.profile_confirmed")).toBe("Worker · profile confirmed");
    expect(humanizeEventName("admin.session_started")).toBe("Admin · session started");
  });

  it("handles a name with no dot", () => {
    expect(humanizeEventName("heartbeat")).toBe("Heartbeat");
  });
});

describe("healthTone — 'mock' is a WARNING, not healthy", () => {
  it("maps up/ok/real to ok", () => {
    expect(healthTone("up")).toBe("ok");
    expect(healthTone("ok")).toBe("ok");
    expect(healthTone("real")).toBe("ok");
  });

  it("maps down/error to bad", () => {
    expect(healthTone("down")).toBe("bad");
    expect(healthTone("error")).toBe("bad");
  });

  it("maps mock/degraded/unknown to warn — TD81's whole point", () => {
    // A mocked dependency behind a 200 is exactly the state that looked healthy for
    // weeks. It must not render in the same colour as a real one.
    expect(healthTone("mock")).toBe("warn");
    expect(healthTone("degraded")).toBe("warn");
    expect(healthTone("unknown")).toBe("warn");
  });
});

describe("counts", () => {
  it("groups with Indian digit grouping", () => {
    expect(formatCount(1234)).toBe("1,234");
    expect(formatCount(0)).toBe("0");
  });
});

describe("formatPayBand — a missing bound is never invented", () => {
  it("renders a real band", () => {
    expect(formatPayBand(18000, 25000)).toBe("₹18,000–₹25,000");
  });

  it("collapses an equal min and max to one figure", () => {
    expect(formatPayBand(20000, 20000)).toBe("₹20,000");
  });

  it("a min-only posting reads 'from', NOT as a fixed salary", () => {
    // The bug this prevents: rendering min-only as "₹18,000" states a ceiling the
    // employer never offered, on a screen a worker's expectations are set from.
    expect(formatPayBand(18000, null)).toBe("from ₹18,000");
    expect(formatPayBand(18000, null)).not.toBe("₹18,000");
  });

  it("a max-only posting reads 'up to'", () => {
    expect(formatPayBand(null, 25000)).toBe("up to ₹25,000");
  });

  it("no pay at all says so plainly rather than showing ₹0", () => {
    expect(formatPayBand(null, null)).toBe("not stated");
    expect(formatPayBand(null, null)).not.toContain("0");
  });

  it("a genuine zero is still a figure, not an absence", () => {
    expect(formatPayBand(0, 0)).toBe("₹0");
  });
});

describe("money — a ledger row's sign is its meaning", () => {
  it("formatRupees uses whole rupees with Indian grouping", () => {
    expect(formatRupees(125000)).toBe("₹1,25,000");
    expect(formatRupees(0)).toBe("₹0");
  });

  it("a debit is rendered with an explicit minus", () => {
    // A bare "10" next to a debit reads as a grant. The sign carries the whole meaning.
    expect(formatDelta(-10)).toBe("\u221210");
    expect(formatDelta(-10)).not.toBe("10");
  });

  it("a credit is rendered with an explicit plus", () => {
    expect(formatDelta(25)).toBe("+25");
  });

  it("uses a real minus sign, not a hyphen — it aligns with tabular digits", () => {
    expect(formatDelta(-5).charCodeAt(0)).toBe(0x2212);
  });

  it("zero renders as +0, never bare", () => {
    expect(formatDelta(0)).toBe("+0");
  });
});

describe("creditReasonLabel", () => {
  it("labels the four known reasons", () => {
    expect(creditReasonLabel("pack_purchase")).toBe("Pack purchase");
    expect(creditReasonLabel("unlock_debit")).toBe("Contact unlock");
    expect(creditReasonLabel("refund")).toBe("Refund");
    expect(creditReasonLabel("grant")).toBe("Ops grant");
  });

  it("an UNKNOWN reason is shown raw, never blank", () => {
    // A code nobody recognises is a reason to look, not to render an empty cell.
    expect(creditReasonLabel("chargeback_hold")).toBe("chargeback hold");
    expect(creditReasonLabel("chargeback_hold")).not.toBe("");
  });
});
