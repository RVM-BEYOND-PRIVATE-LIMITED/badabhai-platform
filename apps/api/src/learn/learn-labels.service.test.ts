import { describe, it, expect, vi } from "vitest";
import { LearnLabelsService } from "./learn-labels.service";
import type { LearnEventRow } from "./learn-labels.repository";

/**
 * Unit tests for the LEARN label producer's ROUTING — which event becomes which write,
 * and that the cursor only advances over what was read. Idempotency mechanics
 * (ON CONFLICT / resolved_at guards) are DB facts covered by the migration's CHECKs +
 * UNIQUE key; here we pin the decisions around them.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const POSTING = "22222222-2222-4222-8222-222222222222";

function shownEvent(createdAt = new Date("2026-08-01T10:00:00Z")): LearnEventRow {
  return {
    id: "eeeeeeee-0000-4000-8000-000000000001",
    eventName: "feed.shown_v2",
    subjectType: "job_posting",
    payload: {
      worker_id: WORKER,
      job_posting_id: POSTING,
      rank: 3,
      match_tier: 2,
      boosted: false,
      matched_skill_id: "mskill_cnc_turner",
    },
    createdAt,
  };
}

function appliedEvent(createdAt: Date): LearnEventRow {
  return {
    id: "eeeeeeee-0000-4000-8000-000000000002",
    eventName: "application.submitted",
    subjectType: "job_posting",
    payload: { worker_id: WORKER, job_id: POSTING, rank: null, source_surface: "feed" },
    createdAt,
  };
}

/** A latest consent row that gives `model_training` — the only one the gate lets through. */
const TRAINING_CONSENT = { purposes: ["profiling", "model_training"], revokedAt: null };

/**
 * `consentOf` is each worker's LATEST consent row (absent = never consented). The default gives
 * WORKER `model_training`, so the routing tests below see his events; the #2753 item 13 block
 * takes it away.
 */
function setup(consentOf: Record<string, unknown> = { [WORKER]: TRAINING_CONSENT }) {
  const repo = {
    readEventBatch: vi.fn(async (_ms: number, _limit: number): Promise<LearnEventRow[]> => []),
    ingestImpression: vi.fn(async (_ev: LearnEventRow) => true),
    resolvePending: vi.fn(async (_ev: LearnEventRow, _o: "applied" | "skipped") => true),
    getWatermark: vi.fn(async () => Date.parse("2026-08-01T09:00:00Z")),
    setWatermark: vi.fn(async (_ms: number) => undefined),
    countRelevantAfter: vi.fn(async () => 0),
  };
  const consents = {
    findLatestStatesByWorkers: vi.fn(
      async (ids: readonly string[]) =>
        new Map(ids.filter((id) => id in consentOf).map((id) => [id, consentOf[id]])),
    ),
  };
  const svc = new LearnLabelsService(repo as never, consents as never);
  return { svc, repo, consents };
}

describe("LearnLabelsService.processBatch", () => {
  it("routes feed.shown_v2 to an impression insert", async () => {
    const { svc, repo } = setup();
    repo.readEventBatch.mockResolvedValue([shownEvent()]);
    const summary = await svc.processBatch(100);

    expect(summary.impressionsIngested).toBe(1);
    expect(repo.ingestImpression).toHaveBeenCalledTimes(1);
    expect(repo.resolvePending).not.toHaveBeenCalled();
  });

  it("resolves pending impressions on application.submitted / .skipped", async () => {
    const { svc, repo } = setup();
    const t0 = new Date("2026-08-01T10:00:00Z");
    repo.readEventBatch.mockResolvedValue([
      shownEvent(t0),
      appliedEvent(new Date(t0.getTime() + 60_000)),
    ]);
    const summary = await svc.processBatch(100);

    expect(summary.impressionsIngested).toBe(1);
    expect(summary.submittedResolved).toBe(1);
    // Resolution is delegated with its OUTCOME; label polarity lives in the SQL guard.
    expect(repo.resolvePending).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "application.submitted" }),
      "applied",
    );
  });

  it("counts a LEGACY-subjected application as not applicable instead of writing it", async () => {
    // A V0 decision points at retired `jobs` rows; projecting it would put an id into
    // job_posting_id that means nothing there. The repository's subject guard returns
    // false → the service must COUNT it, not silently drop it.
    const { svc, repo } = setup();
    const ev = appliedEvent(new Date());
    repo.resolvePending.mockResolvedValue(false);
    repo.readEventBatch.mockResolvedValue([ev]);
    const summary = await svc.processBatch(100);

    expect(summary.skippedEvents).toBe(1);
    expect(summary.impressionsIngested).toBe(0);
  });

  it("advances the watermark over the batch's LAST event even when nothing ingested", async () => {
    const { svc, repo } = setup();
    const late = new Date("2026-08-01T12:00:00Z");
    repo.readEventBatch.mockResolvedValue([appliedEvent(late)]);
    repo.resolvePending.mockResolvedValue(false);
    await svc.processBatch(100);

    // Without this, an all-skipped batch would re-read forever.
    expect(repo.setWatermark).toHaveBeenCalledWith(late.getTime());
  });

  it("an empty batch writes no watermark", async () => {
    const { svc, repo } = setup();
    await svc.processBatch(100);
    expect(repo.setWatermark).not.toHaveBeenCalled();
  });

  it("dry-run counts pending without touching anything else", async () => {
    const { svc, repo } = setup();
    repo.countRelevantAfter.mockResolvedValue(42);
    expect(await svc.countPending()).toBe(42);
    expect(repo.readEventBatch).not.toHaveBeenCalled();
    expect(repo.setWatermark).not.toHaveBeenCalled();
  });
});

// #2753 item 13 — a label is training data for reach-learn, so it is written only for a worker
// whose latest consent names `model_training` (`modelTrainingAllowed`). Nobody has given it yet.
describe("LearnLabelsService.processBatch — the model-training gate", () => {
  const t0 = new Date("2026-08-01T10:00:00Z");
  const batch = () => [shownEvent(t0), appliedEvent(new Date(t0.getTime() + 60_000))];

  it.each<[string, Record<string, unknown>]>([
    ["has never consented", {}],
    ["consented to profiling only", { [WORKER]: { purposes: ["profiling"], revokedAt: null } }],
    ["revoked his consent", { [WORKER]: { ...TRAINING_CONSENT, revokedAt: new Date() } }],
  ])("writes nothing for a worker who %s, and says so", async (_case, consentOf) => {
    const { svc, repo } = setup(consentOf);
    repo.readEventBatch.mockResolvedValue(batch());

    const summary = await svc.processBatch(100);

    expect(repo.ingestImpression).not.toHaveBeenCalled();
    expect(repo.resolvePending).not.toHaveBeenCalled();
    expect(summary).toEqual({
      impressionsIngested: 0,
      submittedResolved: 0,
      skippedResolved: 0,
      skippedEvents: 0,
      withheldNoConsent: 2,
    });
    // The cursor still moves past them: a later yes is never applied to earlier behaviour.
    expect(repo.setWatermark).toHaveBeenCalledWith(t0.getTime() + 60_000);
  });

  it("FAILS CLOSED: a consent read that throws withholds the whole batch", async () => {
    const { svc, repo, consents } = setup();
    consents.findLatestStatesByWorkers.mockRejectedValue(new Error("connection terminated"));
    repo.readEventBatch.mockResolvedValue(batch());

    const summary = await svc.processBatch(100);

    expect(repo.ingestImpression).not.toHaveBeenCalled();
    expect(repo.resolvePending).not.toHaveBeenCalled();
    expect(summary.withheldNoConsent).toBe(2);
  });

  it("asks once per batch, before any write, and keeps another worker's events out", async () => {
    const OTHER = "33333333-3333-4333-8333-333333333333";
    const { svc, repo, consents } = setup();
    const theirs: LearnEventRow = {
      ...shownEvent(t0),
      id: "eeeeeeee-0000-4000-8000-000000000003",
      payload: { ...shownEvent(t0).payload, worker_id: OTHER },
    };
    repo.readEventBatch.mockResolvedValue([...batch(), theirs]);

    const summary = await svc.processBatch(100);

    expect(consents.findLatestStatesByWorkers).toHaveBeenCalledTimes(1);
    expect(consents.findLatestStatesByWorkers).toHaveBeenCalledWith([WORKER, OTHER]);
    expect(consents.findLatestStatesByWorkers.mock.invocationCallOrder[0]!).toBeLessThan(
      repo.ingestImpression.mock.invocationCallOrder[0]!,
    );
    expect(repo.ingestImpression).toHaveBeenCalledTimes(1);
    expect(repo.ingestImpression).toHaveBeenCalledWith(
      expect.objectContaining({ id: batch()[0]!.id }),
    );
    expect(summary.impressionsIngested).toBe(1);
    expect(summary.submittedResolved).toBe(1);
    expect(summary.withheldNoConsent).toBe(1);
  });

  it("withholds an event that names no worker", async () => {
    const { svc, repo } = setup();
    repo.readEventBatch.mockResolvedValue([{ ...shownEvent(t0), payload: { rank: 1 } }]);

    const summary = await svc.processBatch(100);

    expect(repo.ingestImpression).not.toHaveBeenCalled();
    expect(summary.withheldNoConsent).toBe(1);
  });
});
