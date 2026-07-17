import { describe, it, expect } from "vitest";
import {
  e164PhoneSchema,
  isE164Phone,
  uuidSchema,
  languageCodeSchema,
  voiceDurationSecondsSchema,
  isValidVoiceDuration,
  nonEmptyMessageSchema,
  safeTextSchema,
  consentPurposesSchema,
  conversationObjectKey,
  conversationWorkerPrefix,
  looksLikePii,
  looksLikeOrgName,
  looksLikeUrl,
  bandForCount,
} from "./index";

const WORKER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

describe("e164PhoneSchema", () => {
  it.each(["+919876543210", "+14155552671", "+447911123456"])("accepts %s", (p) => {
    expect(isE164Phone(p)).toBe(true);
  });

  it.each(["9876543210", "+0123456789", "+12", "abc", "+12 3456 7890"])("rejects %s", (p) => {
    expect(e164PhoneSchema.safeParse(p).success).toBe(false);
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

describe("conversationObjectKey", () => {
  it("builds an opaque <worker>/<session>/v<version>.json key", () => {
    expect(conversationObjectKey({ workerId: WORKER_ID, sessionId: SESSION_ID, version: 1 })).toBe(
      `${WORKER_ID}/${SESSION_ID}/v1.json`,
    );
  });

  it("always starts with the per-worker prefix (so prefix deletion covers it)", () => {
    const key = conversationObjectKey({ workerId: WORKER_ID, sessionId: SESSION_ID, version: 3 });
    expect(key.startsWith(conversationWorkerPrefix(WORKER_ID))).toBe(true);
  });

  it("fails closed when an id is not a UUID (no PII in a storage path)", () => {
    expect(() =>
      conversationObjectKey({ workerId: "+919876543210", sessionId: SESSION_ID, version: 1 }),
    ).toThrow();
    expect(() =>
      conversationObjectKey({ workerId: WORKER_ID, sessionId: "ramesh-kumar", version: 1 }),
    ).toThrow();
  });

  it("rejects non-positive / non-integer versions", () => {
    expect(() =>
      conversationObjectKey({ workerId: WORKER_ID, sessionId: SESSION_ID, version: 0 }),
    ).toThrow();
    expect(() =>
      conversationObjectKey({ workerId: WORKER_ID, sessionId: SESSION_ID, version: 1.5 }),
    ).toThrow();
  });
});

describe("conversationWorkerPrefix", () => {
  it("returns <worker_id>/ for a valid uuid", () => {
    expect(conversationWorkerPrefix(WORKER_ID)).toBe(`${WORKER_ID}/`);
  });
  it("fails closed on a non-uuid", () => {
    expect(() => conversationWorkerPrefix("not-a-uuid")).toThrow();
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

  it.each(["CNC operator", "2-5", "draft", "v1", "123456", "role_title"])(
    "does not flag %s",
    (s) => {
      expect(looksLikePii(s)).toBe(false);
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
});
