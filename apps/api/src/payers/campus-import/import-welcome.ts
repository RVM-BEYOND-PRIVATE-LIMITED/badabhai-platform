/**
 * #2754 item 10 — welcome credits on move day. Each company the batch placed is offered #2750's
 * welcome grant through its one grant function (`WelcomeCreditsService.afterCompanyImported`,
 * trigger `company_import`): 5 credits for 30 days, ONCE ever per company, only when the company
 * is verified (approved on Campus), has a GSTIN or a proven phone, and has an approved posting (an
 * imported live job approved on Campus counts, `WelcomeCreditsRepository`). Behind the
 * `credit_rules` switch, per company: off, nothing is granted (`rules_off`).
 *
 * The sign-up grant (`FreeTierService`) never fires for a moved company: the import creates
 * accounts with `PayersRepository.createOrGet`, not the sign-up path.
 *
 * Runs after the jobs step, so the approved posting exists. The grant never fails the import: an
 * error is the service's own `failed` outcome, and a later trigger for the company retries.
 */
import type { RequestContext } from "../../common/request-context";
import type { WelcomeCreditsOutcome } from "../../credit-rules/welcome-credits.service";

export interface WelcomeOffer {
  afterCompanyImported(companyId: string, ctx: RequestContext): Promise<WelcomeCreditsOutcome>;
}

export type WelcomeImportSummary = Partial<Record<WelcomeCreditsOutcome, number>>;

/** Offer the welcome grant to every placed company (Campus id → BadaBhai account), once each. */
export async function offerWelcomeCredits(
  welcome: WelcomeOffer,
  placedCompanies: ReadonlyMap<string, string>,
  ctx: RequestContext,
): Promise<WelcomeImportSummary> {
  const summary: WelcomeImportSummary = {};
  for (const payerId of new Set(placedCompanies.values())) {
    const outcome = await welcome.afterCompanyImported(payerId, ctx);
    summary[outcome] = (summary[outcome] ?? 0) + 1;
  }
  return summary;
}
