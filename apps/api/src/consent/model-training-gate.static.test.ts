import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * #2753 item 13 — EVERY FILE THAT READS WORKER TEXT OR LABELS TO IMPROVE A MODEL ASKS THE GATE.
 *
 * `modelTrainingAllowed` (`model-training-gate.ts`) is the one rule for using a worker's chats,
 * answers or behaviour labels to train, tune or evaluate a model: only with his live
 * `model_training` consent (ADR-0018 D1). This file finds every source under `apps/api/src` that
 * names a table holding a worker's words, answers or labels AND whose path says it is for a learn,
 * export, corpus, dataset, eval, label, sample or probe purpose. Each must be listed below:
 *
 *   - `gated`: it calls `modelTrainingAllowed(` itself;
 *   - `gated-by`: its only use is through a file that calls it (a repository behind its service);
 *   - `exempt`: a recorded ruling says this use is not model improvement, with the reason.
 *
 * A new file fails until it is listed, so a new export or eval job cannot read real workers'
 * text without someone deciding which of the three it is. A `gated` or `gated-by` entry also
 * fails if the gate call is removed. The ai-service's offline corpus (`apps/ai-service/app/corpus`)
 * reads no database and carries its own copy of the rule (`consent_gate.py`).
 */
const SRC = join(__dirname, "..");

type Cover =
  | { readonly kind: "gated" }
  | { readonly kind: "gated-by"; readonly by: string }
  | { readonly kind: "exempt"; readonly why: string };

const R36 =
  "ADR-0051 §10 R36 (owner ruling 2026-10-08): the free-chat probe's --sample is a quality " +
  "review of the profiling chat, under the `profiling` purpose (it checks `hasActiveConsent(…, " +
  "'profiling')` and no pending deletion); `model_training` is not required. Reversing that is " +
  "the owner's call, and a one-line change in `isSampleEligible`.";

const USES: Readonly<Record<string, Cover>> = {
  // The LEARN label producer: the service asks the gate once per batch before the repository
  // writes anything.
  "learn/learn-labels.repository.ts": { kind: "gated-by", by: "learn/learn-labels.service.ts" },
  "profiling/free-chat/free-chat-probe.repository.ts": { kind: "exempt", why: R36 },
  "profiling/free-chat/free-chat-probe.report.ts": { kind: "exempt", why: R36 },
};

/** Tables (drizzle name or SQL name) that hold a worker's words, answers or behaviour labels. */
const WORKER_TEXT_TABLES = new RegExp(
  "\\b(" +
    [
      "chatMessages|chat_messages",
      "voiceNotes|voice_notes",
      "companionMessages|companion_messages",
      "companionConversationSummaries|companion_conversation_summaries",
      "workerAnswers|worker_answers",
      "workerPackAnswers|worker_pack_answers",
      "profilingVoiceAnswers|profiling_voice_answers",
      "workerAttributes|worker_attributes",
      "workerResumeImports|worker_resume_imports",
      "workerFeedback|worker_feedback",
      "aiCallTraces|ai_call_traces",
      "learnLabels|learn_labels",
    ].join("|") +
    ")\\b",
);

/** A path segment or file-name word that says the file is for improving a model. */
const IMPROVEMENT_WORDS = new Set([
  "learn",
  "export",
  "exports",
  "corpus",
  "finetune",
  "dataset",
  "datasets",
  "eval",
  "evals",
  "label",
  "labels",
  "sample",
  "samples",
  "probe",
]);

const GATE_CALL = "modelTrainingAllowed(";

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

/** Code only: a comment that names a table is not a read of it. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const relativePath = (path: string) => relative(SRC, path).split(sep).join("/");
const words = (rel: string) =>
  rel
    .replace(/\.ts$/, "")
    .split(/[/._-]+/)
    .map((w) => w.toLowerCase());

describe("#2753 item 13 — every model-improvement use of worker text asks the gate", () => {
  // Read once, at collection: the tests below only filter it.
  const sources = sourceFiles(SRC).map((path) => ({ rel: relativePath(path), src: code(path) }));
  const found = sources
    .filter(({ rel }) => words(rel).some((w) => IMPROVEMENT_WORDS.has(w)))
    .filter(({ src }) => WORKER_TEXT_TABLES.test(src))
    .map(({ rel }) => rel)
    .sort();

  it("finds the uses (the scan itself works)", () => {
    expect(found).toContain("learn/learn-labels.repository.ts");
  });

  it("lists every use, and nothing that is no longer one", () => {
    expect(found).toEqual(Object.keys(USES).sort());
  });

  for (const [file, cover] of Object.entries(USES)) {
    if (cover.kind === "exempt") continue;
    const gate = cover.kind === "gated" ? file : cover.by;
    it(`${file} is gated: ${gate} calls modelTrainingAllowed`, () => {
      expect(code(join(SRC, gate))).toContain(GATE_CALL);
    });
  }

  it("the gate lives in one place", () => {
    const definitions = sources
      .filter(({ src }) => /export (async )?function modelTrainingAllowed\b/.test(src))
      .map(({ rel }) => rel);
    expect(definitions).toEqual(["consent/model-training-gate.ts"]);
  });
});
