import { describe, expect, it, vi } from "vitest";
import type { RequestContext } from "../common/request-context";
import type { InstituteLinkRepository } from "./institute-link.repository";
import type { InstituteLinkService } from "./institute-link.service";
import { InstituteOpenGate } from "./institute-open-gate.service";
import { RvmStudentApiUnavailableError } from "./rvm-student-api.client";

/** #2752 item 9 — the verdict the unlock and résumé chokepoints act on. Fails closed. */
const CTX: RequestContext = { correlationId: "corr-1", requestId: "req-1" };
const WORKER = "22222222-2222-4222-8222-222222222222";
const COMPANY = "11111111-1111-4111-8111-111111111111";
const LINK = { workerId: WORKER, studentRef: "3c9e7b21-4f6a-4d8e-b1c2-a3d4e5f60718" };

function gate(opts: {
  link?: unknown;
  linkRead?: Error;
  applied?: boolean;
  consent?: boolean | Error;
}) {
  const repo = {
    findActiveByWorker: vi.fn(async () => {
      if (opts.linkRead) throw opts.linkRead;
      return opts.link;
    }),
    hasAppliedToOwner: vi.fn(async () => opts.applied ?? false),
  };
  const links = {
    confirmConsent: vi.fn(async () => {
      if (opts.consent instanceof Error) throw opts.consent;
      return opts.consent ?? false;
    }),
  };
  const subject = new InstituteOpenGate(
    repo as unknown as InstituteLinkRepository,
    links as unknown as InstituteLinkService,
  );
  return { subject, repo, links };
}

describe("InstituteOpenGate.decide", () => {
  it("says not_linked for a worker with no active link, and asks nothing else", async () => {
    const { subject, repo, links } = gate({ link: undefined });
    expect(await subject.decide(WORKER, COMPANY, CTX)).toBe("not_linked");
    expect(repo.hasAppliedToOwner).not.toHaveBeenCalled();
    expect(links.confirmConsent).not.toHaveBeenCalled();
  });

  it("is closed to a company he did not apply to, without re-reading his consent", async () => {
    const { subject, repo, links } = gate({ link: LINK, applied: false });
    expect(await subject.decide(WORKER, COMPANY, CTX)).toBe("closed");
    expect(repo.hasAppliedToOwner).toHaveBeenCalledWith(WORKER, COMPANY);
    expect(links.confirmConsent).not.toHaveBeenCalled();
  });

  it("opens for a company he applied to while his consent stands", async () => {
    const { subject, links } = gate({ link: LINK, applied: true, consent: true });
    expect(await subject.decide(WORKER, COMPANY, CTX)).toBe("open");
    expect(links.confirmConsent).toHaveBeenCalledWith(LINK, CTX);
  });

  it("is closed when his consent no longer stands", async () => {
    const { subject } = gate({ link: LINK, applied: true, consent: false });
    expect(await subject.decide(WORKER, COMPANY, CTX)).toBe("closed");
  });

  it("fails closed when RVM is down", async () => {
    const { subject } = gate({
      link: LINK,
      applied: true,
      consent: new RvmStudentApiUnavailableError("timeout"),
    });
    expect(await subject.decide(WORKER, COMPANY, CTX)).toBe("closed");
  });

  it("fails closed, never not_linked, when the link read itself fails", async () => {
    const { subject } = gate({ linkRead: new Error("connection reset") });
    expect(await subject.decide(WORKER, COMPANY, CTX)).toBe("closed");
  });
});
