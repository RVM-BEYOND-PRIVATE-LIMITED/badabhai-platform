import { Body, Controller, Get, Put, Query } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PricingService } from "./pricing.service";
import {
  UpdateCatalogSchema,
  QuoteQuerySchema,
  type UpdateCatalogDto,
  type QuoteQueryDto,
} from "./pricing.dto";

/**
 * Config-driven Pricing Engine surface (ADR-0013 Decision A) — the "config
 * builder". Thin HTTP layer: validation via ZodValidationPipe, all logic + the
 * fail-closed catalog handling + the `pricing.changed` event in the service.
 *
 * Ops-only by intent (catalog edits). No real ops-auth seam exists in alpha — the
 * acting ops actor is supplied as `updated_by` on the body (same posture as
 * job_postings). A `PricingAdminGuard`/InternalServiceGuard is a launch gate.
 */
@Controller("pricing")
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  /** The active, validated catalog (fail-closed `source` flag tells ops if a stored row was rejected). */
  @Get("catalog")
  getCatalog() {
    return this.pricing.getActiveCatalog();
  }

  /** Publish a new catalog revision. 400 if the catalog fails validation (never stored). */
  @Put("catalog")
  updateCatalog(
    @Body(new ZodValidationPipe(UpdateCatalogSchema)) dto: UpdateCatalogDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.pricing.updateCatalog(dto, ctx);
  }

  /** Preview a resolved price (config-builder preview / purchase quote). */
  @Get("quote")
  quote(@Query(new ZodValidationPipe(QuoteQuerySchema)) query: QuoteQueryDto) {
    return this.pricing.quote(query);
  }
}
