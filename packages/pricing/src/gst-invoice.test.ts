import { describe, expect, it } from "vitest";
import {
  GST_STATE_CODES,
  financialYearOf,
  formatDocumentNumber,
  gstPriceLine,
  gstStateName,
  gstinCheckCharacter,
  gstinStateCode,
  isGstStateCode,
  isValidGstin,
  normalizeGstinInput,
  rupeesInWords,
  splitGstForSupply,
  supplyTypeFor,
} from "./index";

/**
 * #2749 part 4 — the invoice arithmetic. Fixture GSTINs are FAKE (`AAAAA0000A` as the PAN) with a
 * computed check character; no real GSTIN, PAN or company appears in this file.
 */
const FAKE_HARYANA_GSTIN = "06AAAAA0000A1Z6";
const FAKE_MAHARASHTRA_GSTIN = "27AAAAA0000A1Z2";

describe("splitGstForSupply — whole rupees, CGST takes the odd rupee (owner ruling 2026-11-18)", () => {
  it("₹180 inside the state → CGST ₹90 + SGST ₹90", () => {
    expect(splitGstForSupply(18_000, "intra")).toEqual({
      cgstPaise: 9000,
      sgstPaise: 9000,
      igstPaise: 0,
    });
  });

  it("₹181 inside the state → CGST ₹91 + SGST ₹90", () => {
    expect(splitGstForSupply(18_100, "intra")).toEqual({
      cgstPaise: 9100,
      sgstPaise: 9000,
      igstPaise: 0,
    });
  });

  it("across states the whole GST is IGST", () => {
    expect(splitGstForSupply(18_100, "inter")).toEqual({ cgstPaise: 0, sgstPaise: 0, igstPaise: 18_100 });
  });

  it("the parts always sum to the GST and each is a whole rupee", () => {
    for (let rupees = 0; rupees <= 2000; rupees += 1) {
      for (const type of ["intra", "inter"] as const) {
        const s = splitGstForSupply(rupees * 100, type);
        expect(s.cgstPaise + s.sgstPaise + s.igstPaise).toBe(rupees * 100);
        expect([s.cgstPaise, s.sgstPaise, s.igstPaise].every((v) => v % 100 === 0)).toBe(true);
        expect(s.cgstPaise - s.sgstPaise === 0 || s.cgstPaise - s.sgstPaise === 100).toBe(true);
      }
    }
  });

  it("splits every pack's line from gstPriceLine", () => {
    for (const price of [999, 1599, 2999, 9999]) {
      const line = gstPriceLine(price);
      const s = splitGstForSupply(line.gstPaise, "intra");
      expect(line.taxablePaise + s.cgstPaise + s.sgstPaise).toBe(line.totalPaise);
    }
  });

  it("refuses a GST that is not a non-negative whole rupee", () => {
    expect(() => splitGstForSupply(17_982, "intra")).toThrow(RangeError);
    expect(() => splitGstForSupply(-100, "inter")).toThrow(RangeError);
    expect(() => splitGstForSupply(1.5, "inter")).toThrow(RangeError);
  });

  it("intra-state exactly when the place of supply is the seller's state", () => {
    expect(supplyTypeFor("06", "06")).toBe("intra");
    expect(supplyTypeFor("06", "27")).toBe("inter");
  });
});

describe("financialYearOf — 1 April to 31 March, IST", () => {
  it("31 Mar 23:59:59.999 IST is the old year; 1 Apr 00:00 IST is the new one", () => {
    expect(financialYearOf(new Date("2027-03-31T23:59:59.999+05:30"))).toBe("2026-27");
    expect(financialYearOf(new Date("2027-04-01T00:00:00.000+05:30"))).toBe("2027-28");
  });

  it("reads the IST calendar, not UTC (31 Mar 19:00 UTC is already 1 Apr in IST)", () => {
    expect(financialYearOf(new Date("2027-03-31T18:29:59.999Z"))).toBe("2026-27");
    expect(financialYearOf(new Date("2027-03-31T18:30:00.000Z"))).toBe("2027-28");
  });

  it("mid-year and the century", () => {
    expect(financialYearOf(new Date("2026-11-18T10:00:00Z"))).toBe("2026-27");
    expect(financialYearOf(new Date("2027-01-15T10:00:00Z"))).toBe("2026-27");
    expect(financialYearOf(new Date("2099-06-01T00:00:00Z"))).toBe("2099-00");
  });

  it("refuses an invalid date", () => {
    expect(() => financialYearOf(new Date("not a date"))).toThrow(RangeError);
  });
});

describe("formatDocumentNumber — prefix / FY / 4-digit serial, at most 16 characters", () => {
  it("prints the owner's series", () => {
    expect(formatDocumentNumber("BB", "2026-27", 1)).toBe("BB/2026-27/0001");
    expect(formatDocumentNumber("CN", "2026-27", 42)).toBe("CN/2026-27/0042");
    expect(formatDocumentNumber("BB", "2026-27", 1).length).toBe(15);
  });

  it("grows wider past 9999 while it fits", () => {
    expect(formatDocumentNumber("BB", "2026-27", 10_000)).toBe("BB/2026-27/10000");
  });

  it("refuses a number longer than 16 characters, and a serial below 1", () => {
    expect(() => formatDocumentNumber("BB", "2026-27", 100_000)).toThrow(RangeError);
    expect(() => formatDocumentNumber("BBX", "2026-27", 10_000)).toThrow(RangeError);
    expect(() => formatDocumentNumber("BB", "2026-27", 0)).toThrow(RangeError);
    expect(() => formatDocumentNumber("BB", "2026-27", 1.5)).toThrow(RangeError);
  });
});

describe("rupeesInWords — Indian system", () => {
  it.each([
    [117_900, "Rupees One Thousand One Hundred Seventy Nine Only"],
    [188_700, "Rupees One Thousand Eight Hundred Eighty Seven Only"],
    [1_179_900, "Rupees Eleven Thousand Seven Hundred Ninety Nine Only"],
    [0, "Rupees Zero Only"],
    [100_050, "Rupees One Thousand and Fifty Paise Only"],
    [10_000_000, "Rupees One Lakh Only"],
    [12_345_678_900, "Rupees Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine Only"],
    [1_000_000_000_000, "Rupees One Thousand Crore Only"],
  ])("%i paise → %s", (paise, words) => {
    expect(rupeesInWords(paise)).toBe(words);
  });

  it("refuses a negative or fractional amount", () => {
    expect(() => rupeesInWords(-1)).toThrow(RangeError);
    expect(() => rupeesInWords(1.5)).toThrow(RangeError);
  });
});

describe("GST state codes", () => {
  it("knows Haryana (06) and Maharashtra (27); leaves out the retired 25 and 28", () => {
    expect(gstStateName("06")).toBe("Haryana");
    expect(gstStateName("27")).toBe("Maharashtra");
    expect(isGstStateCode("25")).toBe(false);
    expect(isGstStateCode("28")).toBe(false);
    expect(isGstStateCode("6")).toBe(false);
    expect(isGstStateCode(6)).toBe(false);
    expect(gstStateName("99")).toBeNull();
  });

  it("lists every code as two digits, ascending", () => {
    expect(GST_STATE_CODES.every((c) => /^[0-9]{2}$/.test(c))).toBe(true);
    expect([...GST_STATE_CODES].sort()).toEqual(GST_STATE_CODES);
    expect(GST_STATE_CODES).toHaveLength(37);
  });
});

describe("GSTIN — shape and mod-36 check character", () => {
  it("accepts a fake GSTIN whose check character is right", () => {
    expect(isValidGstin(FAKE_HARYANA_GSTIN)).toBe(true);
    expect(isValidGstin(FAKE_MAHARASHTRA_GSTIN)).toBe(true);
    expect(gstinCheckCharacter(FAKE_HARYANA_GSTIN.slice(0, 14))).toBe("6");
  });

  it("refuses a wrong check character, a wrong shape and a lower-case one", () => {
    expect(isValidGstin("06AAAAA0000A1Z5")).toBe(false);
    expect(isValidGstin("06AAAAA0000A1X6")).toBe(false);
    expect(isValidGstin("06AAAAA0000A1Z")).toBe(false);
    expect(isValidGstin(FAKE_HARYANA_GSTIN.toLowerCase())).toBe(false);
  });

  it("normalises pasted input and reads the state", () => {
    expect(normalizeGstinInput(" 06aaaaa0000a1z6 ")).toBe(FAKE_HARYANA_GSTIN);
    expect(gstinStateCode(FAKE_MAHARASHTRA_GSTIN)).toBe("27");
  });

  it("a check of the wrong length or alphabet is a RangeError", () => {
    expect(() => gstinCheckCharacter("06AAAAA")).toThrow(RangeError);
    expect(() => gstinCheckCharacter("06aaaaa0000a1z")).toThrow(RangeError);
  });
});
