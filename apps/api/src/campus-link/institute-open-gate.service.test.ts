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
const UNLOCK = "33333333-3333-4333-8333-333333333333";
/** A test stands in for the resolver: a tenant key is a string at run time. */
const OPENER = { tenant: COMPANY as never };
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
    hasAppliedToTenant: vi.fn(async () => opts.applied ?? false),
    hasAppliedToUnlockHolder: vi.fn(async () => opts.applied ?? false),
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
    expect(await subject.decide(WORKER, OPENER, CTX)).toBe("not_linked");
    expect(repo.hasAppliedToTenant).not.toHaveBeenCalled();
    expect(links.confirmConsent).not.toHaveBeenCalled();
  });

  it("is closed to a company he did not apply to, without re-reading his consent", async () => {
    const { subject, repo, links } = gate({ link: LINK, applied: false });
    expect(await subject.decide(WORKER, OPENER, CTX)).toBe("closed");
    expect(repo.hasAppliedToTenant).toHaveBeenCalledWith(WORKER, COMPANY);
    expect(links.confirmConsent).not.toHaveBeenCalled();
  });

  it("opens for a company he applied to while his consent stands", async () => {
    const { subject, links } = gate({ link: LINK, applied: true, consent: true });
    expect(await subject.decide(WORKER, OPENER, CTX)).toBe("open");
    expect(links.confirmConsent).toHaveBeenCalledWith(LINK, CTX);
  });

  it("asks about the holder of the unlock being revealed, by the unlock's id", async () => {
    const { subject, repo } = gate({ link: LINK, applied: true, consent: true });
    expect(await subject.decide(WORKER, { unlockId: UNLOCK }, CTX)).toBe("open");
    expect(repo.hasAppliedToUnlockHolder).toHaveBeenCalledWith(WORKER, UNLOCK);
    expect(repo.hasAppliedToTenant).not.toHaveBeenCalled();
  });

  it("is closed when his consent no longer stands", async () => {
    const { subject } = gate({ link: LINK, applied: true, consent: false });
    expect(await subject.decide(WORKER, OPENER, CTX)).toBe("closed");
  });

  it("fails closed when RVM is down", async () => {
    const { subject } = gate({
      link: LINK,
      applied: true,
      consent: new RvmStudentApiUnavailableError("timeout"),
    });
    expect(await subject.decide(WORKER, OPENER, CTX)).toBe("closed");
  });

  it("fails closed, never not_linked, when the link read itself fails", async () => {
    const { subject } = gate({ linkRead: new Error("connection reset") });
    expect(await subject.decide(WORKER, OPENER, CTX)).toBe("closed");
  });
});

describe("InstituteOpenGate.decide — #2887 moved students (STUDENT_MOVE_ENABLED on)", () => {
  function movedGate(opts: {
    moved: "visible" | "hidden" | null;
    link?: unknown;
    applied?: boolean;
    consent?: boolean;
    switchOn?: boolean;
  }) {
    const repo = {
      studentVisibilityOf: vi.fn(async () => opts.moved),
      findActiveByWorker: vi.fn(async () => opts.link),
      hasAppliedToTenant: vi.fn(async () => opts.applied ?? false),
      hasAppliedToUnlockHolder: vi.fn(async () => opts.applied ?? false),
      hasLiveGrantForTenant: vi.fn(async () => false),
      hasLiveGrantForUnlockHolder: vi.fn(async () => false),
    };
    const links = { confirmConsent: vi.fn(async () => opts.consent ?? false) };
    const subject = new InstituteOpenGate(
      repo as unknown as InstituteLinkRepository,
      links as unknown as InstituteLinkService,
      { STUDENT_MOVE_ENABLED: opts.switchOn ?? true },
    );
    return { subject, repo, links };
  }

  it("a visible moved student is an ordinary worker, even with an active link", async () => {
    const { subject, repo, links } = movedGate({ moved: "visible", link: LINK });
    expect(await subject.decide(WORKER, OPENER, CTX)).toBe("not_linked");
    expect(repo.findActiveByWorker).not.toHaveBeenCalled();
    expect(links.confirmConsent).not.toHaveBeenCalled();
  });

  it("a hidden moved student with no link opens only for a company he applied to, without RVM", async () => {
    const applied = movedGate({ moved: "hidden", applied: true });
    expect(await applied.subject.decide(WORKER, OPENER, CTX)).toBe("open");
    expect(applied.links.confirmConsent).not.toHaveBeenCalled();
    const stranger = movedGate({ moved: "hidden", applied: false });
    expect(await stranger.subject.decide(WORKER, OPENER, CTX)).toBe("closed");
    const reveal = movedGate({ moved: "hidden", applied: true });
    expect(await reveal.subject.decide(WORKER, { unlockId: UNLOCK }, CTX)).toBe("open");
    expect(reveal.repo.hasAppliedToUnlockHolder).toHaveBeenCalledWith(WORKER, UNLOCK);
  });

  it("a hidden moved student WITH a link follows #2752's rule exactly", async () => {
    const { subject, links } = movedGate({ moved: "hidden", link: LINK, applied: true, consent: true });
    expect(await subject.decide(WORKER, OPENER, CTX)).toBe("open");
    expect(links.confirmConsent).toHaveBeenCalledWith(LINK, CTX);
  });

  it("a worker who was never moved is unaffected", async () => {
    const { subject } = movedGate({ moved: null, link: undefined });
    expect(await subject.decide(WORKER, OPENER, CTX)).toBe("not_linked");
  });

  it("switch off: the visibility is never read", async () => {
    const { subject, repo } = movedGate({ moved: "visible", link: undefined, switchOn: false });
    expect(await subject.decide(WORKER, OPENER, CTX)).toBe("not_linked");
    expect(repo.studentVisibilityOf).not.toHaveBeenCalled();
  });
});
