import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * #2752 item 13 — EVERY CONSUMER OF `AiService` SAYS HOW A LINKED STUDENT IS KEPT OUT.
 *
 * An actively linked institute student has given RVM's consent only ("share my profile with
 * companies I apply to"), and production sends raw names and phones to the model (ADR-0047). So
 * no AI work may run for him until he accepts BadaBhai's own consent. Each class that injects
 * `AiService` is listed here with the one reason that holds for it:
 *
 *   - `gated`: it calls `InstituteAiGate.assertMayRunAi` itself, before its model call. Required
 *     for every path that can run off the worker's own request: queue jobs, sweeps, ops routes,
 *     admin corrections and the renders they start.
 *   - `consent-guard`: it runs only inside a worker's own request, on routes behind
 *     `ConsentGuard` (see `guard-contract.test.ts`), which fails closed for a worker with no
 *     consent row. That is the state a linked student is in until his own sign-in.
 *   - `no-worker`: no worker's data crosses (a company's posting text, a health probe).
 *
 * A new consumer fails this test until it is listed, so a new AI path cannot reach a student
 * without someone deciding which of the three it is. A `gated` entry also fails if its gate call
 * is removed.
 */
const SRC = join(__dirname, "..");

type Cover =
  | { readonly kind: "gated" }
  | { readonly kind: "consent-guard"; readonly why: string }
  | { readonly kind: "no-worker"; readonly why: string };

const COMPANION_TURN =
  "the companion turn (ChatCompanionController: ConsentGuard, WorkerAuthGuard)";
const INTERVIEW_TURN =
  "the profiling and chat turns (ProfilingController, ChatController: ConsentGuard, " +
  "WorkerAuthGuard)";

const CONSUMERS: Readonly<Record<string, Cover>> = {
  // Off the request: the extraction queue, the chat-abandonment sweep, correction rebuilds.
  "profiles/profile-extraction.processor.ts": { kind: "gated" },
  // Off the request: the generate queue, the ops regenerate, admin corrections.
  "resume/resume.service.ts": { kind: "gated" },
  // Inside the résumé render, which ops name changes and admin corrections also start.
  "resume/work-history-polish.service.ts": { kind: "gated" },
  "profiling/other-answer-polish.service.ts": { kind: "gated" },
  // The voice queue retries off the request.
  "voice/voice-transcription.service.ts": { kind: "gated" },
  // The import queue and the import sweep run off the request.
  "profiling/resume-import/resume-parse.service.ts": { kind: "gated" },
  "profiling/resume-import/resume-summary.service.ts": { kind: "gated" },
  "profiling/resume-import/resume-option-map.service.ts": { kind: "gated" },

  "chat-companion/v2/companion-edit.service.ts": { kind: "consent-guard", why: COMPANION_TURN },
  "chat-companion/v2/companion-summary.service.ts": { kind: "consent-guard", why: COMPANION_TURN },
  "chat-companion/v2/companion-v2.orchestrator.ts": { kind: "consent-guard", why: COMPANION_TURN },
  "chat-companion/v2/handlers/career-talk.handler.ts": {
    kind: "consent-guard",
    why: COMPANION_TURN,
  },
  "profiling/free-chat/free-chat-model-calls.ts": { kind: "consent-guard", why: INTERVIEW_TURN },
  "profiling/free-chat/free-chat-summary.service.ts": {
    kind: "consent-guard",
    why: INTERVIEW_TURN,
  },
  "profiling/free-chat/free-chat.service.ts": { kind: "consent-guard", why: INTERVIEW_TURN },
  "profiling/identify.service.ts": { kind: "consent-guard", why: INTERVIEW_TURN },
  "profiling/llm-turn.service.ts": { kind: "consent-guard", why: INTERVIEW_TURN },
  "profiling/skills-turn.service.ts": { kind: "consent-guard", why: INTERVIEW_TURN },
  "profiling/understanding/turn-understanding.service.ts": {
    kind: "consent-guard",
    why: INTERVIEW_TURN,
  },

  "health/health.service.ts": { kind: "no-worker", why: "the AI service health probe" },
  "job-postings/job-postings.service.ts": {
    kind: "no-worker",
    why: "a company's posting text (skill phrases)",
  },
  "payer-portal/job-posting-chat/job-posting-chat.service.ts": {
    kind: "no-worker",
    why: "a company's posting chat",
  },
};

/** A constructor or function parameter typed `AiService` (never `AiServiceError` and the like). */
const INJECTS_AI = /\b\w+\??\s*:\s*AiService\s*[,)]/;
const GATE_CALL = "instituteAi.assertMayRunAi(";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    const name = entry.name;
    const isSource =
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".test-support.ts") &&
      !name.endsWith(".fake.ts");
    return isSource ? [path] : [];
  });
}

const relativePath = (path: string) => relative(SRC, path).split(sep).join("/");

describe("#2752 item 13 — every AiService consumer is covered for a linked student", () => {
  const consumers = sourceFiles(SRC)
    .filter((path) => relativePath(path) !== "ai/ai.service.ts")
    .filter((path) => INJECTS_AI.test(readFileSync(path, "utf8")))
    .map(relativePath)
    .sort();

  it("finds the consumers (the scan itself works)", () => {
    expect(consumers.length).toBeGreaterThanOrEqual(20);
  });

  it("lists every consumer, and nothing that is no longer one", () => {
    expect(consumers).toEqual(Object.keys(CONSUMERS).sort());
  });

  for (const [file, cover] of Object.entries(CONSUMERS)) {
    if (cover.kind !== "gated") continue;
    it(`${file} asks InstituteAiGate before its model call`, () => {
      const src = readFileSync(join(SRC, file), "utf8");
      expect(src).toContain("InstituteAiGate");
      expect(src).toContain(GATE_CALL);
    });
  }
});
