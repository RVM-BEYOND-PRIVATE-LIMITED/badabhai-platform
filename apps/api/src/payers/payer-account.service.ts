import { Injectable, NotFoundException } from "@nestjs/common";
import { PayersRepository } from "./payers.repository";
import { PayerMeSchema, type PayerMeDto } from "./payer-account.dto";

/**
 * SELF-scoped reads for an authenticated payer (ADR-0019 LC-1, slice 1).
 *
 * The `payerId` arrives ONLY from the {@link import("./payer-auth.guard").PayerAuthGuard}
 * principal (the controller passes `@CurrentPayer().id`) — never from the request
 * body/param/query. There is therefore no parameter an attacker can vary to reach
 * another payer's account: the read is bound to the caller's own id. (The
 * `payer-scope.ts` ownership chokepoint is for rows fetched by a non-identity key;
 * here the key IS the authenticated identity, so the binding is the guard itself.)
 *
 * PII: `orgName` is the payer's own label and is returned to them only. It is NOT
 * emitted to an event and NOT logged (invariant #2 / B-R2). This is a read; per the
 * event-first rule it is not an important state change, so it emits no event.
 */
@Injectable()
export class PayerAccountService {
  constructor(private readonly payers: PayersRepository) {}

  /** The authenticated payer's own `{ id, role, status, orgName }`. */
  async getOwnAccount(authPayerId: string): Promise<PayerMeDto> {
    const row = await this.payers.findById(authPayerId);
    // A valid session whose payer row is gone → neutral not-found (no oracle).
    if (!row) throw new NotFoundException("Payer account not found");

    const contact = this.payers.decryptContact(row);
    return PayerMeSchema.parse({
      id: contact.id,
      role: contact.role,
      status: contact.status,
      orgName: contact.orgName,
    });
  }
}
