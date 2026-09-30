import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import type { EventsService } from "../events/events.service";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import { ReferralLinkService } from "./referral-link.service";
import type { ReferralLinkRepository } from "./referral-link.repository";

const CODE = "abcdef012345";
const WORKER = "44444444-4444-4444-8444-444444444444";
const LINK_ID = "11111111-1111-4111-8111-111111111111";
const CLICK_ID = "22222222-2222-4222-8222-222222222222";
const BASE = "https://app.badabhai.in";

const ANDROID = "Mozilla/5.0 (Linux; Android 13; SM-A125F) Chrome/120 Mobile Safari/537.36";
const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36";

const ORGANIC_HOURS = 168; // 7 days
const PAID_HOURS = 24;

function make(overrides: Partial<Record<string, unknown>> = {}) {
  const repo = {
    createLink: vi.fn(),
    findLinkByCode: vi.fn().mockResolvedValue(undefined),
    recordClick: vi.fn().mockResolvedValue({ id: CLICK_ID }),
    hasRecentClick: vi.fn().mockResolvedValue(false),
    claimFirstTouch: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
  const events = { emit: vi.fn().mockResolvedValue(undefined) };
  // Deterministic stand-in for the keyed HMAC (the real one is PiiCryptoService's server
  // pepper). It must be genuinely OPAQUE — an echoing fake like `hmac(${v})` would make the
  // "raw IP never reaches the row" assertion below pass or fail on the fake's own format
  // rather than on the service's behaviour.
  const pii = {
    hmac: vi.fn(
      (v: string) =>
        `d1ge57${[...v].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16)}`,
    ),
  };
  const config = {
    REFERRAL_SHORT_LINK_BASE: BASE,
    REFERRAL_MATCH_WINDOW_ORGANIC_HOURS: ORGANIC_HOURS,
    REFERRAL_MATCH_WINDOW_PAID_HOURS: PAID_HOURS,
  } as unknown as ServerConfig;

  const svc = new ReferralLinkService(
    repo as unknown as ReferralLinkRepository,
    events as unknown as EventsService,
    pii as unknown as PiiCryptoService,
    config,
  );
  return { svc, repo, events, pii };
}

// ───────────────────────────────────────────────────────────────────────────────
// SCENARIO 2 — DIRECT deep link (app already installed).
// ───────────────────────────────────────────────────────────────────────────────
describe("SCENARIO 2 — direct deep link: an installed app opens the right destination", () => {
  it("Android resolves to the exact App Link URL the manifest claims, and logs the click", async () => {
    const h = make();
    const out = await h.svc.resolve({ code: CODE, ip: "1.2.3.4", userAgent: ANDROID });

    // apps/worker-app/android/.../AndroidManifest.xml registers autoVerify on
    // scheme=https host=app.badabhai.in pathPrefix=/i/ — this is that URL.
    expect(out.redirectTo).toBe(`${BASE}/i/${CODE}`);
    expect(out.leg).toBe("app_link");
    expect(out.clickRecorded).toBe(true);
    expect(h.repo.recordClick).toHaveBeenCalledTimes(1);
  });

  it("desktop is diverted to the QR bridge instead of a Play Store link it cannot use", async () => {
    const h = make();
    const out = await h.svc.resolve({ code: CODE, ip: "1.2.3.4", userAgent: DESKTOP });
    expect(out.redirectTo).toBe(`${BASE}/i/${CODE}/desktop`);
    expect(out.leg).toBe("masked_page");
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// SCENARIO 1 — DEFERRED deep link + the first-touch RACE.
// ───────────────────────────────────────────────────────────────────────────────
describe("SCENARIO 1 — deferred install: click → Play → first open → claim, exactly once", () => {
  /** A click that happened 2h ago on an organic link — comfortably inside the 7d window. */
  const freshOrganicClick = {
    id: CLICK_ID,
    referralLinkId: LINK_ID,
    medium: "organic" as const,
    clickedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
  };

  it("the install-referrer post resolves the claim and emits referral.install_claimed", async () => {
    const h = make({ claimFirstTouch: vi.fn().mockResolvedValue(freshOrganicClick) });

    const out = await h.svc.claimInstall({
      code: CODE,
      workerId: WORKER,
      source: "install_referrer", // ← the Play Store round-trip leg
    });

    expect(out.claimed).toBe(true);
    expect(out.referralLinkId).toBe(LINK_ID);

    const emitted = h.events.emit.mock.calls.find(
      (c) => c[0].event_name === "referral.install_claimed",
    );
    expect(emitted).toBeDefined();
    expect(emitted![0].payload).toMatchObject({
      referral_link_id: LINK_ID,
      worker_id: WORKER,
      medium: "organic",
      source: "install_referrer",
      age_hours: 2,
      window_hours: ORGANIC_HOURS,
    });
  });

  it("passes BOTH configured windows down to the repository — never a hardcoded number", async () => {
    const claimFirstTouch = vi.fn().mockResolvedValue(freshOrganicClick);
    const h = make({ claimFirstTouch });
    await h.svc.claimInstall({ code: CODE, workerId: WORKER, source: "install_referrer" });
    expect(claimFirstTouch).toHaveBeenCalledWith(
      expect.objectContaining({
        code: CODE,
        workerId: WORKER,
        windowHoursByMedium: { organic: ORGANIC_HOURS, paid: PAID_HOURS },
      }),
    );
  });

  it("RACE: a concurrent duplicate post claims exactly ONCE and never throws", async () => {
    // Models the real DB behaviour: the first caller wins the row; the second loses the
    // advisory-lock race and finds the worker already has a claim (repo → null).
    let winnerTaken = false;
    const claimFirstTouch = vi.fn().mockImplementation(async () => {
      if (winnerTaken) return null;
      winnerTaken = true;
      return freshOrganicClick;
    });
    const h = make({ claimFirstTouch });

    const [a, b] = await Promise.all([
      h.svc.claimInstall({ code: CODE, workerId: WORKER, source: "install_referrer" }),
      h.svc.claimInstall({ code: CODE, workerId: WORKER, source: "install_referrer" }),
    ]);

    expect([a.claimed, b.claimed].filter(Boolean)).toHaveLength(1);
    const claims = h.events.emit.mock.calls.filter(
      (c) => c[0].event_name === "referral.install_claimed",
    );
    expect(claims).toHaveLength(1);
  });

  it("RACE: the loser hitting the UNIQUE index is neutralised into a no-op, not an error", async () => {
    // What Postgres actually raises when referral_clicks_claimed_worker_uq fires.
    const uniqueViolation = Object.assign(new Error("duplicate key value"), { code: "23505" });
    const h = make({ claimFirstTouch: vi.fn().mockRejectedValue(uniqueViolation) });

    const out = await h.svc.claimInstall({
      code: CODE,
      workerId: WORKER,
      source: "install_referrer",
    });

    expect(out.claimed).toBe(false);
    expect(out.reason).toBe("already_claimed");
    expect(h.events.emit).not.toHaveBeenCalled();
  });

  it("the claim event is keyed on the CLICK row, so an at-least-once retry writes one event", async () => {
    const h = make({ claimFirstTouch: vi.fn().mockResolvedValue(freshOrganicClick) });
    await h.svc.claimInstall({ code: CODE, workerId: WORKER, source: "install_referrer" });
    const emitted = h.events.emit.mock.calls.find(
      (c) => c[0].event_name === "referral.install_claimed",
    );
    expect(emitted![0].idempotencyKey).toBe(`referral.install_claimed:${CLICK_ID}`);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// SCENARIO 4 — the MATCH WINDOW.
// ───────────────────────────────────────────────────────────────────────────────
describe("SCENARIO 4 — match window: inside attributes, outside does not", () => {
  it("a click INSIDE the organic window attributes", async () => {
    const insideOrganic = {
      id: CLICK_ID,
      referralLinkId: LINK_ID,
      medium: "organic" as const,
      clickedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000), // 6 days < 7
    };
    const h = make({ claimFirstTouch: vi.fn().mockResolvedValue(insideOrganic) });
    const out = await h.svc.claimInstall({ code: CODE, workerId: WORKER, source: "app_link" });
    expect(out.claimed).toBe(true);
  });

  it("a click OUTSIDE the window does not attribute (the repo returns no candidate)", async () => {
    // The window predicate lives in SQL, so at this layer "too old" surfaces as "no
    // candidate row". The SQL itself is pinned by the repository test.
    const h = make({ claimFirstTouch: vi.fn().mockResolvedValue(null) });
    const out = await h.svc.claimInstall({ code: CODE, workerId: WORKER, source: "app_link" });
    expect(out.claimed).toBe(false);
    expect(h.events.emit).not.toHaveBeenCalled();
  });

  it("the PAID window is reported on the event, so a mis-tuned window is visible in the data", async () => {
    const paidClick = {
      id: CLICK_ID,
      referralLinkId: LINK_ID,
      medium: "paid" as const,
      clickedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    };
    const h = make({ claimFirstTouch: vi.fn().mockResolvedValue(paidClick) });
    await h.svc.claimInstall({ code: CODE, workerId: WORKER, source: "install_referrer" });
    const emitted = h.events.emit.mock.calls.find(
      (c) => c[0].event_name === "referral.install_claimed",
    );
    expect(emitted![0].payload).toMatchObject({ medium: "paid", window_hours: PAID_HOURS });
  });

  it("windows are read from CONFIG — a re-tuned value flows through without a code change", async () => {
    const claimFirstTouch = vi.fn().mockResolvedValue({
      id: CLICK_ID,
      referralLinkId: LINK_ID,
      medium: "organic" as const,
      clickedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const h = make({ claimFirstTouch });
    // Re-tune organic 168h → 72h on the live config object.
    (
      h.svc as unknown as { config: Record<string, number> }
    ).config.REFERRAL_MATCH_WINDOW_ORGANIC_HOURS = 72;

    await h.svc.claimInstall({ code: CODE, workerId: WORKER, source: "app_link" });
    expect(claimFirstTouch).toHaveBeenCalledWith(
      expect.objectContaining({ windowHoursByMedium: { organic: 72, paid: PAID_HOURS } }),
    );
  });

  it("an EXPIRED link cannot be claimed even by a click inside the window", async () => {
    const claimFirstTouch = vi.fn();
    const h = make({
      claimFirstTouch,
      findLinkByCode: vi
        .fn()
        .mockResolvedValue({ id: LINK_ID, medium: "organic", expiresAt: new Date(Date.now() - 1) }),
    });
    const out = await h.svc.claimInstall({ code: CODE, workerId: WORKER, source: "app_link" });
    expect(out.claimed).toBe(false);
    expect(out.reason).toBe("outside_window");
    // And it short-circuits — no lock is taken for a link that cannot pay out.
    expect(claimFirstTouch).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Privacy + fail-safety of the resolve path.
// ───────────────────────────────────────────────────────────────────────────────
describe("resolve — PII boundary and fail-safety (invariant #2)", () => {
  it("the RAW ip is hashed and NEVER reaches the click row", async () => {
    const h = make();
    await h.svc.resolve({ code: CODE, ip: "203.0.113.9", userAgent: ANDROID });

    // The raw IP crossed the crypto boundary exactly once...
    expect(h.pii.hmac).toHaveBeenCalledWith("203.0.113.9|android");
    // ...and what was PERSISTED is the opaque digest, not the address.
    const written = h.repo.recordClick.mock.calls[0]![0];
    expect(written.clickHash).toBe(h.pii.hmac.mock.results[0]!.value);
    expect(JSON.stringify(written)).not.toContain("203.0.113.9");
    // The full User-Agent is never persisted either — only the coarse enum.
    expect(JSON.stringify(written)).not.toContain("SM-A125F");
    expect(written.platform).toBe("android");
  });

  it("a bearer CODE never rides an event payload — only the opaque row id", async () => {
    const h = make({
      findLinkByCode: vi
        .fn()
        .mockResolvedValue({ id: LINK_ID, medium: "organic", expiresAt: null }),
    });
    await h.svc.resolve({ code: CODE, ip: "1.2.3.4", userAgent: ANDROID });

    const emitted = h.events.emit.mock.calls.find(
      (c) => c[0].event_name === "referral.link_clicked",
    );
    expect(emitted).toBeDefined();
    expect(JSON.stringify(emitted![0].payload)).not.toContain(CODE);
    expect(emitted![0].payload).toMatchObject({ referral_link_id: LINK_ID });
  });

  it("a legacy invites/agency_invites code logs the click but emits NO referral.* event", async () => {
    // Otherwise one tap would be double-counted: invite.clicked AND referral.link_clicked.
    const h = make({ findLinkByCode: vi.fn().mockResolvedValue(undefined) });
    await h.svc.resolve({ code: CODE, ip: "1.2.3.4", userAgent: ANDROID });
    expect(h.repo.recordClick).toHaveBeenCalledTimes(1);
    expect(h.events.emit).not.toHaveBeenCalled();
  });

  it("a DB outage still redirects the worker — the funnel stat dies, the install page does not", async () => {
    const h = make({ recordClick: vi.fn().mockRejectedValue(new Error("db down")) });
    const out = await h.svc.resolve({ code: CODE, ip: "1.2.3.4", userAgent: ANDROID });
    expect(out.redirectTo).toBe(`${BASE}/i/${CODE}`);
    expect(out.clickRecorded).toBe(false);
  });

  it("a malformed code falls back to a real installable page, never an error", async () => {
    const h = make();
    const out = await h.svc.resolve({
      code: "../../etc/passwd",
      ip: "1.2.3.4",
      userAgent: ANDROID,
    });
    expect(out.redirectTo).toBe(`${BASE}/i/unknown`);
    expect(out.leg).toBe("fallback");
    expect(h.repo.recordClick).not.toHaveBeenCalled();
  });

  it("a WhatsApp crawler prefetch redirects but records NO click (no fabricated first touch)", async () => {
    const h = make();
    const out = await h.svc.resolve({
      code: CODE,
      ip: "1.2.3.4",
      userAgent: "WhatsApp/2.23.20.0 A",
    });
    expect(out.redirectTo).toBe(`${BASE}/i/${CODE}`);
    expect(out.clickRecorded).toBe(false);
    expect(h.repo.recordClick).not.toHaveBeenCalled();
  });

  it("skipClick (per-IP cap breached) still returns the CODE-carrying redirect", async () => {
    // The regression this pins: falling back to the code-less URL here would strip
    // attribution from every worker behind a shared egress IP — a whole factory gate.
    const h = make();
    const out = await h.svc.resolve({
      code: CODE,
      ip: "1.2.3.4",
      userAgent: ANDROID,
      skipClick: true,
    });
    expect(out.redirectTo).toBe(`${BASE}/i/${CODE}`);
    expect(out.clickRecorded).toBe(false);
    expect(h.repo.recordClick).not.toHaveBeenCalled();
  });

  it("a repeat click from the same hashed visitor inside the dedupe window is not double-counted", async () => {
    const h = make({ hasRecentClick: vi.fn().mockResolvedValue(true) });
    const out = await h.svc.resolve({ code: CODE, ip: "1.2.3.4", userAgent: ANDROID });
    expect(out.clickRecorded).toBe(false);
    expect(h.repo.recordClick).not.toHaveBeenCalled();
  });
});

describe("mintLink", () => {
  it("mints a 12-hex code and returns the SHORT /r/ link that actually gets shared", async () => {
    const h = make({
      createLink: vi.fn().mockImplementation(async (v: Record<string, unknown>) => ({
        id: LINK_ID,
        ...v,
      })),
    });
    const out = await h.svc.mintLink({ kind: "agent", agentPayerId: LINK_ID, medium: "paid" });

    expect(out.code).toMatch(/^[a-f0-9]{12}$/);
    expect(out.url).toBe(`${BASE}/r/${out.code}`);
    const emitted = h.events.emit.mock.calls.find(
      (c) => c[0].event_name === "referral.link_created",
    );
    expect(emitted![0].payload).toMatchObject({
      referral_link_id: LINK_ID,
      kind: "agent",
      medium: "paid",
    });
    expect(JSON.stringify(emitted![0].payload)).not.toContain(out.code);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// #1800 — the RÉSUMÉ QR (`resume_qr`), through the same resolver and claim.
// ───────────────────────────────────────────────────────────────────────────────
describe("#1800 — a resume_qr link through GET /r/:code", () => {
  const OWNER = "55555555-5555-4555-8555-555555555555";
  const resumeQrLink = (ownerWorkerId: string | null = OWNER) => ({
    id: LINK_ID,
    kind: "resume_qr" as const,
    medium: "organic" as const,
    ownerWorkerId,
    expiresAt: null,
  });

  it("emits profile.qr_scanned — exact payload, the OWNER as subject — and NOT referral.link_clicked", async () => {
    const h = make({ findLinkByCode: vi.fn().mockResolvedValue(resumeQrLink()) });
    const out = await h.svc.resolve({ code: CODE, ip: "1.2.3.4", userAgent: ANDROID });

    expect(out.clickRecorded).toBe(true);
    // The click row is still written: the first-touch claim reads it.
    expect(h.repo.recordClick).toHaveBeenCalledTimes(1);
    expect(h.repo.recordClick.mock.calls[0]![0]).toMatchObject({ referralLinkId: LINK_ID });

    // ONE tap, ONE event.
    expect(h.events.emit).toHaveBeenCalledTimes(1);
    const call = h.events.emit.mock.calls[0]![0];
    expect(call.event_name).toBe("profile.qr_scanned");
    expect(call.payload).toEqual({
      worker_id: OWNER,
      referral_link_id: LINK_ID,
      platform: "android",
    });
    expect(call.actor).toEqual({ actor_type: "system", actor_id: null });
    expect(call.subject).toEqual({ subject_type: "worker", subject_id: OWNER });
    expect(call.idempotencyKey).toBe(`profile.qr_scanned:${CLICK_ID}`);
    // The bearer code and the scanner's IP / UA never ride the event.
    const wire = JSON.stringify(call);
    expect(wire).not.toContain(CODE);
    expect(wire).not.toContain("1.2.3.4");
    expect(wire).not.toContain("SM-A125F");
  });

  it("the redirect is exactly the one any other code gets — the install page, no oracle", async () => {
    const qr = make({ findLinkByCode: vi.fn().mockResolvedValue(resumeQrLink()) });
    const legacy = make();
    const a = await qr.svc.resolve({ code: CODE, ip: "1.2.3.4", userAgent: ANDROID });
    const b = await legacy.svc.resolve({ code: CODE, ip: "1.2.3.4", userAgent: ANDROID });
    expect(a.redirectTo).toBe(b.redirectTo);
    expect(a.redirectTo).toBe(`${BASE}/i/${CODE}`);
  });

  it("other kinds are unchanged: an agent link still emits referral.link_clicked only", async () => {
    const h = make({
      findLinkByCode: vi
        .fn()
        .mockResolvedValue({ ...resumeQrLink(null), kind: "agent", ownerWorkerId: null }),
    });
    await h.svc.resolve({ code: CODE, ip: "1.2.3.4", userAgent: ANDROID });
    expect(h.events.emit.mock.calls.map((c) => c[0].event_name)).toEqual(["referral.link_clicked"]);
  });

  it("a DEAD link (owner erased → NULL) records NO click and emits nothing, yet redirects the same", async () => {
    const h = make({ findLinkByCode: vi.fn().mockResolvedValue(resumeQrLink(null)) });
    const out = await h.svc.resolve({ code: CODE, ip: "1.2.3.4", userAgent: ANDROID });
    expect(out.redirectTo).toBe(`${BASE}/i/${CODE}`);
    expect(out.clickRecorded).toBe(false);
    expect(h.repo.recordClick).not.toHaveBeenCalled();
    expect(h.events.emit).not.toHaveBeenCalled();
  });

  it.each([
    ["a link-preview crawler", { userAgent: "WhatsApp/2.23.20.0 A" }, {}],
    ["the per-IP cap (skipClick)", { skipClick: true }, {}],
    [
      "the 10-minute hashed-visitor dedupe",
      {},
      { hasRecentClick: vi.fn().mockResolvedValue(true) },
    ],
  ])("%s still applies: no click row, no profile.qr_scanned", async (_what, extra, repoOver) => {
    const h = make({ findLinkByCode: vi.fn().mockResolvedValue(resumeQrLink()), ...repoOver });
    const out = await h.svc.resolve({ code: CODE, ip: "1.2.3.4", userAgent: ANDROID, ...extra });
    expect(out.clickRecorded).toBe(false);
    expect(out.redirectTo).toBe(`${BASE}/i/${CODE}`);
    expect(h.repo.recordClick).not.toHaveBeenCalled();
    expect(h.events.emit).not.toHaveBeenCalled();
  });
});

describe("#1800 — claiming an install through a resume_qr link", () => {
  const OWNER = "55555555-5555-4555-8555-555555555555";
  const click = {
    id: CLICK_ID,
    referralLinkId: LINK_ID,
    medium: "organic" as const,
    clickedAt: new Date(Date.now() - 60 * 60 * 1000),
  };
  const link = (ownerWorkerId: string | null) => ({
    id: LINK_ID,
    kind: "resume_qr" as const,
    medium: "organic" as const,
    ownerWorkerId,
    expiresAt: null,
  });

  it("a DIFFERENT worker claims first touch like any link, and the outcome carries the kind", async () => {
    const h = make({
      findLinkByCode: vi.fn().mockResolvedValue(link(OWNER)),
      claimFirstTouch: vi.fn().mockResolvedValue(click),
    });
    const out = await h.svc.claimInstall({ code: CODE, workerId: WORKER, source: "app_link" });
    expect(out).toEqual({ claimed: true, referralLinkId: LINK_ID, linkKind: "resume_qr" });
    const claimed = h.events.emit.mock.calls.find(
      (c) => c[0].event_name === "referral.install_claimed",
    );
    expect(claimed![0].payload).toMatchObject({ referral_link_id: LINK_ID, worker_id: WORKER });
  });

  it("SELF-CLAIM is refused: the owner posting their own résumé's code claims nothing", async () => {
    const claimFirstTouch = vi.fn().mockResolvedValue(click);
    const h = make({ findLinkByCode: vi.fn().mockResolvedValue(link(WORKER)), claimFirstTouch });
    const out = await h.svc.claimInstall({ code: CODE, workerId: WORKER, source: "app_link" });
    expect(out).toEqual({ claimed: false, reason: "self_claim", linkKind: "resume_qr" });
    expect(claimFirstTouch).not.toHaveBeenCalled();
    expect(h.events.emit).not.toHaveBeenCalled();
  });

  it("a DEAD link attributes nobody, even over a click recorded while its owner was live", async () => {
    const claimFirstTouch = vi.fn().mockResolvedValue(click);
    const h = make({ findLinkByCode: vi.fn().mockResolvedValue(link(null)), claimFirstTouch });
    const out = await h.svc.claimInstall({ code: CODE, workerId: WORKER, source: "app_link" });
    expect(out).toEqual({ claimed: false, reason: "dead_link", linkKind: "resume_qr" });
    expect(claimFirstTouch).not.toHaveBeenCalled();
    expect(h.events.emit).not.toHaveBeenCalled();
  });

  it("a lost race still reports the kind, so the caller stops before the paying seams", async () => {
    const uniqueViolation = Object.assign(new Error("duplicate key value"), { code: "23505" });
    const h = make({
      findLinkByCode: vi.fn().mockResolvedValue(link(OWNER)),
      claimFirstTouch: vi.fn().mockRejectedValue(uniqueViolation),
    });
    const out = await h.svc.claimInstall({ code: CODE, workerId: WORKER, source: "app_link" });
    expect(out).toEqual({ claimed: false, reason: "already_claimed", linkKind: "resume_qr" });
  });

  it("a LEGACY code (no referral_links row) reports linkKind null — its funnels are unchanged", async () => {
    const h = make({ claimFirstTouch: vi.fn().mockResolvedValue(null) });
    const out = await h.svc.claimInstall({ code: CODE, workerId: WORKER, source: "app_link" });
    expect(out).toEqual({ claimed: false, reason: "unknown_code", linkKind: null });
  });
});

describe("#1800 — mintLink cannot mint a resume_qr link", () => {
  it("is excluded by TYPE — the résumé QR has exactly one mint path (ResumeQrLinkService)", () => {
    const h = make();
    // The assertion is the compile error: `tsc` fails this file if the exclusion is ever removed,
    // because the directive below would then be unused. Never invoked, so nothing is minted.
    const mint = (): Promise<unknown> =>
      // @ts-expect-error — `resume_qr` is not an accepted kind for mintLink.
      h.svc.mintLink({ kind: "resume_qr", ownerWorkerId: WORKER });
    expect(typeof mint).toBe("function");
  });
});
