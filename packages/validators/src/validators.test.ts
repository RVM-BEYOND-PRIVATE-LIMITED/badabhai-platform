import { readFileSync } from "node:fs";
import { join } from "node:path";
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

/** mulberry32 — a tiny seeded PRNG, so the fuzz below is the same on every run. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

// #1924 — the email shape is linear, and no verdict moved.
describe("looksLikePii — the email shape (#1924)", () => {
  // THE PRE-#1924 looksLikePii, frozen as the oracle. Its email pattern is the quadratic
  // one, so it only ever sees short strings here.
  const PRE_1924_EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
  const pre1924LooksLikePii = (s: string): boolean => {
    const value = s.trim();
    if (!value) return false;
    if (PRE_1924_EMAIL_LIKE.test(value)) return true;
    return /\d{7,}/.test(value.replace(/[\s().+-]/g, ""));
  };

  it.each([
    "hr@acme.example",
    "first.last+tag@mail.example.co.in",
    "Mail ravi.kumar@gmail.com now",
    "x@y.z",
    "@@a@b.co",
    "a@b@c.in",
    `${"l".repeat(300)}@acme.in`, // a bounded local part, e.g. {1,64}, would miss this one
  ])("flags the email shape %j", (s) => {
    expect(looksLikePii(s)).toBe(true);
    expect(pre1924LooksLikePii(s)).toBe(true);
  });

  it.each([
    "a@b",
    "@b.com",
    "a @b.com",
    "a@ b.com",
    "a@.com",
    "a@b.",
    "a@@b.com",
    "rate @ 500.00",
    "user@localhost",
  ])("does not flag the near-miss %j", (s) => {
    expect(looksLikePii(s)).toBe(false);
    expect(pre1924LooksLikePii(s)).toBe(false);
  });

  it("agrees with the pre-#1924 oracle on 20,000 seeded emails and near-misses", () => {
    const rng = mulberry32(0x1924);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
    const chars = [..."abcxyzABC019._+-%!#'~\u00e9\u0915"];
    const run = (min: number, max: number): string => {
      let out = "";
      for (let n = min + Math.floor(rng() * (max - min + 1)); n > 0; n--) out += pick(chars);
      return out;
    };
    let flagged = 0;
    for (let i = 0; i < 20_000; i++) {
      const s =
        pick(["", "Mail ", "contact:", "CNC operator\n", "\u00a0", "(", "@", "."]) +
        (rng() < 0.05 ? run(64, 300) : run(0, 10)) +
        (rng() < 0.8 ? "@" : pick(["@@", " @", "@ ", "\uff20", "(at)"])) +
        (rng() < 0.05 ? run(64, 300) : run(0, 10)) +
        (rng() < 0.75 ? "." : pick(["..", ". ", " .", "\u3002", ""])) +
        pick(["com", "in", "co.in", "x", ""]) +
        pick(["", ".", "@", "@x", ")", " now", "\tPF + ESI", "\u2003"]);
      const verdict = looksLikePii(s);
      expect(verdict, JSON.stringify(s)).toBe(pre1924LooksLikePii(s));
      if (verdict) flagged++;
    }
    // Not vacuous: both verdicts are well represented.
    expect(flagged).toBeGreaterThan(4_000);
    expect(flagged).toBeLessThan(16_000);
  });

  it("matches ONE character before the @, never a run that re-scans from every start", () => {
    // The #1875 precedent: pin the pattern's shape, not only its cost. Classes collapse to
    // one token first, so the "@" found is the literal one, not the "@" inside `[^\s@]`.
    const src = readFileSync(join(__dirname, "index.ts"), "utf8");
    const pattern = /^const EMAIL_LIKE = \/(.+)\/;\r?$/m.exec(src)?.[1];
    expect(pattern).toBeDefined();
    const tokens = pattern!.replace(/\[(?:\\.|[^\]\\])*\]/g, "C");
    const local = tokens.slice(0, tokens.indexOf("@"));
    expect(local).toBe("C");
  });
});

// #1924 — before the fix, looksLikePii cost ~190 ms at 20,000 characters and ~4.8 s at
// 100,000 on a run with no whitespace or "@". Every helper is about a millisecond on each
// shape below now. The oracle and the structural pin above are the guard; this generous
// bound is the backstop, still ~10x under the old cost.
describe("the screen helpers stay linear on 100,000 characters (#1924)", () => {
  const REDOS_BUDGET_MS = 500;
  const helpers = [looksLikePii, looksLikeActionContextPii, looksLikeOrgName, looksLikeUrl];
  it.each([
    ["a run with no whitespace or @", "a".repeat(100_000)],
    ["an @ with no dot after it", `${"a".repeat(50_000)}@${"b".repeat(49_999)}`],
    ["an @ before a run of dots", `x@${".".repeat(99_998)}`],
    ["dotted words", "a.".repeat(50_000)],
    ["punctuation pairs", "!a".repeat(50_000)],
    ["a degree before a run of dots", `b.com${".".repeat(99_994)}x`],
    ["title-case words", "Ab ".repeat(33_333)],
    ["an ampersand before a run of spaces", `&${" ".repeat(99_998)}x`],
  ])("%s", (_shape, text) => {
    for (const helper of helpers) {
      const started = performance.now();
      helper(text);
      expect(performance.now() - started, helper.name).toBeLessThan(REDOS_BUDGET_MS);
    }
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

  // #1927 MOVED THESE TWO PINS from false to true. They pinned the old tradeoff — a bare
  // "Ltd" counted only as a TRAILING suffix after a Capitalized token — so the price of
  // keeping "limited experience ok" legal was paid by "Ltd" too. But "Ltd" is never trade
  // prose; only "limited" is. "Ltd" is now flagged in any position and any case after a
  // name character, while "Limited" keeps its stricter rules (the #1927 tables below).
  it("bare lowercase 'acme ltd' IS flagged: 'Ltd' is never prose, whatever the casing (#1927)", () => {
    expect(looksLikeOrgName("acme ltd")).toBe(true);
  });
  it("mid-sentence bare 'Ltd' followed by more words IS flagged (#1927)", () => {
    expect(looksLikeOrgName("Acme Ltd hiring now")).toBe(true);
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

  // #1927 — the strings the issue reproduced on main. Before it, a bare "Ltd"/"Limited"
  // counted only at the END of the string (or before punctuation), so every sentence that
  // went on after the firm's name was served by the career gate and accepted by the job-text
  // screen. "L&T mein apply kariye ji" is in the issue too; it has no suffix (see below).
  it.each([
    "Tata Steel Ltd mein apply kariye",
    "Tata Steel Limited mein apply kariye",
    "Bharat Forge Ltd ki job achhi hai",
    "apply at Kirloskar Brothers Limited for welding",
    "tata steel ltd mein",
    // already flagged before #1927, kept so the issue's list is whole
    "Tata Steel Ltd",
    "Mahindra & Mahindra Pvt Ltd",
    "Sharma & Co mein helper chahiye",
    "Godrej Ltd. ke liye",
  ])("flags the #1927 repro %j", (s) => {
    expect(looksLikeOrgName(s)).toBe(true);
  });

  // #1927 — the same firms in the positions, punctuation, lines and casing real text uses.
  it.each([
    // "Ltd" anywhere after a name, any case
    ["Ltd, English, mid-sentence", "Ashok Leyland Ltd is hiring CNC operators"],
    ["Ltd, English, mid-sentence", "apply at Kalyani Steels Ltd for welding"],
    [
      "Ltd, Hinglish, sentence dot at the end",
      "Pehle Kirloskar Brothers Ltd mein apprenticeship kariye.",
    ],
    ["Ltd, the career gate's own shape", "Tata Steel Ltd mein apply kariye."],
    ["Ltd before a spaced dash", "Bharat Forge Ltd - fitter ki vacancy"],
    ["Ltd before a slash", "Ashok Leyland Ltd/Hosur mein job"],
    ["Ltd in a question", "Kya Tata Steel Ltd mein vacancy hai?"],
    ["Ltd at the end of a line", "Tata Steel Ltd\nWelder chahiye"],
    ["Ltd at the start of a later line", "Welder chahiye\nTata Steel Ltd mein apply kariye"],
    ["Ltd, all lowercase", "kirloskar brothers ltd ki job"],
    ["Ltd, all lowercase", "main 5 saal godrej ltd mein tha"],
    ["Ltd, ALL CAPS", "TATA STEEL LTD MEIN APPLY KARIYE"],
    ["Ltd, ALL CAPS suffix only", "Tata Steel LTD mein apply kariye"],
    ["Ltd after an ampersand name", "L&T Ltd mein apply kariye"],
    ["Ltd after a spaced ampersand name", "Mahindra & Mahindra Ltd mein apply kariye"],
    ["Ltd before a comma clause", "Pehle Bharat Forge Ltd jaiye, phir Thermax"],
    ["Ltd mid-label (skill certifier)", "Tata Steel Ltd welding"],
    ["Ltd mid-label (skill certifier)", "Tata Motors Ltd ka kaam"],
    // "Limited" mid-sentence: Title-case or ALL-CAPS, after a name, before an entity word
    ["Limited before an English verb", "Kalyani Steels Limited is hiring CNC operators"],
    ["Limited before a postposition", "Main 5 saal Sharma Engineering Limited mein welder tha"],
    ["Limited in a question", "Kya Bharat Forge Limited mein job milegi?"],
    ["Limited before jaisi", "Aap Tata Steel Limited jaisi company mein try kariye."],
    [
      "Limited at the end of a middle line",
      "Shift: night\nCompany: Bharat Forge Limited\nOT milega",
    ],
    ["Limited at the start of a later line", "Shift: night\nBharat Forge Limited mein OT milega"],
    ["Limited after an ampersand token", "M&M Limited mein welder ki job"],
    ["Limited after a spaced ampersand name", "Larsen & Toubro Limited mein site supervisor"],
    ["Limited after one token, before a postposition", "Thermax Limited mein job hai"],
    ["Limited after one token, before a postposition", "Wipro Limited ke saath kaam kiya"],
    [
      "two firms in one line",
      "Experience: 3 saal Kalyani Steels Ltd mein, 2 saal Thermax Limited mein",
    ],
  ])("flags a bare suffix %s (%j)", (_where, s) => {
    expect(looksLikeOrgName(s)).toBe(true);
  });

  // #1927 must not touch prose: "limited" is an ordinary word in job text and career answers,
  // and a Title-case posting title capitalizes it like any other word. "Ltd" stays clean where
  // the next word makes it the entity TYPE or an adjective, not a suffix.
  it.each([
    // lowercase and sentence-case "limited"
    "ITI electrician, experience limited hai par seekhne ko taiyaar hoon.",
    "Experience limited hai to bhi chalega",
    "Vacancy limited hai, jaldi apply kariye",
    "Seats are limited.",
    "Overtime limited to 2 hours daily",
    "Time limited offer",
    "Limited time ke liye offer",
    "Limited seats available",
    "Limited slip differential",
    "Unlimited overtime available",
    "Seats limited\nApply jaldi karein",
    // Title-case posting titles and lines
    "Fresher Welder Limited Experience OK",
    "Fresher Welder Limited experience ok",
    "CNC Operator Limited Openings",
    "Experience Limited to 2 years",
    "Machine Operator (Limited Experience Fine)",
    "Quality Inspector — Limited Overtime",
    "Experience Limited Hai Toh Bhi Apply Karein",
    "Welder Required - Limited Seats",
    "Part Time Helper - Limited Hours",
    "Limited Period Offer",
    "Mera Limited experience hai",
    "Mera Experience Limited hai",
    "Night Shift Limited rahegi",
    "Q&A Limited time ke liye",
    // a limited noun before "Limited" is not a firm's last word
    "Welder Vacancies Limited for freshers",
    "Night Shift Seats Limited in Pune",
    "Time Limited ke liye joining bonus",
    // a name and its suffix share a line: a title on one line is not a firm with the next
    "Requirement: CNC Operator\nLimited for ITI freshers",
    // "Ltd" as the entity type or an adjective
    "Urgent requirement in a reputed Ltd company",
    "Ek ltd company mein kaam kiya",
    "Ltd company mein machine operator tha",
    "Only 20 ltd seats left",
    "Hurry. Ltd seats available",
    // "Ltd" after a label's punctuation has no name before it
    "Seats: ltd, jaldi apply karein",
    "Overtime: ltd hours",
    // Title-case trade text with "&" (seed-jobs.ts and the posting DTO pins)
    "Tool & Die Maker",
    "Tool Room Technician — Die & Mould",
    "G & M codes",
    "Fitting & alignment",
    "CNC Operator Required Urgently",
    "Diploma Engineer Trainee (DET)",
    "Peenya Industrial Estate",
    // companion-v2 career answers (the 2026-10-01 replay) that talk about companies
    "Aap apne company mein senior welder se practice karwao, ya welding institute mein advanced course lo.",
    "Kuch companies apne internal training deti hain inspection ke liye.",
    "Company-specific certifications bhi kaam aati hain aage badhne mein.",
    "ASME, AWS certifications bhi international level ke liye seekhe jaa sakte hain.",
    "Aap apne state ke SCVT se bhi certificate le sakte ho.",
  ])("#1927 does not flag the prose %j", (s) => {
    expect(looksLikeOrgName(s)).toBe(false);
  });

  // The stated price of #1927's tiers — pinned so a future tightening is a decision, not an
  // accident.
  it.each([
    // a brand with no suffix: shape cannot tell "L&T" from "Tool & Die"; TD147 owns this
    ["a bare brand, no suffix (TD147)", "L&T mein apply kariye ji"],
    ["a bare brand, no suffix (TD147)", "Tata Motors ya Maruti mein apply kariye"],
    ["'Ltd' read as the entity type", "Tata Steel Ltd company mein jaiye"],
    ["'Limited' before 'to'", "Tata Steel Limited to hire 500 welders"],
    ["a lowercase name before 'limited'", "bharat forge limited mein kaam kiya"],
    ["an ALL-CAPS postposition", "BHARAT FORGE LIMITED MEIN VACANCY"],
  ])("KNOWN RESIDUAL: a firm slips — %s (%j)", (_why, s) => {
    expect(looksLikeOrgName(s)).toBe(false);
  });

  // The other side of the same price, unchanged by #1927: generic and company-law phrases with
  // a strong marker, and a trailing Title-case limited noun, are flagged though they name nobody.
  it.each([
    ["a trailing Title-case limited noun", "Openings Limited"],
    ["a trailing Title-case limited noun", "Hurry, Seats Limited!"],
    ["the generic entity type", "Pvt Ltd company mein 3 saal"],
    ["a company-law skill", "LLP compliance"],
  ])("KNOWN FALSE POSITIVE: %s (%j)", (_why, s) => {
    expect(looksLikeOrgName(s)).toBe(true);
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
    // #1927 — a bare suffix mid-sentence is a company name on the job-text screen too…
    ["Welder chahiye, Tata Steel Ltd mein apply kariye", ["company_name"]],
    ["Bharat Forge Limited mein fitter ki vacancy", ["company_name"]],
    // …while posting prose that only uses the words stays clean
    ["Urgent requirement in a reputed Ltd company", []],
    ["Fresher Welder Limited Experience OK", []],
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
