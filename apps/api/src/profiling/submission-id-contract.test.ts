import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { PostMessageSchema } from "../chat/chat.dto";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { ProfilingAnswerSchema, ProfilingCorrectionSchema } from "./profiling.dto";

/**
 * THE PER-SUBMISSION CLIENT ID AT THE WIRE BOUNDARY (#931).
 *
 * WHAT IS BEING PINNED, and why each half needs its own assertion:
 *
 *  - ABSENT IS LEGAL. An app build that predates the field is the supported rollout case and must
 *    keep working for a long time; rejecting it would 400 every worker still on an old install.
 *  - MALFORMED IS REJECTED. Silently ignoring a bad id — which is what this repo's one shape-checked
 *    header, `x-correlation-id`, does, and what the runbook names as the reason a broken client goes
 *    unnoticed — would leave that client suffering the ORIGINAL defect with nothing anywhere saying
 *    so. §3: fail closed.
 *  - IT DOES NOT LEAK ONTO `POST /correct`. `ProfilingCorrectionSchema` reuses
 *    `ProfilingAnswerSchema.shape.answer` verbatim, so a field added inside that union would appear
 *    on a route that never touches the reply cache. Keeping it top-level is what stops that, and
 *    this is the test that would catch it moving.
 *  - THE KEY MATCHES WHAT THE CLIENT ALREADY SENDS. The worker app shipped `submission_id` in the
 *    BODY of both submission routes; the server was silently stripping it (neither schema declared
 *    it and `ZodValidationPipe` drops unknown keys). A rename on either side is a field that goes
 *    back to being dropped in silence — no exception, no 4xx, and the defect quietly returns.
 */
const REQUEST = { message: "Validation failed" };

const SESSION = "22222222-2222-4222-8222-222222222222";
const VALID_ID = "3f8b2c1a-7d64-4e2f-9a51-0c9d5b7e4a12";

const answerBody = (extra: Record<string, unknown> = {}) => ({
  session_id: SESSION,
  question_key: "q_drawing",
  answer: { kind: "boolean", value: true },
  ...extra,
});

const messageBody = (extra: Record<string, unknown> = {}) => ({
  session_id: SESSION,
  text: "haan",
  ...extra,
});

/** Every value a client can produce that is NOT a submission id, including the tempting ones. */
const MALFORMED = ["", "not-a-uuid", "3f8b2c1a7d644e2f9a510c9d5b7e4a12", 42, true, null, {}];

describe("the submission id is validated, never trusted (#931)", () => {
  it("accepts a body with NO submission id — absent is the supported legacy case", () => {
    // An old app build sends nothing here and must keep interviewing. `undefined` and not `null`
    // on the way out, so the service's `?? null` is what turns it into the explicit "no id" the
    // replay gate reads.
    const answer = ProfilingAnswerSchema.safeParse(answerBody());
    expect(answer.success).toBe(true);
    if (answer.success) expect(answer.data.submission_id).toBeUndefined();

    const message = PostMessageSchema.safeParse(messageBody());
    expect(message.success).toBe(true);
    if (message.success) expect(message.data.submission_id).toBeUndefined();
  });

  it("carries a valid uuid through to the service unchanged", () => {
    const answer = ProfilingAnswerSchema.safeParse(answerBody({ submission_id: VALID_ID }));
    expect(answer.success && answer.data.submission_id).toBe(VALID_ID);

    const message = PostMessageSchema.safeParse(messageBody({ submission_id: VALID_ID }));
    expect(message.success && message.data.submission_id).toBe(VALID_ID);
  });

  it("FAILS CLOSED on a malformed id, through the pipe the routes already run", () => {
    // A 400, not a shrug. The alternative — dropping it and falling back to the hash — hides a
    // broken client behind behaviour that looks healthy right up until a worker's answer vanishes.
    const answerPipe = new ZodValidationPipe(ProfilingAnswerSchema);
    const messagePipe = new ZodValidationPipe(PostMessageSchema);

    for (const bad of MALFORMED) {
      expect(() => answerPipe.transform(answerBody({ submission_id: bad }))).toThrow(
        BadRequestException,
      );
      expect(() => messagePipe.transform(messageBody({ submission_id: bad }))).toThrow(
        BadRequestException,
      );
    }
    // The pipe's own shape, so a future change to it cannot silently turn these into 500s.
    expect(() => answerPipe.transform(answerBody({ submission_id: "nope" }))).toThrow(
      expect.objectContaining({ response: expect.objectContaining(REQUEST) }) as never,
    );
  });

  it("still accepts a valid body through the pipe, so the rejection above is not blanket", () => {
    const pipe = new ZodValidationPipe(ProfilingAnswerSchema);
    expect(pipe.transform(answerBody({ submission_id: VALID_ID })).submission_id).toBe(VALID_ID);
    expect(pipe.transform(answerBody()).submission_id).toBeUndefined();
  });

  it("does NOT appear on the correction route, which never touches the reply cache", () => {
    // `ProfilingCorrectionSchema` shares `answer` with the schema above. If the id were ever moved
    // inside that union it would arrive here too — on a route whose client sends none and whose
    // service calls `correctAnswer`, not `runTurn`.
    expect(Object.keys(ProfilingCorrectionSchema.shape)).not.toContain("submission_id");
    expect(Object.keys(ProfilingAnswerSchema.shape)).toContain("submission_id");
  });
});

/**
 * The Dart side, read from source — the same guard `worker-app-correction-contract.test.ts` puts
 * on `POST /profiling/correct`, for the same failure (#707): a key renamed on either side is
 * dropped in silence rather than rejected, so both suites stay green while the wire is broken.
 *
 * If this breaks because the Dart moved, do not delete it: the contract really did change, and
 * finding out here is the entire point.
 */
const WORKER_APP = join(__dirname, "../../../worker-app/lib");
const VOICE_GATEWAY = readFileSync(
  join(WORKER_APP, "features/voice_form/data/http_voice_form_gateway.dart"),
  "utf8",
);
const API_CLIENT = readFileSync(join(WORKER_APP, "core/api/api_client.dart"), "utf8");

describe("the key the worker app already sends is the key these schemas accept (#931)", () => {
  it("the voice form's answer body names a key `ProfilingAnswerSchema` declares", () => {
    const sent = [...VOICE_GATEWAY.matchAll(/'(submission_id)':/g)].map((m) => m[1]);
    expect(sent.length).toBeGreaterThan(0);
    for (const key of sent) expect(Object.keys(ProfilingAnswerSchema.shape)).toContain(key);
  });

  it("the chat client's message body names a key `PostMessageSchema` declares", () => {
    const sent = [...API_CLIENT.matchAll(/'(submission_id)':/g)].map((m) => m[1]);
    expect(sent.length).toBeGreaterThan(0);
    for (const key of sent) expect(Object.keys(PostMessageSchema.shape)).toContain(key);
  });

  it("it is a BODY field on both, never a header", () => {
    // The ruling this repo has already made twice: `ctx.requestId` is client-settable and
    // per-ATTEMPT, and the only other client-supplied exactly-once token in the codebase
    // (`AdminGrantCreditsSchema.idempotency_key`) is a body field for the same reason. It is also
    // the half the Flutter transport keeps byte-stable: the body is encoded ONCE outside the retry
    // closure, while headers are rebuilt per attempt with a possibly-refreshed bearer.
    expect(API_CLIENT).not.toMatch(/[Xx]-[Ss]ubmission-[Ii]d/);
    expect(VOICE_GATEWAY).not.toMatch(/[Xx]-[Ss]ubmission-[Ii]d/);
  });
});
