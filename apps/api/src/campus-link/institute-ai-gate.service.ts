import { Injectable } from "@nestjs/common";
import { ConsentRepository } from "../consent/consent.repository";
import { hasActiveConsent } from "../consent/consent-active";
import { InstituteLinkRepository } from "./institute-link.repository";

/**
 * An actively linked institute student has not given BadaBhai's own consent, so no AI work may
 * run for him: no prompt, no `ai_call_traces` row, no embedding (#2752 item 13). Thrown before
 * the call, never after.
 */
export class InstituteAiRefusedError extends Error {
  constructor() {
    super("no AI work for an institute student without BadaBhai's own consent");
    this.name = "InstituteAiRefusedError";
  }
}

/**
 * The AI rule for a linked student (#2752 item 13), active or withdrawn: a withdrawn link means
 * RVM's consent is gone too, never that BadaBhai's was given. His RVM consent covers only the
 * companies he applies to; it says nothing about profile extraction, the chat, companion memory,
 * résumé generation, embeddings or the training corpus, and production sends raw names and phones
 * to the model (ADR-0047). So AI work for him needs BadaBhai's own consent: an unrevoked latest
 * `worker_consents` row, which only his own worker-app sign-in can write.
 *
 * WHERE IT IS ASKED. Every worker-keyed AI call that can run without the worker's own request:
 * the queue jobs and the services an operator, an admin correction or a sweep can start (see
 * `ai-consumers.static.test.ts`, which lists every `AiService` consumer and how it is covered).
 * A worker-app route reaches AI only through `ConsentGuard`, which already fails closed for a
 * worker with no consent row.
 *
 * A worker who is not linked is unaffected: one primary-key read, then nothing. A read error
 * propagates, so no AI call follows it (fail closed).
 */
@Injectable()
export class InstituteAiGate {
  constructor(
    private readonly links: InstituteLinkRepository,
    private readonly consents: ConsentRepository,
  ) {}

  /** @throws InstituteAiRefusedError — linked (now or before), and no active BadaBhai consent. */
  async assertMayRunAi(workerId: string): Promise<void> {
    if (!(await this.links.hasAnyLink(workerId))) return;
    if (await hasActiveConsent(this.consents, workerId)) return;
    throw new InstituteAiRefusedError();
  }
}
