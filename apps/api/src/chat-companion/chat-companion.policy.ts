import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { WorkerProfile } from "@badabhai/db";
import { SERVER_CONFIG } from "../config/config.module";
import { readGeneralFormCompletedAt } from "../profiling/conversation-state";
import { TRADE_FORM_KINDS } from "../profiling/trade-form-router";
import { WorkersRepository } from "../workers/workers.repository";
import { ChatCompanionRepository } from "./chat-companion.repository";

export type CompanionMode =
  | { readonly mode: "interview" }
  | { readonly mode: "companion"; readonly profile: WorkerProfile };

const INTERVIEW: CompanionMode = { mode: "interview" };

/**
 * WHO GETS THE COMPANION (ADR-0044) — decided on the server, from worker-level facts, on every
 * call. `interview` means "exactly what the chat tab does today"; it is the answer for every case
 * this rule is not certain about.
 *
 *   1. The flag is off → interview.
 *   2. The worker's CURRENT profile (`CURRENT_PROFILE_ORDER`) is not `confirmed` → interview.
 *      A redo interview's newer `extracted` row outranks an older `confirmed` one, so a worker
 *      part-way through a redo keeps today's path, including the "build my profile" button.
 *   3. The live chat session — the one `POST /chat/session` would reattach to — shows ACTIVITY
 *      AFTER that confirmation → interview. Activity is the later of its `started_at` and its
 *      `last_message_at`. A session minted after the confirmation is a deliberate new interview
 *      ("Chat se resume banayein"). Since #1744 an explicit redo (`redo: true`, sent by the app
 *      since #1769) never runs inside the early-finish leftover: `POST /chat/session` supersedes a
 *      live session that already became the confirmed profile and mints a fresh one, so the
 *      redo's `started_at` decides it from the first turn.
 *   4. A FORM HANDOVER still pending → interview (#1775). A redo that reached the trade-form
 *      offer ("Haan") or the general road's skills gate ("Nahi") ends its session and withholds
 *      extraction until the form is done, so rules 2 and 3 both pass and the recap would describe
 *      the OLD profile. Pending means all of:
 *        - the form is still SERVED from that session: it is the row the form API itself resolves
 *          (`latestSessionFormKind` / `latestGeneralHandover` mirror `TradeFormService` and
 *          `GeneralFormService`), with a declared trade `form_kind` or the general stamp;
 *        - that session CLOSED after the current confirmation;
 *        - the form is not finished: no résumé has been GENERATED since the handover (the exit of
 *          every form walk — the trade form's building screen generates one, and the general
 *          form's brief leads to extract → confirm → generate), and for the general form no
 *          `general_form_completed_at` mark (the chat's fail-soft reader: unreadable = not done).
 *      A redo worker who finishes the trade form keeps his old confirmed profile — the building
 *      screen regenerates the résumé on it and nothing re-confirms — so the résumé, not a
 *      confirmation, is what retires the handover. In interview mode the chat resumes the handover
 *      session: its done CTA extracts it with source `form` and the confirm routes to the trade
 *      form (ADR-0042), and the general card is re-served from the stamp.
 *   5. Otherwise → companion. A live session whose every clock predates the confirmation is the
 *      early-finish leftover ("Phir bhi profile banaiye" → preview → confirm, which never ends the
 *      session); it does not block the companion, and a redo or the abandonment sweep closes it.
 *
 * TD143 — CLOSED BY #1760 (SERVER) AND #1769 (APP). The `last_message_at` half of rule 3 exists
 * for a redo REATTACHED to the leftover, whose first four answers move no clock this module can
 * read (the per-turn transcript lives in the chat module's Redis buffer). A redo reattaches to it
 * when the app does not send `redo: true` (every build before #1769) or when the supersede fails;
 * the half stays for exactly those cases.
 *
 * Not "any live session blocks": that would leave the most common chat-road completion — the
 * early finish — silent for the hours until the sweep. Not "a résumé exists": a redo in progress
 * has one, and the companion would then hide that redo's confirm path.
 *
 * FAILS TO `interview` on any read error, with a PII-free warn. Interview is today's behaviour,
 * so the safe failure costs the worker the recap, never their chat.
 */
/** A declared trade form — one `GET /profiling/form` can actually serve. */
function isTradeFormKind(kind: string | null): boolean {
  return kind !== null && (TRADE_FORM_KINDS as readonly string[]).includes(kind);
}

/** When a handover session closed, if it closed AFTER `confirmedAt` — else null. */
function closedAfter(
  session: { readonly status: string; readonly endedAt: Date | null },
  confirmedAt: Date,
): Date | null {
  if (session.status === "active" || session.endedAt === null) return null;
  return session.endedAt.getTime() > confirmedAt.getTime() ? session.endedAt : null;
}

@Injectable()
export class ChatCompanionPolicy {
  private readonly logger = new Logger(ChatCompanionPolicy.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly workers: WorkersRepository,
    private readonly repo: ChatCompanionRepository,
  ) {}

  async resolve(workerId: string): Promise<CompanionMode> {
    if (!this.config.CHAT_COMPANION_ENABLED) return INTERVIEW;
    try {
      const profile = await this.workers.latestProfile(workerId);
      if (!profile || profile.profileStatus !== "confirmed" || !profile.confirmedAt) return INTERVIEW;
      const live = await this.repo.latestActiveSession(workerId);
      if (live !== null) {
        const activity = Math.max(live.startedAt.getTime(), live.lastMessageAt?.getTime() ?? 0);
        if (activity > profile.confirmedAt.getTime()) return INTERVIEW;
      }
      if (await this.formHandoverPending(workerId, profile.confirmedAt)) return INTERVIEW;
      return { mode: "companion", profile };
    } catch (err) {
      this.logger.warn(
        `companion mode unreadable for worker ${workerId}; serving interview (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
      return INTERVIEW;
    }
  }

  /** Rule 4 — see the class header. Throws on a read error; `resolve` turns that into interview. */
  private async formHandoverPending(workerId: string, confirmedAt: Date): Promise<boolean> {
    const [latest, general] = await Promise.all([
      this.repo.latestSessionFormKind(workerId),
      this.repo.latestGeneralHandover(workerId),
    ]);
    const handedOverAt: Date[] = [];
    if (latest !== null && isTradeFormKind(latest.formKind)) {
      const at = closedAfter(latest, confirmedAt);
      if (at !== null) handedOverAt.push(at);
    }
    if (
      general !== null &&
      readGeneralFormCompletedAt({ general_form_completed_at: general.generalFormCompletedAt }) ===
        null
    ) {
      const at = closedAfter(general, confirmedAt);
      if (at !== null) handedOverAt.push(at);
    }
    for (const at of handedOverAt) {
      if (!(await this.repo.resumeGeneratedAfter(workerId, at))) return true;
    }
    return false;
  }
}
