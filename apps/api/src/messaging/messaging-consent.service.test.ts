import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { ConsentRepository } from "../consent/consent.repository";
import { MessagingConsentService } from "./messaging-consent.service";

function repoWith(latest: unknown): ConsentRepository {
  return { findLatestByWorker: vi.fn().mockResolvedValue(latest) } as unknown as ConsentRepository;
}

describe("MessagingConsentService — whatsapp_messaging gate (fail-closed)", () => {
  it("true only when latest consent carries whatsapp_messaging and is not revoked", async () => {
    const svc = new MessagingConsentService(
      repoWith({ purposes: ["communication", "whatsapp_messaging"], revokedAt: null }),
    );
    expect(await svc.hasWhatsAppConsent("w1")).toBe(true);
  });

  it("false when the purpose is absent (communication alone does NOT authorize WhatsApp)", async () => {
    const svc = new MessagingConsentService(repoWith({ purposes: ["communication"], revokedAt: null }));
    expect(await svc.hasWhatsAppConsent("w1")).toBe(false);
  });

  it("false when the latest consent is revoked", async () => {
    const svc = new MessagingConsentService(
      repoWith({ purposes: ["whatsapp_messaging"], revokedAt: new Date() }),
    );
    expect(await svc.hasWhatsAppConsent("w1")).toBe(false);
  });

  it("false when the worker has no consent row", async () => {
    expect(await new MessagingConsentService(repoWith(undefined)).hasWhatsAppConsent("w1")).toBe(false);
  });

  it("fail-closed on a repository error (returns false, never throws)", async () => {
    const repo = { findLatestByWorker: vi.fn().mockRejectedValue(new Error("db down")) } as unknown as ConsentRepository;
    expect(await new MessagingConsentService(repo).hasWhatsAppConsent("w1")).toBe(false);
  });
});
