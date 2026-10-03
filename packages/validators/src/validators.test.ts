import { describe, it, expect } from "vitest";
import {
  e164PhoneSchema,
  isE164Phone,
  uuidSchema,
  emailSchema,
  otpDigitsSchema,
  languageCodeSchema,
  voiceDurationSecondsSchema,
  isValidVoiceDuration,
  nonEmptyMessageSchema,
  safeTextSchema,
  consentPurposesSchema,
  conversationWorkerPrefix,
  looksLikePii,
  looksLikeActionContextPii,
  looksLikeOrgName,
  looksLikeUrl,
  workerVisibleTextScreens,
  bandForCount,
} from "./index";

const WORKER_ID = "11111111-1111-4111-8111-111111111111";

describe("e164PhoneSchema", () => {
  it.each(["+919876543210", "+14155552671", "+447911123456"])("accepts %s", (p) => {
    expect(isE164Phone(p)).toBe(true);
  });

  it.each(["9876543210", "+0123456789", "+12", "abc", "+12 3456 7890"])("rejects %s", (p) => {
    expect(e164PhoneSchema.safeParse(p).success).toBe(false);
  });
});

describe("emailSchema", () => {
  it("accepts and normalizes a valid email", () => {
    expect(emailSchema.safeParse(" Foo@Example.com ")).toEqual({
      success: true,
      data: "foo@example.com",
    });
  });

  it.each(["not-an-email", "foo@", "@example.com", "a".repeat(255) + "@e.com"])(
    "rejects %s",
    (v) => {
      expect(emailSchema.safeParse(v).success).toBe(false);
    },
  );
});

describe("otpDigitsSchema", () => {
  it("fixed length accepts exactly that many digits", () => {
    const totp = otpDigitsSchema(6);
    expect(totp.safeParse("123456").success).toBe(true);
    expect(totp.safeParse("12345").success).toBe(false);
    expect(totp.safeParse("1234567").success).toBe(false);
    expect(totp.safeParse("12345a").success).toBe(false);
  });

  it("range accepts any digit count within [min, max]", () => {
    const otp = otpDigitsSchema({ min: 4, max: 8 });
    expect(otp.safeParse("1234").success).toBe(true);
    expect(otp.safeParse("12345678").success).toBe(true);
    expect(otp.safeParse("123").success).toBe(false);
    expect(otp.safeParse("123456789").success).toBe(false);
  });

  it("trims surrounding whitespace", () => {
    expect(otpDigitsSchema(6).safeParse(" 123456 ").success).toBe(true);
  });
});

describe("uuidSchema", () => {
  it("accepts a valid uuid", () => {
    expect(uuidSchema.safeParse("11111111-1111-4111-8111-111111111111").success).toBe(true);
  });
  it("rejects a non-uuid", () => {
    expect(uuidSchema.safeParse("nope").success).toBe(false);
  });
});

describe("languageCodeSchema", () => {
  it("accepts known languages", () => {
    expect(languageCodeSchema.safeParse("hi").success).toBe(true);
    expect(languageCodeSchema.safeParse("en").success).toBe(true);
  });
  it("rejects unknown languages", () => {
    expect(languageCodeSchema.safeParse("xx").success).toBe(false);
  });
});

describe("voiceDurationSecondsSchema", () => {
  it("accepts up to 120s", () => {
    expect(isValidVoiceDuration(1)).toBe(true);
    expect(isValidVoiceDuration(120)).toBe(true);
  });
  it("rejects 0 and > 120s", () => {
    expect(isValidVoiceDuration(0)).toBe(false);
    expect(isValidVoiceDuration(121)).toBe(false);
    expect(voiceDurationSecondsSchema.safeParse(-5).success).toBe(false);
  });
});

describe("nonEmptyMessageSchema", () => {
  it("trims and accepts non-empty", () => {
    expect(nonEmptyMessageSchema.parse("  hi  ")).toBe("hi");
  });
  it("rejects whitespace-only", () => {
    expect(nonEmptyMessageSchema.safeParse("   ").success).toBe(false);
  });
});

describe("safeTextSchema", () => {
  it("enforces max length", () => {
    const schema = safeTextSchema(5);
    expect(schema.safeParse("hello").success).toBe(true);
    expect(schema.safeParse("hello!").success).toBe(false);
  });
});

// ADR-0003's `conversationObjectKey` and its tests were deleted with the archival
// retirement (2026-08-14). Only the erasure prefix survives — see the helper's own
// comment for why removing it would have been a security regression rather than a
// cleanup.
describe("conversationWorkerPrefix", () => {
  it("returns <worker_id>/ for a valid uuid", () => {
    expect(conversationWorkerPrefix(WORKER_ID)).toBe(`${WORKER_ID}/`);
  });

  it("fails closed on a non-uuid", () => {
    expect(() => conversationWorkerPrefix("not-a-uuid")).toThrow();
  });

  // The erasure sweep concatenates this prefix straight into a Storage `list` body.
  // A prefix that did not end in `/` would match sibling workers whose id shares a
  // leading substring, so the trailing slash is a containment boundary, not cosmetics.
  it("ends in a slash, so the sweep cannot match a neighbouring worker", () => {
    expect(conversationWorkerPrefix(WORKER_ID).endsWith("/")).toBe(true);
  });
});

describe("consentPurposesSchema", () => {
  it("accepts a non-empty unique subset", () => {
    expect(consentPurposesSchema.safeParse(["profiling"]).success).toBe(true);
    expect(consentPurposesSchema.safeParse(["profiling", "resume_generation"]).success).toBe(true);
  });
  it("rejects empty, duplicates, and unknown purposes", () => {
    expect(consentPurposesSchema.safeParse([]).success).toBe(false);
    expect(consentPurposesSchema.safeParse(["profiling", "profiling"]).success).toBe(false);
    expect(consentPurposesSchema.safeParse(["hacking"]).success).toBe(false);
  });
});

describe("looksLikePii", () => {
  it.each(["98765 43210", "+91-98765-43210", "9876543210", "(98765) 43210", "a@b.co"])(
    "flags %s as PII-shaped",
    (s) => {
      expect(looksLikePii(s)).toBe(true);
    },
  );

  // Title-case free text is legitimate content on most looksLikePii call sites
  // (job/posting titles, descriptions) — it must NOT be flagged here. The
  // stricter name/address check lives in looksLikeActionContextPii below, scoped
  // to the one boundary (the actions-context bag) where it's safe.
  it.each([
    "CNC operator",
    "2-5",
    "draft",
    "v1",
    "123456",
    "role_title",
    "Ravi Kumar",
    "A. Sharma",
    "House No. 12, Sector 15",
    "Main Street",
    "New Title",
    "Updated Role Title",
  ])("does not flag %s", (s) => {
    expect(looksLikePii(s)).toBe(false);
  });
});

describe("looksLikeActionContextPii", () => {
  it.each(["98765 43210", "+91-98765-43210", "9876543210", "(98765) 43210", "a@b.co"])(
    "flags %s as PII-shaped",
    (s) => {
      expect(looksLikeActionContextPii(s)).toBe(true);
    },
  );

  it.each(["Ravi Kumar", "A. Sharma", "House No. 12, Sector 15", "Main Street"])(
    "flags %s as PII-shaped",
    (s) => {
      expect(looksLikeActionContextPii(s)).toBe(true);
    },
  );

  it.each(["CNC operator", "2-5", "draft", "v1", "123456", "role_title"])(
    "does not flag %s",
    (s) => {
      expect(looksLikeActionContextPii(s)).toBe(false);
    },
  );
});

describe("looksLikeOrgName", () => {
  it.each([
    "Sharma Precision Pvt Ltd",
    "Sharma Precision Pvt. Ltd.",
    "Deccan Auto Components Private Limited",
    "Kalyani LLP",
    "MIDC Engineering Co.",
    "Acme Ltd",
    "Tata Motors Limited",
    "Acme Inc",
    "Blue Star Corp",
    "Bharat Forge Corporation",
    "Mehta & Co",
    "Mehta and Co",
  ])("flags %s as org-name-shaped", (s) => {
    expect(looksLikeOrgName(s)).toBe(true);
  });

  it.each([
    "CNC operator",
    "Fanuc control",
    "ITI / Diploma",
    "PF + ESI",
    "co-worker",
    "limited experience ok",
    "Limited experience ok", // sentence-case prose — "limited" is not in suffix position
    "corporate transport provided", // "corp" only inside a longer word
    "night shift incentive", // "inc" only inside a longer word
  ])("does not flag %s", (s) => {
    expect(looksLikeOrgName(s)).toBe(false);
  });

  // The documented tradeoff of the trailing-bare-"Ltd" tier: an all-lowercase
  // bare form slips (no Capitalized-ish preceding token), which is the price of
  // never rejecting plain prose like "limited experience ok". The strong markers
  // (Pvt Ltd / Private Limited / ...) remain case-blind.
  it("bare lowercase 'acme ltd' is NOT flagged (fail-open on sloppy casing — documented)", () => {
    expect(looksLikeOrgName("acme ltd")).toBe(false);
  });
  it("mid-sentence bare 'Ltd' followed by more words is NOT flagged (same tier, same tradeoff)", () => {
    expect(looksLikeOrgName("Acme Ltd hiring now")).toBe(false);
  });

  // #1914 — the "Co" forms still catch every firm spelling…
  it.each([
    "Sharma & Co",
    "Sharma & Co.",
    "Sharma and Co",
    "Sharma and Co.",
    "SHARMA & CO",
    "SHARMA & CO.",
    "Sharma & Co, Pune",
    "Sharma & Co., Pune",
    "Sharma & Co Pvt Ltd",
    "Sharma & Co - Pune", // a SPACED dash is punctuation, not a compound
    "Sharma & Co.-Pune",
    "Sharma Co.",
    "Fitter at Mehta & Co",
    // the compound list is closed: these words do not make "co" a compound
    "Sharma & Co operations manager",
    "Sharma & Co 2 saal",
    "Sharma & Co driver chahiye",
    // "2 weld" compounds only as "weld"/"welding": a count of welders is a firm's ad
    "Sharma & Co 2 welder chahiye",
    "Sharma & Co 2 welders",
    "Sharma & Co 2 gases",
    // a newline is never the gap of a compound
    "Sharma & Co\nOperation head",
    "Sharma & Co.\nordinator",
    // the "Co." form on its own: no compound is spelled "co.-", whatever the dash
    "Sharma Co.-Pune",
    "Mehta Co.—Fitter",
    // after a dot only "ordinat" compounds: the co-operative employers keep flagging
    "Cosmos Co.op. Bank",
    "Shanti Co. Operative Housing Society",
    "XYZ CO.OP. BANK",
    "Sharma & Co. Operative",
    "and co.operation",
  ])("still flags the firm form %j", (s) => {
    expect(looksLikeOrgName(s)).toBe(true);
  });

  // …but not a "co" that opens a compound.
  it.each([
    "Supervise the line and co-ordinate with the shift in-charge",
    "Work with seniors & co-workers",
    "Must co-operate and co-ordinate with QC",
    "and co-operative society member",
    "and co-op canteen",
    "and co-curricular activities",
    "and co- ordinates the crew", // dash then a space: still the compound
    "and co ordinate with the supervisor",
    "and co operation with the team",
    "and co operative housing",
    "and co op society",
    "& co worker support",
    "and co curricular",
    "MIG and CO 2 welding",
    "MIG and CO2 welding",
    "QUALITY CO.ORDINATOR",
    "Quality co. ordinator",
    "and co.ordinate",
    "AND CO-ORDINATE",
  ])("does not flag the co- compound %j", (s) => {
    expect(looksLikeOrgName(s)).toBe(false);
  });

  it.each([
    ["U+2010 hyphen", "and co\u2010ordinate"],
    ["U+2011 non-breaking hyphen", "and co\u2011ordinate"],
    ["U+2012 figure dash", "and co\u2012ordinate"],
    ["U+2013 en dash", "and co\u2013ordinate"],
    ["U+2014 em dash", "& co\u2014workers"],
    ["U+2015 horizontal bar", "and co\u2015operate"],
    ["U+2212 minus sign", "and co\u2212ordinate"],
    ["U+FE63 small hyphen-minus", "and co\uFE63ordinate"],
    ["U+FF0D fullwidth hyphen-minus", "and co\uFF0Dordinate"],
  ])("treats the %s as a compound dash (%j)", (_dash, s) => {
    expect(looksLikeOrgName(s)).toBe(false);
  });

  // The stated price of the "& Co" / "and Co" guard: a firm glued to any dash, or
  // followed across a space by a listed compound word, reads as a compound.
  it.each([
    ["glued to a dash", "Sharma & Co-Pune"],
    ["glued to an em dash", "Sharma & Co—Pune"],
    ["a trailing dash", "Sharma & Co-"],
    ["a listed word across a space", "Sharma & Co workers chahiye"],
    ["a listed word across a space", "Mehta & Co worker chahiye"],
    ["a listed word across a space", "Sharma & Co Operative Store"],
  ])("KNOWN RESIDUAL: a firm %s slips the Co tier (%j)", (_why, s) => {
    expect(looksLikeOrgName(s)).toBe(false);
  });
});

describe("bandForCount", () => {
  // Boundary table — every derived value is one of the EXACT shipped
  // VACANCY_BANDS strings. Note 25 -> "11-25" (25+ is strictly > 25).
  it.each([
    [1, "1"],
    [2, "2-5"],
    [5, "2-5"],
    [6, "6-10"],
    [7, "6-10"],
    [10, "6-10"],
    [11, "11-25"],
    [25, "11-25"],
    [26, "25+"],
    [100, "25+"],
  ] as const)("maps %i -> %s", (n, band) => {
    expect(bandForCount(n)).toBe(band);
  });

  it.each([0, -1, 1.5, NaN])("fails closed on non-positive-integer %s", (n) => {
    expect(() => bandForCount(n)).toThrow();
  });
});

describe("looksLikeUrl", () => {
  it.each([
    "https://acme.example/jobs",
    "http://apply.here",
    "Apply at www.acme.in",
    "acme.co.in",
    "jobs.acmecomponents.com",
    "careers.acme.org",
    "acme.io/apply",
  ])("flags %s as link-shaped", (s) => {
    expect(looksLikeUrl(s)).toBe(true);
  });

  it.each([
    "PF + ESI",
    "2.5 in lathe work", // space before "in" — the TLD tier needs the dot ADJACENT
    "Quality check karna.",
    "MIDC Engineering Co.", // dot AFTER "co" is the org suffix, not a ".co" TLD
    "ITI / Diploma",
    "8 hrs. incentive",
    "Fanuc control",
  ])("does not flag %s", (s) => {
    expect(looksLikeUrl(s)).toBe(false);
  });

  // #1914 — every real host shape still fires…
  it.each([
    "acme.com",
    "ACME.COM",
    "acme-components.com",
    "acme.co.in",
    "x.in",
    "x.com",
    "a.com", // no single-letter host but b/m is skipped
    "c.com",
    "b.in", // a degree is ".Com" only
    "m.co",
    ".com",
    "Apply at www.",
    "http://b.com",
    "www.m.com",
    "shop.b.com", // "b" is a subdomain label, not a token
    "b.com.au",
    "B.Com.acme.in", // a degree glued to a host is one host
    "B.Com-acme.in",
    "a@b.com",
    "b@m.com",
    "B.Com graduate, apply at acme.com",
    "M.Com / careers.acme.org",
  ])("still flags the host %j", (s) => {
    expect(looksLikeUrl(s)).toBe(true);
  });

  // …but B.Com / M.Com are degrees.
  it.each([
    "B.Com",
    "M.Com",
    "b.com",
    "B.COM",
    "B.Com.",
    "B.Com...",
    "BCom",
    "MCom",
    "B. Com",
    "B.Com/M.Com graduate preferred",
    "Qualification: B.Com / M.Com",
    "(B.Com)",
    "B.Com(Hons)",
    "B.Com, M.Com, BBA",
    "B.Com pass, Tally aata ho",
    "B.Tech / B.Sc / B.E.",
  ])("does not flag the degree %j", (s) => {
    expect(looksLikeUrl(s)).toBe(false);
  });

  // The stated price of the degree skip: the hosts b.com and m.com themselves,
  // with or without a path, port, query or fragment, slip the TLD tier. A scheme
  // or "www." still catches them.
  it.each(["b.com/apply", "m.com", "M.COM:8080", "m.com?x=1", "b.com#careers"])(
    "KNOWN RESIDUAL: the bare host %j slips the TLD tier",
    (s) => {
      expect(looksLikeUrl(s)).toBe(false);
    },
  );
});

describe("workerVisibleTextScreens", () => {
  it.each([
    ["Call 98765 43210", ["contact_details"]],
    ["hr@acme.example", ["contact_details"]],
    ["Operator at Kalyani Pvt Ltd", ["company_name"]],
    ["Details at www.acme.in", ["link"]],
    ["Acme Pvt Ltd 9876543210 acme.in", ["contact_details", "company_name", "link"]],
    ["CNC Operator — Night Shift", []],
    ["PF + ESI", []],
    // #1914 — the requirement text that the #1823 posting screen used to 400
    ["B.Com/M.Com graduate preferred, will co-ordinate with the store team", []],
    ["Sharma & Co. — apply at acme.com", ["company_name", "link"]],
    ["Security guard at Cosmos Co.op. Bank", ["company_name"]],
  ] as const)("%j trips %j", (s, screens) => {
    expect(workerVisibleTextScreens(s)).toEqual(screens);
  });

  it("is exactly the three helpers, in pii → company → link order", () => {
    const samples = [
      "Call 98765 43210",
      "Kalyani LLP",
      "acme.co.in",
      "Mehta & Co 9876543210",
      "limited experience ok",
      "Fanuc control",
    ];
    for (const s of samples) {
      const expected = [
        ...(looksLikePii(s) ? ["contact_details"] : []),
        ...(looksLikeOrgName(s) ? ["company_name"] : []),
        ...(looksLikeUrl(s) ? ["link"] : []),
      ];
      expect(workerVisibleTextScreens(s)).toEqual(expected);
    }
  });
});
