import { Inject, Injectable } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { ReferralLink } from "@badabhai/db";
import { SERVER_CONFIG } from "../config/config.module";
import { isUniqueViolation } from "../common/db-error";
import { EventsService } from "../events/events.service";
import { ReferralLinkRepository } from "./referral-link.repository";
import { freshReferralCode } from "./referral-resolve";

/**
 * How many fresh codes a résumé-QR mint tries before it gives up. A 48-bit code collides with a
 * live one essentially never; the bound exists so a pathological state (or a broken random
 * source) can never spin a render job. Exhaustion throws, and the render falls back to the
 * homepage QR.
 */
export const RESUME_QR_MINT_ATTEMPTS = 3;

/** Raised when every bounded résumé-QR mint attempt collided. Carries no code and no id. */
export class ResumeQrMintExhaustedError extends Error {
  constructor() {
    super("résumé QR link mint exhausted its collision retries");
    this.name = "ResumeQrMintExhaustedError";
  }
}

/**
 * THE RÉSUMÉ QR's LINK (#1800, owner ruling 2026-09-28 "Count + attribute worker signups") — the
 * one `referral_links` row of kind `resume_qr` a worker owns, whose `/r/<code>` their OWN résumé
 * QR encodes.
 *
 * ITS OWN CLASS, AND THAT IS LOAD-BEARING. The render processor may reach no event surface beyond
 * what it strictly needs (its TD5 security test). This class is the whole of what it gets: one
 * method, whose only emit is `referral.link_created` with a fixed, strict payload of ids and closed
 * enums — no name, no phone, nothing the render decrypted can reach it, because nothing but the
 * worker id is passed in. The resolver and the claim stay in `ReferralLinkService`, out of reach.
 *
 * NEVER COMMISSIONED (`isCommissionedLinkKind` in @badabhai/types). The attribution hook stops a
 * `resume_qr` code before either paying seam; money reads only `invites` / `agency_invites`.
 */
@Injectable()
export class ResumeQrLinkService {
  constructor(
    private readonly repo: ReferralLinkRepository,
    private readonly events: EventsService,
    @Inject(SERVER_CONFIG)
    private readonly config: Pick<ServerConfig, "RESUME_QR_SCAN_ENABLED">,
  ) {}

  /** `RESUME_QR_SCAN_ENABLED`. Only `true` turns the mint on; unset is off. */
  get enabled(): boolean {
    return this.config.RESUME_QR_SCAN_ENABLED === true;
  }

  /**
   * The code the worker's OWN résumé QR encodes: get-or-create their single `resume_qr` link.
   * Null while RESUME_QR_SCAN_ENABLED is off, with NO query — the sheet is then exactly today's and
   * migration 0129 need not be applied.
   *
   * STABLE ACROSS RE-RENDERS. The first render mints; every later render (forced or not) reads the
   * same row back, so a sheet printed last month and one printed today carry the same code.
   *
   * CONCURRENCY. Two renders for one worker can race. The insert is `ON CONFLICT DO NOTHING` on the
   * per-owner partial unique index, so the loser inserts nothing and re-selects the winner's row;
   * exactly one `referral.link_created` is emitted, by the winner.
   *
   * COLLISIONS. A fresh code is checked against all THREE code spaces (`referral_links`, `invites`,
   * `agency_invites`) before the insert — the resolver and the attribution hook treat them as one
   * namespace — and a `23505` on `referral_links_code_uq` (a race past that check) is retried.
   * Bounded: exhaustion throws {@link ResumeQrMintExhaustedError}.
   *
   * EVENT. `referral.link_created` with a SYSTEM actor: the render worker minted it; the worker
   * took no action. Kind + medium + the row id; never the code.
   *
   * MAY THROW (the flag on before 0129 is applied fails the CHECK, a DB outage, exhaustion). The
   * render worker degrades every throw to the homepage QR — the QR must never cost the PDF.
   */
  async codeFor(ownerWorkerId: string): Promise<string | null> {
    if (!this.enabled) return null;

    const existing = await this.repo.findResumeQrLink(ownerWorkerId);
    if (existing) return existing.code;

    for (let attempt = 0; attempt < RESUME_QR_MINT_ATTEMPTS; attempt += 1) {
      const code = freshReferralCode();
      if (await this.repo.isCodeTaken(code)) continue;

      let row: ReferralLink | undefined;
      try {
        // THE ROW AND ITS EVENT IN ONE TRANSACTION: a failed emit rolls the insert back, so a live
        // bearer code never exists without its `referral.link_created` (the agency-mint lesson).
        row = await this.repo.withTransaction(async (tx) => {
          const inserted = await this.repo.insertResumeQrLink({ code, ownerWorkerId }, tx);
          if (inserted) {
            await this.events.emit({
              event_name: "referral.link_created",
              actor: { actor_type: "system", actor_id: null },
              subject: { subject_type: "referral_link", subject_id: inserted.id },
              payload: {
                referral_link_id: inserted.id,
                kind: "resume_qr",
                medium: inserted.medium,
              },
              idempotencyKey: `referral.link_created:${inserted.id}`,
              tx,
            });
          }
          return inserted;
        });
      } catch (err) {
        // ONLY a code collision is retryable. The per-owner index cannot raise here (it is the
        // ON CONFLICT target), and the event carries its own idempotency key on a fresh row id,
        // so the one 23505 reachable is `referral_links_code_uq`. Anything else — the pre-0129
        // CHECK (23514), a missing index (42P10), an invalid event, an outage — propagates.
        if (isUniqueViolation(err)) continue;
        throw err;
      }

      if (row) return row.code;

      // Lost the race to a concurrent render: that render minted (and evented) the one link.
      const winner = await this.repo.findResumeQrLink(ownerWorkerId);
      if (winner) return winner.code;
      // The winner vanished between the conflict and the read (the worker was erased mid-render).
      // No worker, no QR — the render falls back.
      throw new Error("résumé QR link conflicted but could not be re-read");
    }
    throw new ResumeQrMintExhaustedError();
  }
}
