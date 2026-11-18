import { describe, expect, it, vi } from "vitest";
import type { ConsentRepository } from "../consent/consent.repository";
import { InstituteAiGate, InstituteAiRefusedError } from "./institute-ai-gate.service";
import type { InstituteLinkRepository } from "./institute-link.repository";

/** #2752 item 13 — no AI for a linked student until BadaBhai's own consent exists. */
const WORKER = "22222222-2222-4222-8222-222222222222";

function gate(opts: { linked: boolean; consent?: { revokedAt: Date | null } | Error }) {
  const links = {
    hasAnyLink: vi.fn(async () => opts.linked),
  };
  const consents = {
    findLatestByWorker: vi.fn(async () => {
      if (opts.consent instanceof Error) throw opts.consent;
      return opts.consent === undefined ? undefined : { purposes: [], ...opts.consent };
    }),
  };
  const subject = new InstituteAiGate(
    links as unknown as InstituteLinkRepository,
    consents as unknown as ConsentRepository,
  );
  return { subject, links, consents };
}

describe("InstituteAiGate.assertMayRunAi", () => {
  it("lets a worker who is not linked through, without reading his consent", async () => {
    const { subject, consents } = gate({ linked: false });
    await expect(subject.assertMayRunAi(WORKER)).resolves.toBeUndefined();
    expect(consents.findLatestByWorker).not.toHaveBeenCalled();
  });

  it("refuses a linked student with no BadaBhai consent row", async () => {
    const { subject } = gate({ linked: true });
    await expect(subject.assertMayRunAi(WORKER)).rejects.toBeInstanceOf(InstituteAiRefusedError);
  });

  it("refuses a linked student whose BadaBhai consent is revoked", async () => {
    const { subject } = gate({ linked: true, consent: { revokedAt: new Date() } });
    await expect(subject.assertMayRunAi(WORKER)).rejects.toBeInstanceOf(InstituteAiRefusedError);
  });

  it("refuses when his consent cannot be read (fail closed)", async () => {
    const { subject } = gate({ linked: true, consent: new Error("connection reset") });
    await expect(subject.assertMayRunAi(WORKER)).rejects.toBeInstanceOf(InstituteAiRefusedError);
  });

  it("lets a linked student through once he has accepted BadaBhai's own consent", async () => {
    const { subject } = gate({ linked: true, consent: { revokedAt: null } });
    await expect(subject.assertMayRunAi(WORKER)).resolves.toBeUndefined();
  });

  it("lets a failed link read propagate, so no AI call follows it", async () => {
    const { subject, links } = gate({ linked: false });
    links.hasAnyLink.mockRejectedValueOnce(new Error("connection reset"));
    await expect(subject.assertMayRunAi(WORKER)).rejects.toThrow("connection reset");
  });
});
