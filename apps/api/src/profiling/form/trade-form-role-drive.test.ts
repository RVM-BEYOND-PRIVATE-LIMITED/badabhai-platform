import "reflect-metadata";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  QuestionPackSchema,
  type AnswerType,
  type QuestionPack,
  type QuestionPackItem,
  type QuestionPackOption,
} from "@badabhai/ai-contracts";
import type { NewWorkerPackAnswer, WorkerPackAnswer } from "@badabhai/db";

import { TRADE_RESUME_MAPS } from "../../resume/trade-resume-map";
import { computeContentHash } from "../pack-cache.constants";
import { descriptorForPack, ENABLED_ROLE_DESCRIPTORS } from "../roles/role-registry";
import { familyForTradeForm, TRADE_FORM_KINDS, type TradeFormKind } from "../trade-form-router";
import { answerMapFromRows, isFormQuestionVisible } from "./form-eligibility";
import {
  TradeFormAnswerSchema,
  TradeFormSchemaResponse,
  type TradeFormAnswerDto,
  type TradeFormAnswerResponse,
} from "./trade-form.dto";
import { TradeFormService } from "./trade-form.service";

/**
 * ═══ EVERY SHIPPED ROLE, DRIVEN THROUGH ITS OWN FORM FROM FIRST FETCH TO LAST ANSWER ═══
 *
 * WHAT WAS NOT COVERED BEFORE THIS FILE. `trade-form.service.test.ts` is a good unit suite and it
 * drives ONE hand-built pack: six items, no tier gate, and every option's `value` a string. Four
 * of the five shipped roles had never been driven by anything at all, and the fifth had never been
 * driven through its REAL pack. That gap is not academic — the properties this form turns on are
 * properties of the pack DATA (a numeric tier gate, an `ask_if` band, a sheet-ordered capability
 * list), and a fixture that carries none of them cannot report on any of them.
 *
 * SO EVERY PACK HERE IS THE SHIPPED ONE, read out of `packages/db/data/question-packs/packs` and
 * put through `QuestionPackSchema` exactly as `pack-registry.service.ts` would after a seed. A
 * fixture would be a second copy of the corpus, free to drift from it in precisely the direction
 * that hides a defect.
 *
 * WHAT IT ASSERTS, and each is a defect that is silent in production:
 *
 *   1. THE FORM IS WALKABLE. Every screen the client is handed can be answered with an option
 *      taken from the pack itself, and answering them all reaches the end. A select with no
 *      tappable chip, or a gate that can never open, is a DEAD END: the worker sits on a screen
 *      with nothing to press and the funnel records an abandonment.
 *   2. THE TIER GATE DECIDES THE TIER, BOTH WAYS. A fresher is served the fresher block and none
 *      of the depth; a senior is served the depth and none of the fresher block (#1378). This is
 *      the #776 shape and it fails SILENTLY in the direction that looks like success — an
 *      unresolvable gate shows every question, which reads as "the form works".
 *   3. `answered` NEVER EXCEEDS `total`. A progress rail that reads 12/11 is a rail the worker
 *      cannot finish.
 *   4. `qp_draughting` IS A ROUTER, NOT A ROLE. It must never acquire a form.
 *
 * READS ONLY. Nothing here touches a database; the two repositories are in-memory doubles that
 * store exactly the columns `answerMapFromRows` and `questionScreen` read back.
 */

// Anchored to this file rather than `process.cwd()`, like `role-corpus-parity.guard.test.ts`.
const PACK_DIR = join(__dirname, "../../../../../packages/db/data/question-packs/packs");

const WORKER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";

/**
 * The `answer_type`s that get a REAL widget on the phone.
 *
 * THIS USED TO READ `= ANSWER_TYPES`, which made every assertion against it a tautology: the
 * schema is parsed by `z.enum(ANSWER_TYPES)` before this is consulted, so checking membership of
 * the same array cannot fail for any input, ever. It read as coverage and was decoration.
 *
 * The literal below is the contract's five, spelled out. Restating them is the entire point: the
 * value of this constant is that it does NOT follow `ANSWER_TYPES`, so adding a sixth member to
 * the contract makes these assertions fail instead of silently widening with it. A sixth type
 * with no case in `trade_form_repository_impl.dart:_kind` renders as a plain text box on a phone
 * and passes every server test — this is where that shows up.
 *
 * WHAT IT IS NOT GUARDING, checked rather than assumed. The Dart switch ends in
 * `default: return VoiceQuestionKind.open`, so nothing is literally unmapped; and the database's
 * `qpi_answer_type_chk` additionally permits `city`, `salary` and `duration`, which
 * `qp_universal@2` really does use. Those are NOT a live degradation: `pack-registry`'s
 * `ANSWER_TYPE_ALIASES` folds them to `text`/`number` on the way out of the database, so what a
 * form ever sees is one of the five below. Verified, not inferred — `QuestionPackSchema` rejects
 * the raw pack and accepts the aliased one.
 */
const RENDERABLE_ANSWER_TYPES: readonly AnswerType[] = [
  "boolean",
  "single_select",
  "multi_select",
  "text",
  "number",
];

// ── the shipped corpus, loaded the way the registry loads it ────────────────────────────────

interface CorpusOption {
  readonly option_key: string;
  readonly label_text: string;
  readonly value_text?: string;
  readonly value_number?: number;
  readonly value_bool?: boolean;
}

interface CorpusItem {
  readonly question_key: string;
  readonly options?: readonly CorpusOption[];
}

interface CorpusPack {
  readonly pack_id: string;
  readonly family_id: string;
  readonly items: readonly CorpusItem[];
}

/**
 * A corpus file → the `QuestionPack` a live request would hold.
 *
 * THE ROUND TRIP IS THE POINT, and it is reproduced rather than approximated. `seed-question-packs`
 * writes an option's three typed columns; `pack-registry.service.toOption` reads ONE contract field
 * back out of them as `valueText ?? valueNumber ?? valueBool`. That collapse is where a tier gate's
 * integer becomes the `value` this service later has to recognise as a number, so a loader that
 * carried `value_number` straight through under its own name would test a shape production never
 * sees. `display_order` is the item's index within its pack, as the seeder assigns it.
 */
function packFromCorpus(packId: string): QuestionPack {
  const raw = JSON.parse(readFileSync(join(PACK_DIR, `${packId}.json`), "utf8")) as CorpusPack;
  const items = raw.items.map((item, index) => ({
    ...item,
    display_order: index,
    options: (item.options ?? []).map((option) => ({
      ...option,
      // `??`, never a truthiness chain: `value_number: 0` is the fresher rung on every one of
      // these ladders and `value_bool: false` is a real answer.
      value: option.value_text ?? option.value_number ?? option.value_bool ?? null,
    })),
  }));
  // Derived, exactly as `load()` derives it — the column is nullable and nothing writes it.
  return QuestionPackSchema.parse({ ...raw, content_hash: computeContentHash(items), items });
}

interface RoleUnderTest {
  readonly kind: TradeFormKind;
  readonly packId: string;
  readonly familyId: string;
  /** The descriptor's `tenureQuestionKey` — the gate `orderBySheet` hoists to the front. */
  readonly gateKey: string;
  readonly pack: QuestionPack;
}

/**
 * DERIVED FROM THE REGISTRY, so role twenty-one is covered by the commit that enables it rather
 * than by the commit that remembers this file exists.
 */
const ROLES: readonly RoleUnderTest[] = ENABLED_ROLE_DESCRIPTORS.map((descriptor) => ({
  kind: descriptor.kind,
  packId: descriptor.packId,
  familyId: descriptor.familyId,
  gateKey: descriptor.tenureQuestionKey,
  pack: packFromCorpus(descriptor.packId),
}));

const CASES = ROLES.map((role) => [role.kind, role] as const);

// ── the harness ────────────────────────────────────────────────────────────────────────────

interface AttributeUpsert {
  readonly attributeKey: string;
  readonly valueKind: string;
  readonly valueText: string | null;
  readonly valueNumber: string | null;
  readonly valueTextList: string[] | null;
}

interface EmittedEvent {
  readonly event_name: string;
  readonly payload: Record<string, unknown>;
}

interface Harness {
  readonly service: TradeFormService;
  /** What `worker_pack_answer` now holds, keyed as the table's unique key keys it. */
  readonly rows: Map<string, WorkerPackAnswer>;
  readonly attributes: AttributeUpsert[];
  readonly events: EmittedEvent[];
}

/**
 * A service wired to in-memory doubles that REALLY STORE, which is what makes a walk a walk.
 *
 * `listAnswers` returning a fixed array — the shape the existing unit suite uses — would make
 * every `schema()` call return the first form again, so no gate could ever narrow anything and
 * the whole tier question would be untestable. Here an answer written by `answer()` is visible to
 * the next `schema()`, exactly as Postgres would make it.
 */
function harnessFor(role: RoleUnderTest): Harness {
  const rows = new Map<string, WorkerPackAnswer>();
  const attributes: AttributeUpsert[] = [];
  const events: EmittedEvent[] = [];

  const chat = {
    findLatestSessionByWorker: vi.fn(async () => ({
      id: SESSION,
      conversationState: { form_kind: role.kind },
    })),
  };
  const packs = {
    // Keyed on the family, like the real lookup: a descriptor whose `familyId` disagreed with its
    // `packId` would resolve to nothing here rather than silently to somebody else's questions.
    loadForFamily: vi.fn(async (familyId: string) =>
      familyId === role.familyId ? role.pack : null,
    ),
  };
  const answers = {
    listAnswers: vi.fn(async () => [...rows.values()]),
    upsertAnswer: vi.fn(async (row: NewWorkerPackAnswer) => {
      // Only the columns the readers read. `answerMapFromRows` and `questionScreen` between them
      // touch exactly these six, and storing more would invent a fidelity this double does not
      // have.
      rows.set(row.questionKey, {
        questionKey: row.questionKey,
        status: row.status,
        answerText: row.answerText ?? null,
        answerNumber: row.answerNumber ?? null,
        answerBool: row.answerBool ?? null,
        answerOptionKeys: row.answerOptionKeys ?? null,
      } as WorkerPackAnswer);
    }),
  };
  const attributeRepo = {
    upsertMany: vi.fn(async (incoming: AttributeUpsert[]) => {
      attributes.push(...incoming);
      return incoming.length;
    }),
  };
  const eventsService = {
    emit: vi.fn(async (params: EmittedEvent) => {
      events.push(params);
      return {};
    }),
  };

  const service = new TradeFormService(
    chat as never,
    packs as never,
    answers as never,
    attributeRepo as never,
    eventsService as never,
    // M1 — see the note in trade-form.service.test.ts. Present so the constructor arity
    // matches; this suite asserts routing, not the rebuild.
    { rebuildQuietly: vi.fn(async () => undefined) } as never,
  );
  return { service, rows, attributes, events };
}

// ── walking the form ───────────────────────────────────────────────────────────────────────

type Screen = TradeFormSchemaResponse["sections"][number]["screens"][number];
type QuestionScreen = Extract<Screen, { type: "question" }>;

function questionScreensOf(schema: TradeFormSchemaResponse): QuestionScreen[] {
  return schema.sections.flatMap((section) =>
    section.screens.filter((screen): screen is QuestionScreen => screen.type === "question"),
  );
}

/** The two ends of a role's own experience ladder. Never a literal: each pack authors its own. */
type Tier = "fresher" | "experienced";

/**
 * The rung of the tier gate a walk is driven at, read off the gate's own options.
 *
 * THE LADDER IS THE PACK'S, NOT THIS FILE'S. `qp_cad_drafting` has five rungs and a fresher BAND
 * of two (`lte 1`) because "fresher" is a status a student states; the other four have four rungs
 * and a band of one (`lte 0`). Hard-coding either shape here would make this file wrong for the
 * next role rather than merely unhelpful.
 */
function gateRung(gate: QuestionPackItem, tier: Tier): QuestionPackOption {
  const numeric = gate.options.filter((option) => typeof option.value === "number");
  const sorted = [...numeric].sort((a, b) => (a.value as number) - (b.value as number));
  const rung = tier === "fresher" ? sorted.at(0) : sorted.at(-1);
  if (!rung) {
    // A GATE NOBODY CAN OPEN. Reported loudly rather than skipped: an `ask_if` reading a field
    // that no option can ever give a number to is the #776 defect at its source.
    throw new Error(`${gate.question_key}: the tier gate offers no numeric rung — a dead gate`);
  }
  return rung;
}

/**
 * One valid answer, taken from the question's own options.
 *
 * NEVER AN INVENTED VALUE. The point of the walk is that a worker with only the chips in front of
 * them can finish, so anything this function has to make up would be a screen a real worker
 * cannot get past. A select with no tappable chip therefore throws here by name.
 */
function answerFor(item: QuestionPackItem, role: RoleUnderTest, tier: Tier): TradeFormAnswerDto {
  const key = item.question_key;
  if (key === role.gateKey) {
    return {
      question_key: key,
      answer: { kind: "chips", option_keys: [gateRung(item, tier).option_key] },
    };
  }
  switch (item.answer_type) {
    case "single_select":
    case "multi_select": {
      // "None of the above" is a real answer but a degenerate one — it settles the question and
      // stores `unknown`, which no dictionary renders. A walk that tapped it everywhere would
      // prove only that the form accepts abstentions.
      const usable = item.options.filter((option) => !option.is_none_of_above);
      const pool = usable.length > 0 ? usable : item.options;
      if (pool.length === 0) {
        throw new Error(
          `DEAD END ${role.packId}.${key}: a ${item.answer_type} with no chip a worker can tap`,
        );
      }
      const first = pool[0]!;
      return {
        question_key: key,
        answer: {
          kind: "chips",
          option_keys:
            item.answer_type === "single_select"
              ? [first.option_key]
              : pool.map((option) => option.option_key),
        },
      };
    }
    case "boolean":
      return { question_key: key, answer: { kind: "boolean", value: true } };
    case "number":
      // The client sends what the worker TYPED; `recordFor` owns the coercion.
      return { question_key: key, answer: { kind: "text", text: "5" } };
    case "text":
      return { question_key: key, answer: { kind: "text", text: "Shop floor par kaam kiya hai" } };
    default:
      throw new Error(`${role.packId}.${key}: unrenderable answer_type ${item.answer_type}`);
  }
}

interface WalkResult {
  readonly responses: readonly TradeFormAnswerResponse[];
  /** Every question key served on the FIRST fetch, before any gate had an answer to narrow it. */
  readonly firstFetch: readonly string[];
  readonly rounds: number;
}

/**
 * Fetch, answer, refetch when told the schema is stale — the loop a real client runs.
 *
 * WHY IT REFETCHES ON `schema_stale` RATHER THAN ANSWERING THE WHOLE LIST BLIND. The form is one
 * round trip by design, so answering a gate invalidates a list the client is already holding.
 * That flag is the server's only way to say so, and a walk that ignored it would never exercise
 * the narrowing this file exists to check.
 */
async function driveWholeForm(
  harness: Harness,
  role: RoleUnderTest,
  tier: Tier,
): Promise<WalkResult> {
  const byKey = new Map(role.pack.items.map((item) => [item.question_key, item]));
  const responses: TradeFormAnswerResponse[] = [];
  let firstFetch: string[] = [];
  // One round per gate answer plus a settling round. A form that needs more than this is looping.
  const maxRounds = role.pack.items.length + 2;

  for (let round = 0; round < maxRounds; round += 1) {
    const schema = await harness.service.schema(WORKER);
    const parsed = TradeFormSchemaResponse.safeParse(schema);
    expect(parsed.success, `${role.kind}: served a schema the client's contract rejects`).toBe(
      true,
    );
    const served = questionScreensOf(schema);
    if (round === 0) firstFetch = served.map((screen) => screen.question.question_key);

    const pending = served.filter((screen) => screen.answer === null);
    if (pending.length === 0) return { responses, firstFetch, rounds: round + 1 };

    for (const screen of pending) {
      const item = byKey.get(screen.question.question_key);
      expect(
        item,
        `${role.kind}: served ${screen.question.question_key}, absent from its pack`,
      ).toBeDefined();
      const dto = TradeFormAnswerSchema.parse(answerFor(item!, role, tier));
      const response = await harness.service.answer(WORKER, dto);
      responses.push(response);
      // The list this loop is iterating is now out of date. Refetch rather than carry on.
      if (response.schema_stale) break;
    }
  }
  throw new Error(`${role.kind}: the form never reached its end in ${maxRounds} rounds`);
}

/** Answer nothing but the tier gate, so the next fetch shows the gate's effect and only that. */
async function answerGateOnly(
  harness: Harness,
  role: RoleUnderTest,
  tier: Tier,
): Promise<TradeFormAnswerResponse> {
  const gate = role.pack.items.find((item) => item.question_key === role.gateKey);
  expect(
    gate,
    `${role.kind}: tenureQuestionKey ${role.gateKey} is not in ${role.packId}`,
  ).toBeDefined();
  return harness.service.answer(WORKER, TradeFormAnswerSchema.parse(answerFor(gate!, role, tier)));
}

/**
 * The questions this pack would serve if the gate's answer were stored as the interview stores it.
 *
 * BUILT OUT OF PRODUCTION CODE ON BOTH SIDES, deliberately. `answerMapFromRows` and
 * `isFormQuestionVisible` are the same two functions `schema()` runs; the only thing this supplies
 * is the ROW — `answer_number`, which is what `answer-capture.matchOptions` + `typedAnswerColumns`
 * write when a worker taps that same chip in an interview. So the expectation is not a
 * re-implementation of the gate rules; it is "the form must serve what the interview's own storage
 * would make it serve", which is the property the service's own comments claim.
 */
function visibleIfGateStoredAsNumber(role: RoleUnderTest, tier: Tier): string[] {
  const gate = role.pack.items.find((item) => item.question_key === role.gateKey)!;
  const row = {
    questionKey: role.gateKey,
    status: "answered",
    answerNumber: gateRung(gate, tier).value as number,
    answerText: null,
    answerBool: null,
    answerOptionKeys: null,
  } as WorkerPackAnswer;
  const answers = answerMapFromRows([row]);
  return role.pack.items
    .filter((item) => isFormQuestionVisible(item, answers))
    .map((item) => item.question_key);
}

/** Every key gated on the tenure question by an `ask_if`, split by which way the band runs. */
function gatedKeys(role: RoleUnderTest): { fresherOnly: string[]; depthOnly: string[] } {
  const fresherOnly: string[] = [];
  const depthOnly: string[] = [];
  for (const item of role.pack.items) {
    const gate = item.ask_if;
    if (!gate || gate.left?.field !== role.gateKey) continue;
    // `gte` and `lte` are the only ordering operators `PREDICATE_OPS` defines — `form-eligibility`
    // also guards `gt`/`lt`, which the contract cannot express.
    if (gate.op === "lte") fresherOnly.push(item.question_key);
    if (gate.op === "gte") depthOnly.push(item.question_key);
  }
  return { fresherOnly, depthOnly };
}

// ── the suite ──────────────────────────────────────────────────────────────────────────────

describe("every shipped trade form, driven end to end", () => {
  it("covers at least one role, so every parametrised case below is evidence", () => {
    // `it.each` over an empty table passes silently and reports nothing.
    expect(ROLES.length).toBeGreaterThan(0);
    expect(ROLES.map((role) => role.packId)).toEqual(
      ENABLED_ROLE_DESCRIPTORS.map((descriptor) => descriptor.packId),
    );
  });

  describe("the schema the client is handed", () => {
    it.each(CASES)(
      "%s — every section and screen is well formed and none is empty",
      async (_kind, role) => {
        const harness = harnessFor(role);
        const schema = await harness.service.schema(WORKER);

        expect(() => TradeFormSchemaResponse.parse(schema)).not.toThrow();
        expect(schema).toMatchObject({ pack_id: role.packId, pack_version: role.pack.version });
        expect(schema.sections.map((section) => section.id)).toEqual([
          "capability",
          "terms",
          "work_history",
          "qualifications",
        ]);

        for (const section of schema.sections) {
          expect(
            section.title.trim().length,
            `${role.kind}: section ${section.id} is headless`,
          ).toBeGreaterThan(0);
          // §11 rule 1 applied to the form: a heading with nothing under it is a screen the worker
          // scrolls past wondering what they were meant to do.
          expect(
            section.screens.length,
            `${role.kind}: section ${section.id} has no screens`,
          ).toBeGreaterThan(0);
        }

        for (const screen of questionScreensOf(schema)) {
          const question = screen.question;
          const where = `${role.packId}.${question.question_key}`;
          expect(question.prompt_text.trim().length, `${where}: an empty prompt`).toBeGreaterThan(
            0,
          );
          expect(
            RENDERABLE_ANSWER_TYPES,
            `${where}: answer_type the client cannot render`,
          ).toContain(question.answer_type);

          const isSelect =
            question.answer_type === "single_select" || question.answer_type === "multi_select";
          if (isSelect) {
            expect(question.options.length, `${where}: a select with no chips`).toBeGreaterThan(0);
            expect(
              new Set(question.options.map((option) => option.option_key)).size,
              `${where}: two chips share an option_key, so one can never be selected`,
            ).toBe(question.options.length);
            for (const option of question.options) {
              expect(
                option.label_text.trim().length,
                `${where}: a chip with no label`,
              ).toBeGreaterThan(0);
            }
            expect(
              question.options.some((option) => !option.is_none_of_above),
              `${where}: every chip is none-of-above, so the question can only be abstained from`,
            ).toBe(true);
          } else {
            // The client maps `text`/`number` to an open field and never draws chips there, so
            // options on one of those questions are content that silently does not exist.
            expect(
              question.options,
              `${where}: options on an open-answer question never render`,
            ).toEqual([]);
          }
        }
      },
    );

    it.each(CASES)(
      "%s — the capability zone leads with every MANDATORY item, then the sheet's rows",
      async (_kind, role) => {
        const harness = harnessFor(role);
        const schema = await harness.service.schema(WORKER);
        const capability = schema.sections.find((section) => section.id === "capability");
        const asked = (capability?.screens ?? []).map((screen) =>
          screen.type === "question" ? screen.question.question_key : screen.type,
        );

        // READ OFF THE SHIPPED MAP rather than restated, so this tracks a redlined sheet.
        const map = TRADE_RESUME_MAPS.find((candidate) => candidate.pack_id === role.packId);
        expect(map, `${role.kind}: no résumé map for ${role.packId}`).toBeDefined();
        const packKeys = new Set(role.pack.items.map((item) => item.question_key));
        // EVERY mandatory item leads, in the PACK's order — not just the tier gate. Four of the
        // five packs have exactly one mandatory item and it IS the gate, so for them this is the
        // same list it always was; `qp_cam_programming` has two.
        const leads = role.pack.items
          .filter((item) => item.is_mandatory || item.question_key === role.gateKey)
          .map((item) => item.question_key);
        const expected = [
          ...leads,
          ...(map?.capability ?? [])
            .map((row) => row.from)
            .filter((from) => !leads.includes(from) && packKeys.has(from)),
        ];

        // A gate asked after the questions it gates is not a gate (#1377).
        expect(asked).toEqual(expected);
        expect(asked.length, `${role.kind}: an empty capability zone`).toBeGreaterThan(1);
      },
    );

    it("cam_programmer asks the CAM-vs-MDI split FIRST, before the tier gate", async () => {
      // SPELLED OUT RATHER THAN DERIVED. The assertion above builds its expectation from the same
      // `is_mandatory` flags production now reads, so it would follow the code anywhere — it
      // proves the ordering rule is applied, not that the rule is right. This one names the
      // outcome the pack's `_first_question` note argues for, so it fails if either the pack or
      // the ordering changes: `programming_mode` decides whether every later answer describes
      // desk CAM work or manual data input at the machine, which is why an unanswered split is
      // a fail-closed condition. It was served ELEVENTH, under the qualifications heading.
      const role = CASES.find(([kind]) => kind === "cam_programmer")?.[1];
      expect(role, "cam_programmer is not in CASES").toBeDefined();
      const schema = await harnessFor(role!).service.schema(WORKER);
      const asked = (
        schema.sections.find((section) => section.id === "capability")?.screens ?? []
      ).map((screen) => (screen.type === "question" ? screen.question.question_key : screen.type));

      expect(asked.slice(0, 2)).toEqual(["programming_mode", "programming_experience"]);
      // And it is in the capability zone at all — the defect served it in `qualifications`,
      // behind the terms and work-history markers.
      const qualifications =
        schema.sections.find((section) => section.id === "qualifications")?.screens ?? [];
      expect(
        qualifications.some(
          (screen) =>
            screen.type === "question" && screen.question.question_key === "programming_mode",
        ),
        "programming_mode is buried in the qualifications zone again",
      ).toBe(false);
    });

    it.each(CASES)(
      "%s — no MANDATORY question is buried past the terms and work-history zones",
      async (_kind, role) => {
        // `orderBySheet` hoists exactly ONE item — the descriptor's `tenureQuestionKey` — and files
        // everything the résumé map has no row for into the qualifications zone, behind the terms
        // and work-history markers. `is_mandatory` is not consulted at all.
        //
        // THE ROLE THAT BREAKS ON THIS IS CAM, and its pack argues the case itself. `_first_question`
        // records an owner ruling: `programming_mode` "is is_core AND is_mandatory and sits at
        // display_order 0, so selectItem serves it before the tier gate ... the CAM-versus-MDI split
        // decides how every later answer should be read, so an unanswered split is a fail-closed
        // condition". The interview honours that. The form asks it LAST, under the heading
        // "Qualification, documents & languages", after all ten capability questions whose reading
        // it was supposed to decide.
        const harness = harnessFor(role);
        const schema = await harness.service.schema(WORKER);
        const capabilityKeys = new Set(
          (schema.sections.find((section) => section.id === "capability")?.screens ?? []).flatMap(
            (screen) => (screen.type === "question" ? [screen.question.question_key] : []),
          ),
        );
        const mandatory = role.pack.items
          .filter((item) => item.is_mandatory)
          .map((item) => item.question_key);

        expect(mandatory.length, `${role.kind}: no mandatory item to check`).toBeGreaterThan(0);
        for (const key of mandatory) {
          expect(
            capabilityKeys.has(key),
            `${role.kind}: ${key} is is_mandatory but is served in the qualifications zone, ` +
              `behind the terms and work-history markers`,
          ).toBe(true);
        }
      },
    );

    it.each(CASES)(
      "%s — the credentials marker closes the qualifications zone",
      async (_kind, role) => {
        const harness = harnessFor(role);
        const schema = await harness.service.schema(WORKER);
        const quals = schema.sections.find((section) => section.id === "qualifications");
        expect(quals?.screens.at(-1)).toMatchObject({
          type: "qualifications",
          endpoint: "PUT /workers/me/qualifications",
        });
      },
    );
  });

  describe("walking the whole form", () => {
    it.each(CASES)(
      "%s — a FRESHER can answer every question served and reach the end",
      async (_kind, role) => {
        const harness = harnessFor(role);
        const walk = await driveWholeForm(harness, role, "fresher");

        // Nothing left unanswered on the final fetch — `driveWholeForm` only returns on that.
        expect(walk.responses.length, `${role.kind}: the walk answered nothing`).toBeGreaterThan(0);
        for (const response of walk.responses) {
          expect(
            response.answered,
            `${role.kind}.${response.question_key}: ${response.answered}/${response.total} — the ` +
              `progress rail exceeded its own denominator`,
          ).toBeLessThanOrEqual(response.total);
        }

        // The other end of the funnel `profile.form_mode_entered` opens, emitted once.
        const completions = harness.events.filter(
          (event) => event.event_name === "profile.form_completed",
        );
        expect(completions.length, `${role.kind}: a completed form emitted no completion`).toBe(1);
        expect(completions[0]?.payload).toMatchObject({
          form_kind: role.kind,
          pack_id: role.packId,
        });
      },
    );

    it.each(CASES)(
      "%s — an EXPERIENCED worker can answer every question served and reach the end",
      async (_kind, role) => {
        const harness = harnessFor(role);
        const walk = await driveWholeForm(harness, role, "experienced");
        expect(walk.responses.length).toBeGreaterThan(0);
        for (const response of walk.responses) {
          expect(response.answered).toBeLessThanOrEqual(response.total);
        }
        expect(
          harness.events.filter((event) => event.event_name === "profile.form_completed").length,
        ).toBe(1);
      },
    );

    it.each(CASES)(
      "%s — a tapped chip is stored as its VALUE, which is what the sheet is keyed by",
      async (_kind, role) => {
        // THE TRAP THAT HAS SHIPPED TWICE ON GRINDING, checked from the WRITE side for once. Every
        // dictionary downstream — `trade-resume-map.capability[].values`, the fresher vocabulary —
        // is keyed by the option's stored value, because that is what `pack-registry.toOption`
        // resolves and therefore what is written against the worker. Storing the option KEY instead
        // renders NOTHING, silently: the form still asks, the answer is still stored, the row is
        // simply absent from the sheet.
        //
        // These packs are mostly spelled the same on both sides, which is exactly what would let
        // the bug hide. The none-of-above chips are not: `other_machine` carries the value
        // `unknown`, so those options are the ones this assertion actually discriminates on.
        const harness = harnessFor(role);
        await driveWholeForm(harness, role, "experienced");

        for (const item of role.pack.items) {
          if (item.answer_type !== "single_select" && item.answer_type !== "multi_select") continue;
          if (item.question_key === role.gateKey) continue; // its own case, above
          const row = harness.rows.get(item.question_key);
          if (!row || row.status !== "answered") continue;

          // A single-select lands in `answer_text`, a multi-select in `answer_option_keys` — a
          // column whose name predates the distinction and which actually holds VALUES.
          const stored = new Set<unknown>([
            ...(row.answerOptionKeys ?? []),
            ...(row.answerText === null ? [] : [row.answerText]),
          ]);
          // What the interview writes for the same tap — `answer-capture.matchOptions`.
          const values = new Set<unknown>(
            item.options.map((option) => option.value ?? option.label_text),
          );
          for (const value of stored) {
            expect(
              values.has(value),
              `${role.packId}.${item.question_key}: stored "${value}", which is no option's value ` +
                `— every dictionary keyed by the stored value will render nothing for it`,
            ).toBe(true);
          }
        }
      },
    );

    it.each(CASES)(
      "%s — the first fetch hides nothing, since no gate has an answer yet",
      async (_kind, role) => {
        // The documented fail-open direction of `isFormQuestionVisible`: on a first fetch nothing is
        // settled, so a form must be the WHOLE pack. Serving less would hide the tiered depth from
        // exactly the senior workers the role pack was written for.
        const harness = harnessFor(role);
        const walk = await driveWholeForm(harness, role, "fresher");
        expect([...walk.firstFetch].sort()).toEqual(
          role.pack.items.map((item) => item.question_key).sort(),
        );
      },
    );
  });

  describe("the tier gate", () => {
    it.each(CASES)(
      "%s — stores the NUMBER an interview stores, not the chip's Hindi label",
      async (_kind, role) => {
        // THE ROW IS THE WHOLE CASE. `worker_pack_answer` is read back by `answerMapFromRows` and
        // handed to `compare()`, which refuses to order a string against a number — so a gate stored
        // as text is a gate that is never true and never false, for anybody, forever.
        //
        // The service's own comment claims a form answer and an interview answer to the same
        // question produce byte-identical rows. `answer-capture.matchOptions` stores
        // `option.value ?? option.label_text`, which keeps the integer. This asserts the same of the
        // form.
        const harness = harnessFor(role);
        const gate = role.pack.items.find((item) => item.question_key === role.gateKey)!;
        const rung = gateRung(gate, "experienced");
        await answerGateOnly(harness, role, "experienced");

        const row = harness.rows.get(role.gateKey);
        expect(row, `${role.kind}: the tier gate stored no row at all`).toBeDefined();
        // BOTH COLUMNS IN ONE ASSERTION, so the failure NAMES the value that landed in the wrong
        // one. `expect(answerNumber).toBe(10)` reports only "null", which says nothing about where
        // the answer actually went.
        expect(
          { answer_number: row?.answerNumber ?? null, answer_text: row?.answerText ?? null },
          `${role.kind}: the tier gate must be stored as a number. Landing it in answer_text makes ` +
            `every gte/lte in ${role.packId} compare a string to a number, compare() returns null, ` +
            `and the whole pack's tiering is inert for every worker`,
        ).toEqual({ answer_number: rung.value, answer_text: null });

        // The sheet's own source has to agree: a tenure attribute typed as text loses the years
        // figure the Verdict Line prints.
        const attribute = harness.attributes.find((row_) => row_.attributeKey === role.gateKey);
        expect(attribute?.valueKind, `${role.kind}: tenure reached worker_attributes untyped`).toBe(
          "number",
        );
      },
    );

    it.each(CASES)(
      "%s — a FRESHER is served the fresher block and none of the depth",
      async (_kind, role) => {
        const harness = harnessFor(role);
        await answerGateOnly(harness, role, "fresher");
        const served = questionScreensOf(await harness.service.schema(WORKER)).map(
          (screen) => screen.question.question_key,
        );

        expect([...served].sort()).toEqual(
          [...visibleIfGateStoredAsNumber(role, "fresher")].sort(),
        );

        const { fresherOnly, depthOnly } = gatedKeys(role);
        expect(fresherOnly.length, `${role.kind}: no fresher-gated items to check`).toBeGreaterThan(
          0,
        );
        for (const key of fresherOnly) {
          expect(served, `${role.kind}: a fresher was not served ${key}`).toContain(key);
        }
        for (const key of depthOnly) {
          expect(
            served,
            `${role.kind}: a fresher was served the tier-2 question ${key} — the gate did not close`,
          ).not.toContain(key);
        }
      },
    );

    it.each(CASES)(
      "%s — an EXPERIENCED worker is served the depth and never the fresher block (#1378)",
      async (_kind, role) => {
        // THE DEFECT #1378 CLOSED, asserted on the form's own answer path. A turner with eight years
        // was asked the three ITI questions, answered them, they were written to `worker_attributes`
        // — and `buildFresherRows` dropped all three, because it only runs for a worker with no
        // employments. Three questions asked, three answers stored, nothing printed, no error.
        const harness = harnessFor(role);
        await answerGateOnly(harness, role, "experienced");
        const served = questionScreensOf(await harness.service.schema(WORKER)).map(
          (screen) => screen.question.question_key,
        );

        expect([...served].sort()).toEqual(
          [...visibleIfGateStoredAsNumber(role, "experienced")].sort(),
        );

        const { fresherOnly, depthOnly } = gatedKeys(role);
        for (const key of fresherOnly) {
          expect(
            served,
            `${role.kind}: a senior was served the fresher question ${key}, whose answer nothing ` +
              `will ever print`,
          ).not.toContain(key);
        }
        expect(depthOnly.length, `${role.kind}: no depth-gated items to check`).toBeGreaterThan(0);
        for (const key of depthOnly) {
          expect(
            served,
            `${role.kind}: a senior was NOT served ${key} — the depth this pack exists for is ` +
              `unreachable by anybody`,
          ).toContain(key);
        }
      },
    );

    it.each(CASES)(
      "%s — answering the gate tells the client its screen list is stale",
      async (_kind, role) => {
        // Without it the client keeps a list built when nothing was settled, and re-asks questions
        // the server would no longer serve.
        const harness = harnessFor(role);
        const response = await answerGateOnly(harness, role, "experienced");
        expect(
          response.schema_stale,
          `${role.kind}: the tier gate did not report a stale schema`,
        ).toBe(true);
        expect(response.answered).toBeLessThanOrEqual(response.total);
      },
    );
  });

  describe("qp_draughting", () => {
    it("is a UNIT-3118 router and never becomes a role form", () => {
      // It exists, is active, and routes the twelve non-mechanical draughting codes. What it must
      // never acquire is a descriptor, a form kind, or a sheet — a router that grew a role form
      // would hand a civil draughtsman a mechanical designer's questions and print them.
      const router = packFromCorpus("qp_draughting");
      expect(router.family_id).toBe("fam_draughting");

      expect(descriptorForPack("qp_draughting")).toBeUndefined();
      expect(ROLES.map((role) => role.packId)).not.toContain("qp_draughting");
      expect(ROLES.map((role) => role.familyId)).not.toContain("fam_draughting");
      // The reachable end of it: no routable kind resolves to that family, so `packFor` can never
      // load it for any worker.
      expect(TRADE_FORM_KINDS.map((kind) => familyForTradeForm(kind))).not.toContain(
        "fam_draughting",
      );
      // And no sheet reads it, so even a mis-seeded pack could not print a capability zone.
      expect(TRADE_RESUME_MAPS.map((map) => map.pack_id)).not.toContain("qp_draughting");
    });
  });
});
