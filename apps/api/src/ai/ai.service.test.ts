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
  describe("post (via profilingOpening)", () => {
    beforeEach(() => {
      config = mockConfig();
      ai = new AiService(config);
    });

    it("resolves on a 200 response", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        fakeResponse({ ok: true, status: 200, json: async () => ({ opening_text: "Hi there!" }) }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const result = await ai.profilingOpening("cnc_vmc");
      expect(result).toBe("Hi there!");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain("/profiling/opening");
    });

    it("returns null on non-ok response", async () => {
      vi.stubGlobal("fetch",
        vi.fn().mockResolvedValue(fakeResponse({ ok: false, status: 503 })),
      );
      await expect(ai.profilingOpening("cnc_vmc")).resolves.toBeNull();
    });

    it("returns null on network error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
      await expect(ai.profilingOpening("cnc_vmc")).resolves.toBeNull();
    });

    it("returns null on JSON parse error", async () => {
      vi.stubGlobal("fetch",
        vi.fn().mockResolvedValue(fakeResponse({
          json: async () => { throw new SyntaxError("Unexpected token"); },
        })),
      );
      await expect(ai.profilingOpening("cnc_vmc")).resolves.toBeNull();
    });

    it("logs error on 401 and returns null", async () => {
      const loggerWarn = vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
      vi.stubGlobal("fetch",
        vi.fn().mockResolvedValue(fakeResponse({ ok: false, status: 401 })),
      );
      await expect(ai.profilingOpening("cnc_vmc")).resolves.toBeNull();
      expect(loggerWarn).toHaveBeenCalled();
    });

    it("attaches AI_INTERNAL_TOKEN when configured", async () => {
      config = mockConfig({ AI_INTERNAL_TOKEN: "s3cret-token" });
      ai = new AiService(config);
      const fetchMock = vi.fn().mockResolvedValue(
        fakeResponse({ json: async () => ({ opening_text: "hi" }) }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await ai.profilingOpening("cnc_vmc");
      const headers = (fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
      expect(headers["x-ai-internal-token"]).toBe("s3cret-token");
    });

    it("does not attach AI_INTERNAL_TOKEN when undefined", async () => {
      config = mockConfig({ AI_INTERNAL_TOKEN: undefined });
      ai = new AiService(config);
      const fetchMock = vi.fn().mockResolvedValue(
        fakeResponse({ json: async () => ({ opening_text: "hi" }) }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await ai.profilingOpening("cnc_vmc");
      const headers = (fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
      expect(headers["x-ai-internal-token"]).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------
  //  profilingOpening — caching
  // ---------------------------------------------------------------
  describe("profilingOpening caching", () => {
    it("caches successes and returns cached value on second call", async () => {
      config = mockConfig();
      ai = new AiService(config);
      const fetchMock = vi.fn().mockResolvedValue(
        fakeResponse({ json: async () => ({ opening_text: "Hello worker" }) }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const first = await ai.profilingOpening("cnc_vmc");
      expect(first).toBe("Hello worker");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const second = await ai.profilingOpening("cnc_vmc");
      expect(second).toBe("Hello worker");
      expect(fetchMock).toHaveBeenCalledTimes(1); // not called again
    });

    it("does NOT cache null (empty text)", async () => {
      config = mockConfig();
      ai = new AiService(config);
      const fetchMock = vi.fn().mockResolvedValue(
        fakeResponse({ json: async () => ({ opening_text: "  " }) }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const first = await ai.profilingOpening("cnc_vmc");
      expect(first).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const second = await ai.profilingOpening("cnc_vmc");
      expect(second).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2); // retried
    });

    it("does NOT cache failures (returned null)", async () => {
      config = mockConfig();
      ai = new AiService(config);
      const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
      vi.stubGlobal("fetch", fetchMock);

      await ai.profilingOpening("cnc_vmc");
      await ai.profilingOpening("cnc_vmc");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------
  //  profilingRespond
  // ---------------------------------------------------------------
  describe("profilingRespond", () => {
    beforeEach(() => {
      config = mockConfig();
      ai = new AiService(config);
    });

    it("returns remote response when reachable", async () => {
      const remoteReply = {
        reply_text: "Tell me about your experience",
        blocked: false,
        suggested_followups: [],
        asked_question_id: "q_experience",
        extraction_ready: false,
        is_mock: false,
        updated_state: { role_family: "cnc_vmc", turn_count: 1, answered_topics: [], asked_question_ids: [], collected: {} },
      };
      vi.stubGlobal("fetch",
        vi.fn().mockResolvedValue(fakeResponse({
          json: async () => remoteReply,
          ok: true, status: 200,
        })),
      );

      const result = await ai.profilingRespond({
        session_id: "session-1",
        message_text: "I have 5 years experience",
        history: [],
        role_family: "cnc_vmc",
      });
      expect(result.reply_text).toBe("Tell me about your experience");
      expect(result.is_mock).toBe(false);
    });

    it("falls back to mock when remote unreachable", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

      const result = await ai.profilingRespond({
        session_id: "session-1",
        message_text: "I have 5 years experience",
        history: [],
        role_family: "cnc_vmc",
      });
      expect(result.is_mock).toBe(true);
      expect(result.reply_text).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------
  //  extractProfile
  // ---------------------------------------------------------------
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

    it("falls back to mock extraction when remote unreachable", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

      const result = await ai.extractProfile({ transcript: "some text" });
      expect(result.is_mock).toBe(true);
      expect(result.ai_metadata!.real_call).toBe(false);
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
      expect(result).toEqual({ status: "matched", skill_id: "sk_001", score: 0.9 });
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
  //  mockCallMetadata (private utility)
  // ---------------------------------------------------------------
  describe("mockCallMetadata", () => {
    it("returns the correct metadata shape", async () => {
      config = mockConfig();
      ai = new AiService(config);

      // Access private method via bracket notation
      const meta = (ai as never as { mockCallMetadata(t: string): unknown }).mockCallMetadata("profile_extraction") as Record<string, unknown>;
      expect(meta.task_type).toBe("profile_extraction");
      expect(meta.model_name).toBe("mock");
      expect(meta.provider).toBe("mock");
      expect(meta.real_call).toBe(false);
      expect(meta.input_tokens).toBe(0);
      expect(meta.output_tokens).toBe(0);
      expect(meta.estimated_cost_inr).toBe(0);
      expect(meta.success).toBe(true);
      expect(meta.error_code).toBeNull();
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
