import { Inject, Injectable } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { WorkersRepository } from "../workers/workers.repository";

/**
 * The reserved DEMO phone block: `+910000026` + three digits. It is the same block the demo seed
 * (`packages/db/src/demo-matching-plan.ts` `DEMO_PHONE_PATTERN`, #2013) gives its personas, and
 * it lies inside the reserved synthetic range no real SIM is issued (`+91` + five zeros + five
 * digits). Duplicated here only until #2013 lands; then import it, so there is one definition.
 */
export const DEMO_PHONE_BLOCK_PREFIX = "+910000026";
export const DEMO_PHONE_BLOCK_SIZE = 1000;

/** Every phone in the demo block, `+910000026000` … `+910000026999`. */
export function demoBlockPhones(): string[] {
  return Array.from(
    { length: DEMO_PHONE_BLOCK_SIZE },
    (_, i) => `${DEMO_PHONE_BLOCK_PREFIX}${String(i).padStart(3, "0")}`,
  );
}

/**
 * WHO THE ENGINE VIEW MAY SHOW — owner ruling 2026-10-06 (DPDP purpose limitation): the investor
 * demo shows DEMO WORKERS ONLY, enforced on the server and FAIL-CLOSED.
 *
 * A demo worker is one whose `workers.phone_hash` is the peppered hash of a phone in the reserved
 * demo block, or of a handset named in `ADMIN_ENGINE_VIEW_ALLOW_PHONES` (the owner's demo phone).
 * Phones are encrypted at rest, so membership is decided on the HASH: the set is computed once
 * here with the server's own pepper (≈1,000 HMACs at boot) and resolved to worker IDS through the
 * workers domain (`WorkersRepository.findLiveIdsByPhoneHashes`, a seek on `workers_phone_hash_uq`).
 * The admin queries then filter on those ids only: nothing under `admin/**` names a phone column
 * (`admin-static-guards.test.ts`). No phone is decrypted, selected, returned or logged.
 *
 * Anything outside the set is indistinguishable from an unknown id (the uniform neutral 404).
 */
@Injectable()
export class AdminEngineDemoGate {
  private readonly hashes: readonly string[];

  constructor(
    @Inject(SERVER_CONFIG) config: ServerConfig,
    pii: PiiCryptoService,
    private readonly workers: WorkersRepository,
  ) {
    const phones = new Set([...demoBlockPhones(), ...config.ADMIN_ENGINE_VIEW_ALLOW_PHONES]);
    this.hashes = Object.freeze([...phones].map((p) => pii.hashPhone(p)));
  }

  /** The peppered phone hashes of every phone the Engine view may show. Never empty. */
  demoPhoneHashes(): readonly string[] {
    return this.hashes;
  }

  /**
   * The ids of the LIVE demo workers right now. Read per request (the demo seed and a live
   * onboarding can add one at any moment); empty when none exist, which every caller treats as
   * "show nobody" — the gate fails closed.
   */
  async demoWorkerIds(): Promise<readonly string[]> {
    return this.workers.findLiveIdsByPhoneHashes(this.hashes);
  }
}
