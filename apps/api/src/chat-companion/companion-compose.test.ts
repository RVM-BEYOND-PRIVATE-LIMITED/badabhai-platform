import { describe, expect, it } from "vitest";
import { personaCorpus } from "@badabhai/profiling-lexicon";
import {
  COMPANION_APPLIED_KEY,
  COMPANION_JOBS_TAB_KEY,
  COMPANION_JOB_KEY_PREFIX,
  COMPANION_JOB_LABEL_SEPARATOR,
  COMPANION_NEW_JOBS_KEY,
  COMPANION_RESUME_KEY,
} from "./companion-keys";
import {
  composeApplied,
  composeDigest,
  composeFallback,
  composeFor,
  composeGuarantee,
  composeJobs,
  jobChip,
  replyText,
  replyTts,
} from "./companion-compose";
import { chooseNudge, type CompanionFacts, type CompanionJob } from "./companion-facts";

const job = (n: number, city: string | null = "Pune"): CompanionJob => ({
  jobPostingId: `00000000-0000-4000-8000-00000000000${n}`,
  title: `CNC Operator ${n}`,
  city,
});

const base: CompanionFacts = {
  resume: {
    resumeId: "r1",
    source: "form",
    renderStatus: "rendered",
    tradeLabel: "VMC Operator",
    experienceYears: 5,
    machines: ["Fanuc", "Siemens", "Haas"],
    city: "Pune",
  },
  resumeUnavailable: false,
  pendingUpdate: null,
  appliedCount: 2,
  jobs: { scope: "profile", count: 3, capped: false, jobs: [job(1), job(2), job(3)], windowDays: 7 },
  missingField: null,
};

const keys = (turn: { options: readonly { option_key: string }[] }) => turn.options.map((o) => o.option_key);
const maxChips = personaCorpus().maxChips;

describe("composeDigest — 'ab tak kya hua'", () => {
  it("states the road, the résumé's own facts, the applied count, the new jobs and one nudge", () => {
    const turn = composeDigest(base);
    expect(replyText(turn).split("\n")).toEqual([
      "Namaste. Aapki profile taiyaar hai. Ab tak yeh hua hai.",
      "Aapka resume form se bana hai.",
      "Resume mein: VMC Operator, 5 saal tajurba, Fanuc, Siemens, Pune.",
      "Aapne ab tak 2 jobs par apply kiya hai.",
      "Pichhle 7 din mein aapke kaam ke 3 naye jobs aaye hain.",
      "Naye jobs dekhkar apply kar sakte hain.",
    ]);
    expect(turn.nudge).toBe("apply_new");
  });

  it("serves at most TWO job chips, then the Jobs tab and 'Resume badlein' — four, the persona's limit", () => {
    const turn = composeDigest(base);
    expect(keys(turn)).toEqual([
      `${COMPANION_JOB_KEY_PREFIX}${job(1).jobPostingId}`,
      `${COMPANION_JOB_KEY_PREFIX}${job(2).jobPostingId}`,
      COMPANION_JOBS_TAB_KEY,
      COMPANION_RESUME_KEY,
    ]);
    expect(turn.options.length).toBeLessThanOrEqual(maxChips);
    expect(turn.jobChipsCount).toBe(2);
  });

  it("says each road honestly, and nothing for a pre-0125 résumé beyond that one exists", () => {
    const road = (source: "chat" | "form" | "resume_upload" | null) =>
      replyText(composeDigest({ ...base, resume: { ...base.resume!, source } })).split("\n")[1];
    expect(road("chat")).toBe("Aapka resume chat se bana hai.");
    expect(road("resume_upload")).toBe("Aapka resume aapke upload kiye resume se bana hai.");
    expect(road(null)).toBe("Aapka resume ban chuka hai.");
  });

  it("a résumé still being built: says so, states no road, and the nudge is to wait", () => {
    const building = { ...base, resume: { ...base.resume!, renderStatus: "pending" } };
    const lines = replyText(composeDigest(building)).split("\n");
    expect(lines).toContain("Aapka resume ban raha hai. Thodi der mein Resume tab mein dikhega.");
    expect(lines.some((l) => l.startsWith("Aapka resume form se"))).toBe(false);
    expect(composeDigest(building).nudge).toBe("resume_pending");
    expect(composeDigest({ ...base, resume: null }).nudge).toBe("resume_pending");
  });

  it("an unreadable résumé is left out, not reported as 'still being built'", () => {
    const turn = composeDigest({ ...base, resume: null, resumeUnavailable: true });
    expect(replyText(turn)).not.toMatch(/Aapka resume/);
    expect(turn.nudge).toBe("apply_new");
  });

  it("an accepted update in flight and a failed one are both reported", () => {
    expect(replyText(composeDigest({ ...base, pendingUpdate: "in_progress" }))).toContain(
      "Aapka resume update ho raha hai.",
    );
    expect(replyText(composeDigest({ ...base, pendingUpdate: "failed" }))).toContain(
      "Resume update poora nahi hua.",
    );
  });

  it("never applied, with new jobs: the first-application nudge", () => {
    const turn = composeDigest({ ...base, appliedCount: 0 });
    expect(replyText(turn)).toContain("Aapne abhi tak kisi job par apply nahi kiya hai.");
    expect(replyText(turn)).toContain("Neeche diye jobs mein se ek chunkar apply karein.");
    expect(turn.nudge).toBe("apply_first");
  });

  it("no wanted skills: NO 'aapke kaam ke' claim, no job chips, the Jobs-tab pointer", () => {
    const turn = composeDigest({
      ...base,
      jobs: { scope: "no_skills", count: null, capped: false, jobs: [], windowDays: 7 },
    });
    expect(replyText(turn)).not.toContain("aapke kaam");
    expect(replyText(turn)).toContain("Naye jobs dekhne ke liye Jobs tab kholein.");
    expect(keys(turn)).toEqual([COMPANION_JOBS_TAB_KEY, COMPANION_APPLIED_KEY, COMPANION_RESUME_KEY]);
  });

  it("a failed jobs read is said plainly, never a false zero", () => {
    const turn = composeDigest({
      ...base,
      jobs: { scope: "unavailable", count: null, capped: false, jobs: [], windowDays: 7 },
    });
    expect(replyText(turn)).toContain("Abhi naye jobs nahi dikha pa rahe.");
    expect(replyText(turn)).not.toMatch(/koi naya job nahi/);
  });

  it("at the count cap, '{n} se zyada'", () => {
    const turn = composeDigest({ ...base, jobs: { ...base.jobs, count: 20, capped: true } });
    expect(replyText(turn)).toContain("aapke kaam ke 20 se zyada naye jobs aaye hain.");
  });

  it("no new jobs and a fillable gap: the complete-profile nudge, in both scripts", () => {
    const turn = composeDigest({
      ...base,
      jobs: { scope: "profile", count: 0, capped: false, jobs: [], windowDays: 7 },
      missingField: "machines",
    });
    expect(replyText(turn)).toContain("Profile mein machine ki jaankari jodne se resume behtar banega.");
    expect(replyTts(turn)).toContain("प्रोफ़ाइल में मशीन की जानकारी जोड़ने से रिज़्यूमे बेहतर बनेगा।");
    expect(turn.nudge).toBe("complete_profile");
  });

  it("nothing to nudge: the all-set line, and no nudge recorded", () => {
    const turn = composeDigest({
      ...base,
      jobs: { scope: "profile", count: 0, capped: false, jobs: [], windowDays: 7 },
    });
    expect(replyText(turn)).toContain("Abhi sab theek hai.");
    expect(turn.nudge).toBeNull();
  });

  it("the read-aloud script is Devanagari throughout — the glance twin names no Latin label", () => {
    const tts = replyTts(composeDigest(base));
    expect(tts).toBeDefined();
    expect(tts).not.toMatch(/[A-Za-z]/);
  });
});

describe("the other replies", () => {
  it("jobs: the count, up to three job chips and the Jobs tab", () => {
    const turn = composeJobs(base);
    expect(replyText(turn)).toContain("Kisi job par dabakar poori jaankari dekhein.");
    expect(keys(turn)).toHaveLength(4);
    expect(keys(turn)[3]).toBe(COMPANION_JOBS_TAB_KEY);
    expect(turn.jobChipsCount).toBe(3);
  });

  it("jobs with none matched: says so, and offers the tab and the résumé", () => {
    const turn = composeJobs({ ...base, jobs: { ...base.jobs, count: 0, jobs: [] } });
    expect(replyText(turn)).toContain("Sabhi jobs Jobs tab mein hain.");
    expect(keys(turn)).toEqual([COMPANION_JOBS_TAB_KEY, COMPANION_RESUME_KEY]);
  });

  it("applied: the count and the list chip; zero applied turns into a nudge", () => {
    expect(keys(composeApplied(base))[0]).toBe(COMPANION_APPLIED_KEY);
    const none = composeApplied({ ...base, appliedCount: 0 });
    expect(keys(none)).not.toContain(COMPANION_APPLIED_KEY);
    expect(keys(none)[0]).toBe(COMPANION_NEW_JOBS_KEY);
    expect(none.nudge).toBe("apply_first");
  });

  it("guarantee: the persona line verbatim, and NO read-aloud twin is invented for it", () => {
    const turn = composeGuarantee(base);
    expect(replyText(turn)).toBe(personaCorpus().guaranteeLine);
    expect(replyTts(turn)).toBeUndefined();
  });

  it("fallback: what the companion helps with, as chips", () => {
    expect(keys(composeFallback(base))).toEqual([COMPANION_NEW_JOBS_KEY, COMPANION_APPLIED_KEY, COMPANION_RESUME_KEY]);
  });

  it.each(["digest", "jobs", "applied", "guarantee", "fallback"] as const)(
    "%s never exceeds the persona's chip limit, even with every fact at its richest",
    (intent) => {
      const rich = { ...base, jobs: { ...base.jobs, jobs: [job(1), job(2), job(3), job(4), job(5)] } };
      expect(composeFor(intent, rich).options.length).toBeLessThanOrEqual(maxChips);
    },
  );
});

describe("jobChip", () => {
  it("is the title, the separator and the city", () => {
    expect(jobChip(job(1)).label_text).toBe(`CNC Operator 1${COMPANION_JOB_LABEL_SEPARATOR}Pune`);
    expect(jobChip(job(1, null)).label_text).toBe("CNC Operator 1");
  });

  it("cuts a long title to one row", () => {
    const long = jobChip({ ...job(1, null), title: "x".repeat(80) }).label_text;
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("…")).toBe(true);
  });

  it("a title containing the separator cannot mis-split into a fake city", () => {
    const label = jobChip({ ...job(1), title: `Fitter${COMPANION_JOB_LABEL_SEPARATOR}Urgent` }).label_text;
    expect(label.split(COMPANION_JOB_LABEL_SEPARATOR)).toEqual(["Fitter - Urgent", "Pune"]);
  });
});

describe("chooseNudge — ordered, first match wins", () => {
  const noJobs = { ...base.jobs, count: 0, jobs: [] };
  it.each([
    ["building résumé beats everything", { ...base, resume: null, appliedCount: 0 }, "resume_pending"],
    ["update in flight", { ...base, pendingUpdate: "in_progress" as const }, "resume_pending"],
    ["never applied + new jobs", { ...base, appliedCount: 0 }, "apply_first"],
    ["new jobs", base, "apply_new"],
    ["applied count unknown + new jobs", { ...base, appliedCount: null }, "apply_new"],
    ["gap, no new jobs", { ...base, jobs: noJobs, missingField: "skills" }, "complete_profile"],
    ["no-skills scope never counts as new jobs", { ...base, jobs: { ...noJobs, scope: "no_skills" as const, count: null } }, null],
    ["nothing", { ...base, jobs: noJobs }, null],
  ] as const)("%s", (_name, facts, expected) => {
    expect(chooseNudge(facts as CompanionFacts)).toBe(expected);
  });
});
