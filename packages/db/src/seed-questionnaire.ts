/**
 * Questionnaire seed (ADR-0005, first content slice).
 *
 * Populates the metadata-driven profiling tables from the existing CNC/VMC
 * question bank (`apps/ai-service/app/profiling/question_bank.py`) so behaviour is
 * identical on day one and the 100+ trades can be added later as pure data.
 *
 * This is REFERENCE/CATALOG data (no PII), so — unlike `seed.ts` — it is safe to
 * run in any environment and is idempotent (`ON CONFLICT DO NOTHING`), so re-runs
 * are no-ops.
 *
 *   pnpm --filter @badabhai/db db:seed:questionnaire
 *   (DATABASE_URL is read from the environment / repo-root .env.)
 *
 * Mapping (faithful to the source bank):
 *  - the 7 cnc_vmc roles      -> `profiles`
 *  - the 9 interview topics    -> `questions` (shared catalog)
 *  - each profile x each topic -> `profile_questions` (order + `core` -> is_required)
 *
 * NOTE: `question_text` carries the existing Hinglish phrasing verbatim. The
 * "English-in-DB + curated frontend i18n" decision (ADR-0005 #5) applies to future
 * re-authoring; the seed preserves the canonical content as-is.
 */
import { config } from "dotenv";
import { createDbClient } from "./client";
import { profiles, questions, profileQuestions } from "./schema";

// Load the repo-root .env (CWD is packages/db when run via the package script).
config({ path: "../../.env" });

type AnswerType = "text" | "number" | "date" | "single_select" | "multi_select";

// The 7 CNC/VMC roles (ROLE_FAMILIES["cnc_vmc"].roles).
const ROLES: { slug: string; name: string }[] = [
  { slug: "cnc_turner_operator", name: "CNC Turner/Operator" },
  { slug: "vmc_operator", name: "VMC Operator" },
  { slug: "hmc_operator", name: "HMC Operator" },
  { slug: "cnc_setter_operator", name: "CNC Setter-Operator" },
  { slug: "cnc_programmer", name: "CNC Programmer" },
  { slug: "cam_programmer", name: "CAM Programmer" },
  { slug: "cnc_grinding_operator", name: "CNC Grinding Operator" },
];

// The 9 ordered topics (_CNC_VMC_TOPICS). `core` -> is_required on the mapping.
// `answerType`/`extractionTopic` are catalog metadata; select-type questions are
// authored here but can't be ANSWERED until `question_options` lands (later slice).
const TOPICS: {
  key: string;
  text: string;
  answerType: AnswerType;
  extractionTopic: string;
  core: boolean;
}[] = [
  {
    key: "role",
    text: "Bhai, aap mainly kya kaam karte ho — CNC, VMC, HMC operator, setter ya programmer?",
    answerType: "single_select",
    extractionTopic: "canonical_role_id",
    core: true,
  },
  {
    key: "machines",
    text: "Kaunsi machine pe sabse zyada kaam kiya hai — VMC, CNC lathe, HMC ya grinding?",
    answerType: "multi_select",
    extractionTopic: "machines",
    core: true,
  },
  {
    key: "experience",
    text: "Total kitne saal ka experience hai is line me?",
    answerType: "number",
    extractionTopic: "experience.total_years",
    core: true,
  },
  {
    key: "skills",
    text: "Setting khud karte ho ya sirf operation? Tool offset, program edit ya drawing reading me se kya aata hai?",
    answerType: "multi_select",
    extractionTopic: "skills",
    core: true,
  },
  {
    key: "location",
    text: "Abhi aap kis city me ho, aur kahan kaam karne ke liye ready ho?",
    answerType: "text",
    extractionTopic: "location_preference",
    core: true,
  },
  {
    key: "controllers",
    text: "Controller kaunsa chalaya hai — Fanuc, Siemens, Mitsubishi, Haas ya Heidenhain?",
    answerType: "multi_select",
    extractionTopic: "controllers",
    core: false,
  },
  {
    key: "salary",
    text: "Abhi salary kitni hai aur kitni expect kar rahe ho?",
    answerType: "number",
    extractionTopic: "salary_expectation",
    core: false,
  },
  {
    key: "availability",
    text: "Join karne me kitne din lagenge — abhi free ho ya notice chal raha hai?",
    answerType: "single_select",
    extractionTopic: "availability",
    core: false,
  },
  {
    key: "education",
    text: "ITI ya diploma kiya hai? RVM CAD ya koi aur training li hai?",
    answerType: "text",
    extractionTopic: "education",
    core: false,
  },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[seed:questionnaire] DATABASE_URL is not set");

  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    // 1. profiles (idempotent on slug)
    for (const r of ROLES) {
      await db
        .insert(profiles)
        .values({ slug: r.slug, name: r.name, status: "active" })
        .onConflictDoNothing({ target: profiles.slug });
    }

    // 2. questions (idempotent on question_key)
    for (const t of TOPICS) {
      await db
        .insert(questions)
        .values({
          questionKey: t.key,
          questionText: t.text,
          answerType: t.answerType,
          extractionTopic: t.extractionTopic,
        })
        .onConflictDoNothing({ target: questions.questionKey });
    }

    // 3. resolve ids, then map each profile -> all topics (idempotent on the pair)
    const profileRows = await db.select().from(profiles);
    const questionRows = await db.select().from(questions);
    const profileBySlug = new Map(profileRows.map((p) => [p.slug, p.id]));
    const questionByKey = new Map(questionRows.map((q) => [q.questionKey, q.id]));

    for (const r of ROLES) {
      const profileId = profileBySlug.get(r.slug);
      if (!profileId) throw new Error(`[seed:questionnaire] missing profile ${r.slug}`);
      for (let i = 0; i < TOPICS.length; i++) {
        const t = TOPICS[i]!;
        const questionId = questionByKey.get(t.key);
        if (!questionId) throw new Error(`[seed:questionnaire] missing question ${t.key}`);
        await db
          .insert(profileQuestions)
          .values({ profileId, questionId, displayOrder: i + 1, isRequired: t.core })
          .onConflictDoNothing({
            target: [profileQuestions.profileId, profileQuestions.questionId],
          });
      }
    }

    const [profileCount, questionCount, mappingCount] = await Promise.all([
      db.select().from(profiles),
      db.select().from(questions),
      db.select().from(profileQuestions),
    ]);
    console.log(
      `[seed:questionnaire] done — profiles=${profileCount.length} ` +
        `questions=${questionCount.length} profile_questions=${mappingCount.length}`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[seed:questionnaire] failed:", err);
  process.exit(1);
});
