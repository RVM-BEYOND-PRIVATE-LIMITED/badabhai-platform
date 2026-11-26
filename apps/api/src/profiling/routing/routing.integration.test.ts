/**
 * First-question routing integration (#3015) — through the REAL IdentifyService.
 *
 * Machine operator → machine question → VMC → VMC pin; helper → department → Moulding →
 * injection moulding with level trainee. Stubbed at the boundaries only (OccupationService,
 * AiService, EventsService), like trade-confirm-identify.integration.test.ts.
 */
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import { IdentifyService } from "../identify.service";
import { narrowProfilingEnvelope, emptyProfilingEnvelope, type ProfilingEnvelope } from "../conversation-state";

const SESSION = "33333333-3333-4333-8333-333333333333";
const WORKER = "11111111-1111-4111-8111-111111111111";
const CTX = { correlationId: "cid", requestId: "req_1" } as never;

function makeIdentify() {
  const occupation = {
    resolve: vi.fn(async (text: string) => {
      const t = text.trim().toLowerCase();
      // More-exact phrase wins over routing: auto-pin turner.
      if (t.includes("cnc turner operator")) {
        return {
          status: "auto" as const,
          pinned: {
            jobDomainId: "jd_nco_7223_6001",
            familyId: "fam_cnc_turning",
            label: "CNC Turner",
            iscoUnitCode: "7223",
            confidence: 0.97,
            layer: "L0",
          },
          candidates: [],
          catalogVersion: "cat_test",
          embedSpent: false,
        };
      }
      // Shared words: no auto pin (ladder returns disambiguate/unresolved) so routing fires.
      return {
        status: "unresolved" as const,
        pinned: null,
        candidates: [],
        catalogVersion: "cat_test",
        embedSpent: false,
      };
    }),
    describeDomain: vi.fn((jobDomainId: string) => {
      const labels: Record<string, string> = {
        jd_nco_7223_5004: "VMC Operator",
        jd_nco_8142_0501: "Injection Moulding Operator",
      };
      if (!(jobDomainId in labels)) return null;
      return {
        jobDomainId,
        label: labels[jobDomainId],
        iscoUnitCode: "7223",
        catalogVersion: "cat_test",
      };
    }),
    recordUnresolved: vi.fn(async () => ({ count: 1 })),
  };
  const events = { emit: vi.fn(async () => undefined) };
  const ai = { pseudonymize: vi.fn(async () => ({ pseudonymized_text: "stub", blocked: false })) };
  const svc = new IdentifyService(occupation as never, events as never, ai as never);
  return { svc, occupation };
}

function freshEnvelope(): ProfilingEnvelope {
  return { ...emptyProfilingEnvelope(), rev: 1 } as ProfilingEnvelope;
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});

describe("first-question routing (#3015)", () => {
  it("machine operator → machine question, not the machining form", async () => {
    const { svc } = makeIdentify();
    const result = await svc.identify(freshEnvelope(), "machine operator hoon", { sessionId: SESSION, workerId: WORKER } as never, "other");
    expect(result.offer).not.toBeNull();
    expect(result.offer?.prompt).toBe("Aap kaunsi machine chalate hain?");
    const labels = (result.offer?.chips ?? []).map((c) => c.label);
    expect(labels).toContain("VMC / HMC / milling");
    expect(labels).toContain("Koi aur machine");
    // Budget: one identify turn spent, like a search offer.
    expect(result.patch.identifyAttempts).toBe(1);
  });

  it("VMC chip pins the VMC family (same event as a tapped search chip)", async () => {
    const { svc } = makeIdentify();
    const first = await svc.identify(freshEnvelope(), "machine operator", { sessionId: SESSION, workerId: WORKER } as never, "other");
    expect(first.offer).not.toBeNull();
    const envelope = { ...freshEnvelope(), needsDisambiguation: true, disambiguationOffer: first.offer!.chips, disambiguationPrompt: first.offer!.prompt, identifyAttempts: 1 } as ProfilingEnvelope;
    const tapped = await svc.identify(envelope, "VMC / HMC / milling", { sessionId: SESSION, workerId: WORKER } as never, "other");
    expect(tapped.pinned).not.toBeNull();
    expect(tapped.patch.occupationFamilyId).toBe("fam_vmc_milling");
    expect(tapped.tradeText).toBe("VMC / HMC / milling");
    expect(tapped.offer).toBeNull();
  });

  it("helper → department → Moulding pins injection moulding with level trainee (unconfirmed)", async () => {
    const { svc } = makeIdentify();
    const first = await svc.identify(freshEnvelope(), "helper hoon", { sessionId: SESSION, workerId: WORKER } as never, "other");
    expect(first.offer?.prompt).toBe("Aap kis department me helper hain?");
    const envelope = { ...freshEnvelope(), needsDisambiguation: true, disambiguationOffer: first.offer!.chips, disambiguationPrompt: first.offer!.prompt, identifyAttempts: 1 } as ProfilingEnvelope;
    const second = await svc.identify(envelope, "Moulding", { sessionId: SESSION, workerId: WORKER } as never, "other");
    expect(second.patch.occupationFamilyId).toBe("fam_injection_moulding");
    const level = (second.patch.answerMap ?? []).find((a: { question_key: string }) => a.question_key === "moulding_level");
    expect(level).toBeDefined();
    expect((level as { value_normalized: string }).value_normalized).toBe("trainee");
  });

  it("a more exact phrase never routes (cnc turner operator pins turner)", async () => {
    const { svc } = makeIdentify();
    const result = await svc.identify(freshEnvelope(), "cnc turner operator", { sessionId: SESSION, workerId: WORKER } as never, "other");
    expect(result.pinned).not.toBeNull();
    expect(result.patch.occupationFamilyId).toBe("fam_cnc_turning");
    expect(result.offer).toBeNull();
  });

  it("offerChips false asks the routing question as plain text (AI-led, no chips, no spend)", async () => {
    const { svc } = makeIdentify();
    const result = await svc.identify(
      freshEnvelope(),
      "maintenance",
      { sessionId: SESSION, workerId: WORKER } as never,
      "other",
      { offerChips: false },
    );
    expect(result.offer).toBeNull();
    expect(result.prompt).toBe("Maintenance me aap kya dekhte hain?");
    expect(result.patch.identifyAttempts).toBeUndefined();
  });
});
