import { describe, it, expect } from "vitest";
import { formatInr } from "@badabhai/pricing";
import {
  creditReasonLabel,
  formatCount,
  formatDelta,
  formatDuration,
  formatExactRupees,
  formatPayBand,
  formatRupees,
  formatRelative,
  formatSuppressible,
  formatTimestamp,
  healthTone,
  humanizeEventName,
  packCodeLabel,
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

  it("round-trips through the shared formatInr (BL-10 fast-follow) — no bespoke ₹ string", () => {
    // formatPayBand used to hand-roll its own `₹${formatCount(n)}` closure instead of
    // calling @badabhai/pricing's formatInr, the ONE source every other ₹ figure in this
    // app already goes through. This pins the visible output to formatInr's own output
    // directly, so the two can never silently diverge again.
    expect(formatPayBand(18000, 25000)).toBe(`${formatInr(18000)}–${formatInr(25000)}`);
    expect(formatPayBand(20000, 20000)).toBe(formatInr(20000));
    expect(formatPayBand(18000, null)).toBe(`from ${formatInr(18000)}`);
    expect(formatPayBand(null, 25000)).toBe(`up to ${formatInr(25000)}`);
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

describe("formatExactRupees — AI spend is a STRING and never round-trips through a float", () => {
  /*
   * `platform_ai_cost_totals.total_cost_inr` is `numeric(16,6)`, serialised verbatim precisely
   * so a running sum of millions of sub-paisa calls cannot drift through IEEE-754. Every step
   * of this formatter is string surgery for that reason, which is exactly what makes it worth
   * pinning: a later "tidy-up" to `Number(value).toLocaleString()` would pass a casual eyeball
   * on ₹12.48 and quietly lose the sixth decimal place on the figures that need it.
   */

  it("pads to a two-decimal minimum so a whole amount reads as money", () => {
    expect(formatExactRupees("0")).toBe("₹0.00");
    expect(formatExactRupees("3")).toBe("₹3.00");
    // Trailing zeros are LOSSLESS to trim: 12.480000 IS 12.48.
    expect(formatExactRupees("12.480000")).toBe("₹12.48");
  });

  it("keeps every place of a sub-paisa figure rather than rounding it to ₹0.00", () => {
    // "We spent a fraction of a paisa" and "we spent nothing" are different facts.
    expect(formatExactRupees("0.000012")).toBe("₹0.000012");
    expect(formatExactRupees("0.000012")).not.toBe("₹0.00");
  });

  it("groups the integer part the INDIAN way — last three, then pairs", () => {
    expect(formatExactRupees("1234567.5")).toBe("₹12,34,567.50");
    expect(formatExactRupees("12345678.123456")).toBe("₹1,23,45,678.123456");
    expect(formatExactRupees("999.5")).toBe("₹999.50");
    // …and a value that arrived zero-padded is not rendered with its padding.
    expect(formatExactRupees("00012.5")).toBe("₹12.50");
  });

  it("renders a negative with a real minus sign, outside the ₹", () => {
    // U+2212, for the same reason `formatDelta` uses one: it aligns with tabular digits.
    expect(formatExactRupees("-1.5")).toBe("−₹1.50");
    expect(formatExactRupees("-1.5").charCodeAt(0)).toBe(0x2212);
    expect(formatExactRupees("-0.5")).toBe("−₹0.50");
  });

  it("returns a value it does not recognise UNCHANGED — never coerced, never blanked", () => {
    // It came from the server. Inventing a ₹ figure for something this portal cannot parse
    // would be worse than showing it raw, and blanking it would hide that it arrived at all.
    for (const raw of ["", "abc", "1e5", ".5", "1.", "12,50", "₹12.48", "NaN"]) {
      expect(formatExactRupees(raw), raw).toBe(raw);
    }
  });
});

describe("formatDuration — the idle ladder, and what is NOT a duration", () => {
  it("steps through seconds, minutes, hours and days", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(59)).toBe("59s");
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(12 * 60)).toBe("12m");
    expect(formatDuration(59 * 60 + 59)).toBe("59m");
    expect(formatDuration(60 * 60)).toBe("1h 0m");
    expect(formatDuration(3 * 3600 + 20 * 60)).toBe("3h 20m");
    expect(formatDuration(23 * 3600 + 59 * 60)).toBe("23h 59m");
    expect(formatDuration(24 * 3600)).toBe("1d 0h");
    expect(formatDuration(2 * 86400 + 4 * 3600)).toBe("2d 4h");
  });

  it("floors a fractional second rather than printing one", () => {
    expect(formatDuration(45.9)).toBe("45s");
  });

  it("renders a dash for a negative or non-finite input, never a nonsense duration", () => {
    // `idle_seconds` is derived from two clocks; skew makes a negative reachable, and
    // "−3s idle" on an operations console is noise that reads as a bug in the data.
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatDuration(-1)).not.toContain("s");
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

describe("packCodeLabel", () => {
  it("labels the five known pack codes", () => {
    expect(packCodeLabel("pack_10")).toBe("10-credit pack");
    expect(packCodeLabel("pack_25")).toBe("25-credit pack");
    expect(packCodeLabel("pack_50")).toBe("50-credit pack");
    expect(packCodeLabel("pack_200")).toBe("200-credit pack");
    expect(packCodeLabel("pack_1000")).toBe("1,000-credit pack");
  });

  it("an UNKNOWN pack code is shown raw, never blank — mirrors creditReasonLabel's fallback", () => {
    expect(packCodeLabel("pack_legacy_bulk")).toBe("pack legacy bulk");
    expect(packCodeLabel("pack_legacy_bulk")).not.toBe("");
  });
});
