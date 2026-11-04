import { describe, it, expect } from "vitest";
import { formatInr } from "@badabhai/pricing";
import {
  creditReasonLabel,
  matchTierLabel,
  formatCount,
  formatClock,
  formatDate,
  formatDelta,
  formatDisplayRupees,
  formatDisplayRupeesFromNumber,
  formatDuration,
  formatExactRupees,
  formatPayBand,
  formatRupees,
  formatRelative,
  formatSuppressible,
  formatTimestamp,
  formatTimestampUtc,
  healthTone,
  humanizeEventName,
  packCodeLabel,
  shortId,
  timestampTitle,
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

describe("timestamps — IST on screen, UTC on hover (#2572)", () => {
  it("formats an ISO instant as '19 Aug 2026, 13:08 IST'", () => {
    expect(formatTimestamp("2026-08-19T07:38:54.919Z")).toBe("19 Aug 2026, 13:08 IST");
    // No raw UTC "Z" ever reaches the visible string.
    expect(formatTimestamp("2026-08-19T07:38:54.919Z")).not.toMatch(/Z$/);
  });

  it("rolls the IST calendar day over at 18:30 UTC, and pads nothing but the clock", () => {
    expect(formatTimestamp("2026-08-03T18:30:00Z")).toBe("4 Aug 2026, 00:00 IST");
    expect(formatTimestamp("2026-12-31T19:05:00Z")).toBe("1 Jan 2027, 00:35 IST");
    expect(formatDate("2026-08-03T18:29:59Z")).toBe("3 Aug 2026");
  });

  it("is the same whatever zone the host runs in — an offset parse is honoured", () => {
    expect(formatTimestamp("2026-08-19T13:08:00+05:30")).toBe("19 Aug 2026, 13:08 IST");
  });

  it("keeps the exact UTC instant, to the second, for the hover", () => {
    expect(formatTimestampUtc("2026-08-19T07:38:54.919Z")).toBe("2026-08-19 07:38:54 UTC");
    expect(timestampTitle("2026-08-19T07:38:54.919Z")).toBe(
      "19 Aug 2026, 13:08 IST · 2026-08-19 07:38:54 UTC",
    );
  });

  it("date-only and clock forms are IST too", () => {
    expect(formatDate("2026-08-19T07:38:54Z")).toBe("19 Aug 2026");
    expect(formatClock("2026-08-19T07:38:54Z")).toBe("13:08:54 IST");
  });

  it("returns a dash for an unparseable value instead of 'Invalid Date'", () => {
    expect(formatTimestamp("not-a-date")).toBe("—");
    expect(formatTimestampUtc("not-a-date")).toBe("—");
    expect(timestampTitle("not-a-date")).toBe("—");
    expect(formatDate("not-a-date")).toBe("—");
    expect(formatClock("not-a-date")).toBe("—");
    expect(formatRelative("not-a-date")).toBe("—");
  });

  it("an old relative time falls back to the IST date", () => {
    const now = Date.parse("2026-11-04T12:00:00Z");
    expect(formatRelative("2026-08-19T07:38:54Z", now)).toBe("19 Aug 2026");
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
  it("shortens long ids in the MIDDLE and leaves short ones alone (#2572)", () => {
    expect(shortId("be16b2a0-3633-482b-8f5a-4f092c06a3f2")).toBe("be16…a3f2");
    expect(shortId("abc")).toBe("abc");
    // Nothing is gained by eliding a single character.
    expect(shortId("abcd-efgh")).toBe("abcd-efgh");
    expect(shortId("abcd-efghi")).toBe("abcd…fghi");
  });

  it("keeps more of each end on request", () => {
    expect(shortId("be16b2a0-3633-482b-8f5a-4f092c06a3f2", 6)).toBe("be16b2…06a3f2");
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

  it("names the domain the way the console does — display only, the event name is unchanged", () => {
    // Owner ruling 2026-10-01: Company + Agency are "Customers", the job entity is "Posting".
    expect(humanizeEventName("payer.suspended")).toBe("Customer · suspended");
    expect(humanizeEventName("job_posting.created")).toBe("Posting · created");
    // The legacy jobs table is a different entity and keeps its name.
    expect(humanizeEventName("job.created")).toBe("Job · created");
    // No raw underscore leaks out of a domain.
    expect(humanizeEventName("interview_kit.downloaded")).toBe("Interview kit · downloaded");
    expect(humanizeEventName("constructor.called")).toBe("Constructor · called");
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

describe("formatDisplayRupees — no ₹ on screen shows more than two decimals (#2572)", () => {
  it("₹100 and up renders whole rupees, rounded half-up, Indian grouping", () => {
    expect(formatDisplayRupees("870.765100")).toBe("₹871");
    expect(formatDisplayRupees("100")).toBe("₹100");
    expect(formatDisplayRupees("100.49")).toBe("₹100");
    expect(formatDisplayRupees("12345678.5")).toBe("₹1,23,45,679");
  });

  it("under ₹100 renders two decimals", () => {
    expect(formatDisplayRupees("1.512879")).toBe("₹1.51");
    expect(formatDisplayRupees("12.480000")).toBe("₹12.48");
    expect(formatDisplayRupees("3")).toBe("₹3.00");
    expect(formatDisplayRupees("0.5")).toBe("₹0.50");
    expect(formatDisplayRupees("0.005")).toBe("₹0.01");
  });

  it("a figure that rounds up to ₹100 is shown whole, not as ₹100.00", () => {
    expect(formatDisplayRupees("99.996")).toBe("₹100");
    expect(formatDisplayRupees("99.994")).toBe("₹99.99");
  });

  it("below ₹0.01 reads '<₹0.01' — never ₹0.00, which would claim nothing was spent", () => {
    expect(formatDisplayRupees("0.000012")).toBe("<₹0.01");
    expect(formatDisplayRupees("0.004999")).toBe("<₹0.01");
  });

  it("an exact zero is a measurement and reads ₹0.00", () => {
    expect(formatDisplayRupees("0")).toBe("₹0.00");
    expect(formatDisplayRupees("0.000000")).toBe("₹0.00");
  });

  it("never shows more than two decimals for any well-formed input", () => {
    for (const v of ["0.123456", "1.999999", "45.000001", "999.123456", "0.010000"]) {
      expect(formatDisplayRupees(v), v).toMatch(/^(<)?₹[\d,]+(\.\d{1,2})?$/);
    }
  });

  it("keeps the sign as a real minus, and returns an unrecognised value unchanged", () => {
    expect(formatDisplayRupees("-1.5")).toBe("−₹1.50");
    expect(formatDisplayRupees("-250.6")).toBe("−₹251");
    for (const raw of ["", "abc", "1e5", ".5", "₹12.48"]) {
      expect(formatDisplayRupees(raw), raw).toBe(raw);
    }
  });

  it("the exact formatter is unchanged — detail views and exports keep every place", () => {
    expect(formatExactRupees("1.512879")).toBe("₹1.512879");
    expect(formatExactRupees("870.7651")).toBe("₹870.7651");
  });

  it("a double-precision ₹ figure follows the same rules", () => {
    expect(formatDisplayRupeesFromNumber(1.512879)).toBe("₹1.51");
    expect(formatDisplayRupeesFromNumber(870.7651)).toBe("₹871");
    expect(formatDisplayRupeesFromNumber(0.0000004)).toBe("<₹0.01");
    expect(formatDisplayRupeesFromNumber(Number.NaN)).toBe("—");
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
    expect(creditReasonLabel("grant")).toBe("Credit grant");
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

describe("matchTierLabel — one rendering on the worker page and the posting page", () => {
  it("names the two tiers the matcher writes", () => {
    expect(matchTierLabel(1)).toBe("1 — asked-for skill");
    expect(matchTierLabel(2)).toBe("2 — related skill");
  });

  it("is a dash for no tier, and for a tier this portal has not been taught", () => {
    expect(matchTierLabel(null)).toBe("—");
    expect(matchTierLabel(undefined)).toBe("—");
    expect(matchTierLabel(3)).toBe("—");
  });
});
