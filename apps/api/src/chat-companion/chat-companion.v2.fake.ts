import { vi } from "vitest";
import { ChatCompanionService } from "./chat-companion.service";
import { V2_CLARIFY, V2_FALTU_COOLDOWN } from "./companion-replies";
import { v2CopyTurn } from "./v2/companion-v2-compose";

/**
 * A COMPACT ChatCompanionService harness for the v2 cross-cutting suites
 * (`companion-v2.v1-first.test.ts`, `companion-v2.flag-off.test.ts`, `v2/faltu.order.test.ts`).
 * The rich harness lives in `chat-companion.service.test.ts`; this one carries exactly the
 * collaborators `message` needs plus the v2 spies, so those suites can assert "the v2 layer was
 * never reached" — or, for P2, exactly WHICH v2 step ran and in what order.
 *
 * `faltu` DEFAULTS FALSE, deliberately: the P1 suites must see the phase-1 pipeline unless they
 * opt in, so adding the P2 gate cannot silently change what they are asserting.
 */

export const WORKER = "11111111-1111-4111-8111-111111111111";
export const SUBMISSION = "22222222-2222-4222-8222-222222222222";
export const CTX = { requestId: "req-1", correlationId: "33333333-3333-4333-8333-333333333333" };
export const NOW = new Date("2026-09-26T10:00:00.000Z");

const PROFILE = {
  id: "p1",
  profileStatus: "confirmed",
  confirmedAt: new Date("2026-09-20T10:00:00.000Z"),
  source: "form",
  canonicalTradeId: "t",
  canonicalRoleId: "r",
  skills: ["turning"],
  machines: [],
  experience: { total_years: 5 },
  salaryExpectation: { currency: "INR" },
  locationPreference: { preferred_cities: ["Pune"] },
  availability: { status: "immediate" },
  rawProfile: null,
};

const HISTORY = {
  items: [
    {
      resume_id: "r1",
      profile_id: "p1",
      source: "form",
      trigger: "profile_confirmed",
      generated_at: "2026-09-20T10:05:00.000Z",
      render_status: "rendered",
      rendered_at: "2026-09-20T10:06:00.000Z",
      is_current: true,
      display_ref: "ABC123",
      trade_label: "VMC Operator",
      experience_years: 5,
      machines: ["Fanuc"],
      axes: [],
      city: "Pune",
      page_count: 1,
    },
  ],
  pending_update: null,
};

export function makeCompanionServiceForV2(opts: {
  v2: boolean;
  /** P1 — the edit phase flag (defaults to the master's value). */
  edit?: boolean;
  /** P2 — the faltu phase gate. Off by default so the P1 suites see the P1 pipeline. */
  faltu?: boolean;
  /** P2 — the new-résumé phase flag (defaults to the master's value, as in production). */
  newResume?: boolean;
  /** P3 — the career phase flag. Off by default, like faltu. */
  career?: boolean;
  /** P2 — what the cool-down store answers; `null` (the default) means "not cooling". */
  cooling?: string | null;
  /** P2 — a real cool-down read to delegate to instead of `cooling` (e.g. a store over a dead Redis). */
  cooldownUntil?: (workerId: string, now: Date) => Promise<string | null>;
}) {
  const policy = {
    resolve: vi.fn(async () => ({ mode: "companion", profile: PROFILE })),
  };
  const repo = { countApplied: vi.fn(async () => 2) };
  const resumes = { history: vi.fn(async () => HISTORY) };
  const skills = { listWantedSkillIds: vi.fn(async () => ["mskill_cnc_turning"]) };
  const jobs = {
    searchOpenPostings: vi.fn(async () => ({
      rows: [{ id: "44444444-4444-4444-8444-444444444444", title: "CNC Operator", city: "Pune" }],
      hasMore: false,
    })),
  };
  const events = { emit: vi.fn(async (params: unknown) => params) };
  const edits = { confirm: vi.fn(), cancel: vi.fn(), propose: vi.fn() };
  const v2 = {
    handleMessage: vi.fn(async () => v2CopyTurn(V2_CLARIFY)),
    // P2 spies: the cool-down gate, its turn, and the deterministic task-chip route.
    cooldownUntil: vi.fn(async (workerId: string, now: Date) =>
      opts.cooldownUntil ? opts.cooldownUntil(workerId, now) : (opts.cooling ?? null),
    ),
    handleCooldown: vi.fn(async (_w: string, _d: unknown, _c: unknown, _n: Date, until: string) => ({
      ...v2CopyTurn(V2_FALTU_COOLDOWN),
      cooldown_until: until,
    })),
    handleTaskChip: vi.fn(async () => v2CopyTurn(V2_CLARIFY)),
  };
  const config = {
    CHAT_COMPANION_NEW_JOBS_WINDOW_DAYS: 7,
    CHAT_COMPANION_NEW_JOBS_COUNT_CAP: 20,
    CHAT_COMPANION_JOB_CHIPS: 3,
    RESUME_UPDATE_PENDING_TIMEOUT_SECONDS: 1_200,
    CHAT_COMPANION_V2_ENABLED: opts.v2,
    CHAT_COMPANION_V2_EDIT_ENABLED: opts.edit ?? opts.v2,
    CHAT_COMPANION_V2_NEW_RESUME_ENABLED: opts.newResume ?? opts.v2,
    CHAT_COMPANION_V2_FALTU_ENABLED: opts.faltu ?? false,
    CHAT_COMPANION_V2_CAREER_ENABLED: opts.career ?? false,
  };
  const svc = new ChatCompanionService(
    config as never,
    policy as never,
    repo as never,
    resumes as never,
    skills as never,
    jobs as never,
    events as never,
    edits as never,
    v2 as never,
  );
  return { svc, policy, repo, resumes, skills, jobs, events, edits, v2 };
}
