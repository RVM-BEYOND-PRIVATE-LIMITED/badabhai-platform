import { Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import type { Payer } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { PayersRepository } from "./payers.repository";
import { PayerMeSchema, type PayerMeDto, type PayerUpdateDto } from "./payer-account.dto";

/**
 * SELF-scoped reads + edits for an authenticated payer (ADR-0019 LC-1; PROF-1 / PROF-3).
 *
 * The `payerId` arrives ONLY from the {@link import("./payer-auth.guard").PayerAuthGuard}
 * principal (the controller passes `@CurrentPayer().id`) — never from the request
 * body/param/query. There is therefore no parameter an attacker can vary to reach another
 * payer's account: every read/write is bound to the caller's own id. (The `payer-scope.ts`
 * ownership chokepoint is for rows fetched by a non-identity key; here the key IS the
 * authenticated identity, so the binding is the guard itself.)
 *
 * PII: `orgName`, `email`, and the MASKED `phoneLast4` are the payer's OWN contact data,
 * decrypted from the `payers` ciphertext columns and returned to that payer ONLY. They are
 * NOT emitted to an event and NOT logged (invariant #2 / B-R2) — the `payer.account_updated`
 * event records only the opaque `payer_id` + the changed field KEYS. A decrypt failure fails
 * CLOSED (generic 500) — ciphertext/crypto internals are never surfaced.
 */
@Injectable()
export class PayerAccountService {
  constructor(
    private readonly payers: PayersRepository,
    private readonly events: EventsService,
  ) {}

  /** The authenticated payer's own `{ id, role, status, orgName, email, phoneLast4 }`. */
  async getOwnAccount(authPayerId: string): Promise<PayerMeDto> {
    const row = await this.payers.findById(authPayerId);
    // A valid session whose payer row is gone → neutral not-found (no oracle).
    if (!row) throw new NotFoundException("Payer account not found");
    return this.toMaskedDto(row);
  }

  /**
   * Self-edit the authenticated payer's OWN org display name and/or contact phone (PROF-3,
   * `PATCH /payer/me`). `patch` is the already-validated `PayerUpdateSchema` body (≥1 field;
   * org-name 2..120 graphemes; phone strict E.164). Persists via the repo (org/phone are
   * re-encrypted, and `phoneHash` refreshed when phone changes), THEN emits the event AFTER a
   * successful write, THEN returns the freshly-masked DTO.
   *
   * `authPayerId` is the GUARD principal only — a body `payer_id` is rejected upstream as an
   * unknown key (`.strict()`), so the write can never bind to another payer. A foreign/unknown
   * id matches no row → neutral 404 (no oracle). A decrypt failure fails CLOSED (generic 500).
   */
  async updateOwnAccount(
    authPayerId: string,
    patch: PayerUpdateDto,
    ctx: RequestContext,
  ): Promise<PayerMeDto> {
    // The field KEYS that actually changed (KEYS only — NEVER the values). Derived from the
    // validated body, so it can only ever be a non-empty subset of {org_name, phone}.
    const changedFields: ("org_name" | "phone")[] = [];
    if (patch.orgName !== undefined) changedFields.push("org_name");
    if (patch.phone !== undefined) changedFields.push("phone");

    const updated = await this.payers.update(authPayerId, {
      orgName: patch.orgName,
      phone: patch.phone,
    });
    // The principal's row is gone (or the id matched nothing) → neutral 404 (no oracle).
    if (!updated) throw new NotFoundException("Payer account not found");

    // Event-first (invariant #1): emitted AFTER the successful write. PII-free (invariant #2):
    // the opaque `payer_id` + the changed field KEYS ONLY — never the new org-name/phone VALUES.
    await this.events.emit({
      event_name: "payer.account_updated",
      actor: { actor_type: "payer", actor_id: authPayerId },
      subject: { subject_type: "payer", subject_id: authPayerId },
      payload: { payer_id: authPayerId, changed_fields: changedFields },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return this.toMaskedDto(updated);
  }

  /**
   * Decrypt a payer's own row and shape the masked self-view DTO (shared by read + edit).
   * The phone is masked to its last 4 digits; the raw E.164 number is never returned. A
   * decrypt failure fails CLOSED — a generic 500 that NEVER leaks ciphertext or crypto
   * internals (the org-name/phone/email are never logged here either).
   */
  private toMaskedDto(row: Payer): PayerMeDto {
    let contact;
    try {
      contact = this.payers.decryptContact(row);
    } catch {
      throw new InternalServerErrorException("Could not load account");
    }

    // Mask the phone to its last 4 digits (or null when none is set). Digits-only so any
    // formatting in the stored value can't shift it.
    const phoneDigits = contact.phone?.replace(/\D/g, "") ?? "";
    const phoneLast4 = phoneDigits.length >= 4 ? phoneDigits.slice(-4) : null;

    return PayerMeSchema.parse({
      id: contact.id,
      role: contact.role,
      status: contact.status,
      orgName: contact.orgName,
      email: contact.email,
      phoneLast4,
    });
  }
}
