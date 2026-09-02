import { Body, Controller, Get, Put, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import { MatchingCatalogService } from "./matching-catalog.service";
import { PublishCatalogSchema, type PublishCatalogDto } from "./matching-catalog.dto";

/**
 * The matching-catalog config surface — RVM-ratified domain truth (spec §D step 2).
 * Thin HTTP layer: envelope validation via ZodValidationPipe, the catalog gate and
 * every rejection in the service.
 *
 * ============================================================================
 * BOTH ROUTES ARE GATED. THIS IS THE R31 LESSON, APPLIED BEFORE THE BUG.
 * ============================================================================
 * R31 was `PUT /pricing/catalog` and `GET /pricing/catalog` shipping COMPLETELY
 * UNAUTHENTICATED — the write published a pricing revision, and the read returned the
 * whole catalog including coupon codes and caps. It sat open long enough to become the
 * dominant pricing-manipulation vector, and the register still read OPEN for weeks
 * after the fix landed (TD125).
 *
 * The same two shapes exist here and both matter:
 *   WRITE — publishing a catalog silently changes, platform-wide, which workers are
 *           visible for which jobs. It is every bit as sensitive as changing a price.
 *   READ  — the catalog is the entire adjacency graph and multiplier set. Handing it
 *           to an anonymous caller hands over exactly how to phrase a job posting to
 *           reach a pool the poster should not reach.
 *
 * `InternalServiceGuard` is applied at CLASS level, not per-route, so a route added
 * later inherits the guard instead of silently shipping open — which is the specific
 * mistake R31 was. The guard fails closed: with no `INTERNAL_SERVICE_TOKEN` configured,
 * every request is denied.
 */
@UseGuards(InternalServiceGuard)
@Controller("matching-catalog")
export class MatchingCatalogController {
  constructor(private readonly catalog: MatchingCatalogService) {}

  /**
   * The active, validated catalog. Returns `{ active: false }` when none is published
   * — the honest state while rulings R1-R4 are open. Never falls back to the fixture.
   */
  @Get()
  get() {
    return this.catalog.getActiveCatalog();
  }

  /**
   * Publish a new catalog revision. 400 with every offending path if the catalog fails
   * validation — and it is never stored, so it can never become active.
   */
  @Put()
  publish(
    @Body(new ZodValidationPipe(PublishCatalogSchema)) dto: PublishCatalogDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.catalog.publish(dto, ctx);
  }
}
