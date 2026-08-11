import "reflect-metadata";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { AiService } from "./ai.service";

// ---- Helpers ----
function mockConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    AI_SERVICE_URL: "http://ai-service:8000",
    AI_INTERNAL_TOKEN: undefined,
    ...overrides,
  } as unknown as ServerConfig;
}

function fakeResponse(overrides: Partial<Response> = {}): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    ...overrides,
  } as unknown as Response;
}

function mockMeta(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ai_call_id: "call-1",
    task_type: "profile_extraction",
    model_name: "mock",
    provider: "mock",
    real_call: false,
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_inr: 0,
    latency_ms: 0,
    success: true,
    error_code: null,
    cost_alert: false,
    above_target: false,
    created_at: "2026-07-25T12:00:00.000Z",
    ...overrides,
  };
}

// ---- Suite ----
describe("AiService", () => {
  let ai: AiService;
  let config: ServerConfig;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ---------------------------------------------------------------
  //  post helper (private, tested through public methods)
  // ---------------------------------------------------------------
  /**
   * THE `post()` HELPER, exercised through `pseudonymize`.
   *
   * WAS `profilingOpening`, WHICH NO LONGER EXISTS (OIE Phase 8). These cases were never
   * about the opener — they are the shared transport: non-ok, network error, bad JSON, the
   * 401 posture, and the `AI_INTERNAL_TOKEN` header. `pseudonymize` is now the smallest
   * caller of the same helper, so the coverage moves rather than disappearing.
   *
   * The "profilingOpening caching" and "profilingRespond" blocks are DELETED outright: the
   * memo and the per-turn route both went with the LLM interview, and there is nothing left
   * for them to describe.
   */
  describe("post (via pseudonymize)", () => {
    beforeEach(() => {
      config = mockConfig();
      ai = new AiService(config);
    });

    const masked = (over: Record<string, unknown> = {}) =>
      fakeResponse({
        ok: true,
        status: 200,
        json: async () => ({
          pseudonymized_text: "[PERSON_1] runs a VMC",
          blocked: false,
          replaced_entities: 1,
          placeholder_tokens: ["[PERSON_1]"],
          ...over,
        }),
      });

    it("resolves on a 200 response, and posts to the GATEWAY, never a model route", async () => {
      // THE PRIVACY-RELEVANT ASSERTION. This method exists so the deterministic interview
      // can mask one phrase before it reaches the growth queue; pointing it at anything
      // that could reach a provider would put raw worker text on an LLM path.
      const fetchMock = vi.fn().mockResolvedValue(masked());
      vi.stubGlobal("fetch", fetchMock);

      const result = await ai.pseudonymize("Ramesh runs a VMC");
      expect(result?.pseudonymized_text).toBe("[PERSON_1] runs a VMC");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![0] as string).toContain("/pseudonymize");
    });

    it("returns null on non-ok response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse({ ok: false, status: 503 })));
      expect(await ai.pseudonymize("x")).toBeNull();
    });

    it("returns null on network error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
      expect(await ai.pseudonymize("x")).toBeNull();
    });

    it("returns null on JSON parse error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          fakeResponse({
            ok: true,
            status: 200,
            json: async () => {
              throw new Error("bad json");
            },
          }),
        ),
      );
      expect(await ai.pseudonymize("x")).toBeNull();
    });

    it("logs error on 401 and returns null", async () => {
      // TD67: a 401 is DETERMINISTIC misconfiguration, not a transient outage, so it is
      // logged at ERROR while degrading exactly like any other non-ok.
      const spy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse({ ok: false, status: 401 })));
      expect(await ai.pseudonymize("x")).toBeNull();
      expect(spy).toHaveBeenCalled();
    });

    it("attaches AI_INTERNAL_TOKEN when configured", async () => {
      const tokened = new AiService(mockConfig({ AI_INTERNAL_TOKEN: "t0k" } as never));
      const fetchMock = vi.fn().mockResolvedValue(masked());
      vi.stubGlobal("fetch", fetchMock);
      await tokened.pseudonymize("x");
      const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> };
      expect(init.headers["x-ai-internal-token"]).toBe("t0k");
    });

    it("does not attach AI_INTERNAL_TOKEN when undefined", async () => {
      const fetchMock = vi.fn().mockResolvedValue(masked());
      vi.stubGlobal("fetch", fetchMock);
      await ai.pseudonymize("x");
      const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> };
      expect(init.headers["x-ai-internal-token"]).toBeUndefined();
    });

    it("a BLOCKED result is NOT null — it is a definitive 'do not store this'", async () => {
      // Collapsing `blocked` into `null` would make "the gateway refused to mask this" look
      // identical to "the gateway was down", and the caller treats those differently: one is
      // a permanent no, the other a retryable outage.
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(masked({ pseudonymized_text: "", blocked: true })),
      );
      const out = await ai.pseudonymize("mera number 9876543210 hai");
      expect(out).not.toBeNull();
      expect(out?.blocked).toBe(true);
    });
  });


  describe("extractProfile", () => {
    beforeEach(() => {
      config = mockConfig();
      ai = new AiService(config);
    });

    it("returns remote extraction when reachable", async () => {
      vi.stubGlobal("fetch",
        vi.fn().mockResolvedValue(fakeResponse({
          json: async () => ({
            profile: {},
            blocked: false,
            is_mock: false,
            ai_metadata: mockMeta({ real_call: true }),
          }),
        })),
      );

      const result = await ai.extractProfile({ transcript: "some text" });
      expect(result.is_mock).toBe(false);
      expect(result.profile).toBeDefined();
    });

    it("CONFESSES when the remote is unreachable instead of looking like a quiet worker", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

      const result = await ai.extractProfile({ transcript: "some text" });
      // The empty draft is correct — never fabricate a profile. What was missing is any way
      // to tell this apart from a successful extraction of a worker who said nothing.
      expect(result.error_code).toBe("extract_service_unreachable");
      expect(result.profile.canonical_role_id).toBeNull();
      expect(result.profile.skills).toEqual([]);
      // `is_mock` is NOT the discriminator and never was: the ai-service returns
      // `is_mock = not real_call`, so a perfectly healthy extraction under the committed
      // AI_ENABLE_REAL_CALLS=false default carries it too. Asserted here so a future reader
      // does not mistake it for one.
      expect(result.is_mock).toBe(true);
      // NO FABRICATED CALL RECORD. This used to synthesize metadata claiming
      // `success: true, error_code: null, model_name: "mock"` for a request that never left
      // the process — which reached `ai_jobs` as usage and emitted `ai.cost_recorded` for a
      // provider call that did not happen.
      expect(result.ai_metadata).toBeNull();
    });

    it("a healthy MOCK-posture extraction is not mistaken for an outage", async () => {
      // The other half of the same claim: `error_code` must stay null when the service is
      // reachable, or the new field would just relabel every mock environment as broken.
      vi.stubGlobal("fetch",
        vi.fn().mockResolvedValue(fakeResponse({
          json: async () => ({
            profile: {},
            blocked: false,
            is_mock: true,
            ai_metadata: mockMeta({ real_call: false }),
          }),
        })),
      );

      const result = await ai.extractProfile({ transcript: "some text" });
      expect(result.is_mock).toBe(true);
      expect(result.error_code).toBeNull();
      expect(result.ai_metadata).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------
  //  generateResume
  // ---------------------------------------------------------------
  describe("generateResume", () => {
    beforeEach(() => {
      config = mockConfig();
      ai = new AiService(config);
    });

    it("returns remote resume when reachable", async () => {
      vi.stubGlobal("fetch",
        vi.fn().mockResolvedValue(fakeResponse({
          json: async () => ({
            resume_text: "remote resume",
            resume_json: { profile: {} },
            format: "text",
            is_mock: false,
          }),
        })),
      );

      const result = await ai.generateResume({ profile: {} as never });
      expect(result.resume_text).toBe("remote resume");
      expect(result.is_mock).toBe(false);
    });

    it("generates local mock fallback when unreachable", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

      const result = await ai.generateResume({
        profile: {
          skills: [],
          machines: [],
          skill_labels: [],
          education: [],
          certifications: [],
        } as never,
      });
      expect(result.is_mock).toBe(true);
      expect(result.resume_text).toContain("PROFESSIONAL SUMMARY");
    });

    it("mock fallback includes canonical_role_id, skills, and machines", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

      const result = await ai.generateResume({
        profile: {
          canonical_role_id: "cnc_operator",
          skills: ["setting"],
          machines: ["vmc"],
          skill_labels: [],
          education: [],
          certifications: [],
        } as never,
      });
      expect(result.resume_text).toContain("cnc_operator");
      expect(result.resume_text).toContain("setting");
      expect(result.resume_text).toContain("vmc");
    });
  });

  // ---------------------------------------------------------------
  //  transcribe
  // ---------------------------------------------------------------
  describe("transcribe", () => {
    beforeEach(() => {
      config = mockConfig();
      ai = new AiService(config);
    });

    it("returns remote transcription when reachable", async () => {
      vi.stubGlobal("fetch",
        vi.fn().mockResolvedValue(fakeResponse({
          json: async () => ({
            transcript_text: "Hello world",
            confidence: 0.95,
            english_text: "Hello world",
            is_mock: false,
          }),
        })),
      );

      const result = await ai.transcribe({ storage_path: "voice-notes/note.webm" });
      expect(result.transcript_text).toBe("Hello world");
      expect(result.is_mock).toBe(false);
    });

    it("falls back to empty mock transcription when unreachable", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

      const result = await ai.transcribe({ storage_path: "voice-notes/note.webm" });
      expect(result.is_mock).toBe(true);
      expect(result.transcript_text).toBe("");
    });
  });

  // ---------------------------------------------------------------
  //  canonicalizeSkill
  // ---------------------------------------------------------------
  describe("canonicalizeSkill", () => {
    beforeEach(() => {
      config = mockConfig();
      ai = new AiService(config);
    });

    it("returns canonical skill when reachable", async () => {
      vi.stubGlobal("fetch",
        vi.fn().mockResolvedValue(fakeResponse({
          json: async () => ({ status: "matched", skill_id: "sk_001", score: 0.9 }),
        })),
      );

      const result = await ai.canonicalizeSkill({ phrase: "CNC setting", domain_id: "cnc_vmc", lang: "en" });
      // The stubbed body above carries NO `ai_metadata` — i.e. it is exactly what an
      // ai-service deployed BEFORE #745 returns. It still parses, and the field defaults
      // to null, which is what "additive and back-compatible" has to mean in practice:
      // the two services can be rolled out in either order.
      expect(result).toEqual({
        status: "matched",
        skill_id: "sk_001",
        score: 0.9,
        ai_metadata: null,
      });
    });

    it("returns null when remote unreachable", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

      const result = await ai.canonicalizeSkill({ phrase: "CNC setting", domain_id: "cnc_vmc", lang: "en" });
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------
  //  probeHealth
  // ---------------------------------------------------------------
  describe("probeHealth", () => {
    beforeEach(() => {
      config = mockConfig();
      ai = new AiService(config);
    });

    it("returns realCallsEnabled=true when flag is true", async () => {
      vi.stubGlobal("fetch",
        vi.fn().mockResolvedValue(fakeResponse({
          json: async () => ({ real_calls_enabled: true }),
        })),
      );

      const result = await ai.probeHealth();
      expect(result).toEqual({ realCallsEnabled: true });
    });

    it("returns realCallsEnabled=false when flag is false", async () => {
      vi.stubGlobal("fetch",
        vi.fn().mockResolvedValue(fakeResponse({
          json: async () => ({ real_calls_enabled: false }),
        })),
      );

      const result = await ai.probeHealth();
      expect(result).toEqual({ realCallsEnabled: false });
    });

    it("returns realCallsEnabled=null when flag is not boolean", async () => {
      vi.stubGlobal("fetch",
        vi.fn().mockResolvedValue(fakeResponse({
          json: async () => ({ real_calls_enabled: "yes" }),
        })),
      );

      const result = await ai.probeHealth();
      expect(result).toEqual({ realCallsEnabled: null });
    });

    it("returns realCallsEnabled=null when flag is absent", async () => {
      vi.stubGlobal("fetch",
        vi.fn().mockResolvedValue(fakeResponse({
          json: async () => ({ uptime: 12345 }),
        })),
      );

      const result = await ai.probeHealth();
      expect(result).toEqual({ realCallsEnabled: null });
    });

    it("throws AiServiceUnhealthyError on non-ok response", async () => {
      vi.stubGlobal("fetch",
        vi.fn().mockResolvedValue(fakeResponse({ ok: false, status: 503 })),
      );

      await expect(ai.probeHealth()).rejects.toThrow("ai-service /health returned 503");
    });
  });

  // ---------------------------------------------------------------
  //  No fabricated call records (was: mockCallMetadata)
  // ---------------------------------------------------------------
  describe("a call that never left the process leaves no call record", () => {
    // `mockCallMetadata` is GONE. It was a private helper with exactly one caller —
    // `extractProfile`'s unreachable fallback — and it asserted `success: true,
    // error_code: null` about a request that was never sent. The old test pinned that shape
    // faithfully, which is why it is replaced rather than edited: the shape itself was the
    // defect, so a test that guards it guards the wrong thing.
    it("is not reachable by any name — no unreferenced fabricator survives", () => {
      config = mockConfig();
      ai = new AiService(config);
      expect((ai as unknown as Record<string, unknown>)["mockCallMetadata"]).toBeUndefined();
    });

    it("emits no ai_metadata on ANY unreachable AI leg, so no cost row can be derived", async () => {
      config = mockConfig();
      ai = new AiService(config);
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

      // `recordAiCost` and `recordSpendCap` both no-op on null metadata — that is their
      // documented contract ("no metadata = no real call to record"), and until now
      // `extractProfile` was the one caller that broke it.
      expect((await ai.extractProfile({ transcript: "x" })).ai_metadata).toBeNull();
      expect(await ai.parseProfile({} as never)).toBeNull();
    });
  });

  // ---------------------------------------------------------------
  //  job-posting chat (ADR-0035)
  // ---------------------------------------------------------------
  describe("jobPostingChatOpening / jobPostingChatRespond", () => {
    beforeEach(() => {
      config = mockConfig();
      ai = new AiService(config);
    });

    it("posts the opener to /job-posting-chat/opening and memoizes the success", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(fakeResponse({ json: async () => ({ opening_text: "Kya role hai?" }) }));
      vi.stubGlobal("fetch", fetchMock);

      expect(await ai.jobPostingChatOpening()).toBe("Kya role hai?");
      expect(await ai.jobPostingChatOpening()).toBe("Kya role hai?");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://ai-service:8000/job-posting-chat/opening");
      // The opener request carries a trade hint and NOTHING else — no payer id, no
      // session id, and never the payer's organisation name (ADR-0035 §Decision 3).
      expect(JSON.parse(init.body as string)).toEqual({ trade_hint: null });
    });

    it("does NOT memoize a failure — one blip must not pin later sessions to the fallback", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(fakeResponse({ ok: false, status: 500 }))
        .mockResolvedValue(fakeResponse({ json: async () => ({ opening_text: "Kya role hai?" }) }));
      vi.stubGlobal("fetch", fetchMock);

      expect(await ai.jobPostingChatOpening()).toBeNull();
      expect(await ai.jobPostingChatOpening()).toBe("Kya role hai?");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("returns the parsed turn from /job-posting-chat/respond", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          fakeResponse({
            json: async () => ({
              reply_text: "Kitne log chahiye?",
              asked_question_id: "q_vacancy",
              suggested_answers: ["1", "2-5"],
            }),
          }),
        ),
      );

      const turn = await ai.jobPostingChatRespond({
        session_id: "s-1",
        message_text: "CNC operator chahiye",
      });
      expect(turn?.reply_text).toBe("Kitne log chahiye?");
      expect(turn?.asked_question_id).toBe("q_vacancy");
      // Contract defaults fill in on the wire-absent fields.
      expect(turn?.blocked).toBe(false);
      expect(turn?.draft).toBeNull();
    });

    it("returns NULL rather than a fabricated turn when the AI service is unreachable", async () => {
      // The deliberate difference from profilingRespond: there is no second copy of
      // the job-posting interview engine in TS to fall back to, so the honest answer
      // is "no turn happened" and the caller fails the request loudly.
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
      expect(
        await ai.jobPostingChatRespond({ session_id: "s-1", message_text: "hi" }),
      ).toBeNull();
    });
  });
});
