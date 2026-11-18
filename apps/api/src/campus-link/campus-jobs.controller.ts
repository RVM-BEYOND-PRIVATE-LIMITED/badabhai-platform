import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import type { z } from "zod";
import { RequestIdempotency } from "../common/idempotency/request-idempotency.service";
import { Ctx, type RequestContext } from "../common/request-context";
import { campusCall } from "./campus-errors";
import {
  CAMPUS_LINK_BASE_PATH,
  CampusCompanyQuerySchema,
  CampusPostForCompanyBodySchema,
  CampusPostingsQuerySchema,
} from "./campus-link.contract";
import { CampusIdempotencyKey, CampusZodPipe } from "./campus-request";
import { CampusServiceGuard } from "./campus-service.guard";
import { CampusPostingsService } from "./campus-postings.service";

/**
 * The Campus postings routes (#2752 part E), behind the Campus credential: the feed of jobs
 * marked for RVM students, posting for a company Campus created, and finding one. The review
 * decision (`PUT job-postings/:id/review`) is #2746's, mounted beside these.
 */
@Controller(CAMPUS_LINK_BASE_PATH)
@UseGuards(CampusServiceGuard)
export class CampusJobsController {
  constructor(
    private readonly postings: CampusPostingsService,
    private readonly idempotency: RequestIdempotency,
  ) {}

  /** Postings whose audience includes RVM students, by review state, branch, course and change. */
  @Get("job-postings")
  listPostings(
    @Query(new CampusZodPipe(CampusPostingsQuerySchema))
    query: z.infer<typeof CampusPostingsQuerySchema>,
  ) {
    return campusCall(() => this.postings.feed(query));
  }

  /**
   * The placement team posts for a company. A posting has no lasting ref of its own, so the
   * `Idempotency-Key` is held in Redis for the window: a retry inside it answers the first result,
   * never a second posting.
   */
  @Post("job-postings")
  @HttpCode(201)
  postForCompany(
    @Body(new CampusZodPipe(CampusPostForCompanyBodySchema))
    body: z.infer<typeof CampusPostForCompanyBodySchema>,
    @CampusIdempotencyKey() idempotencyKey: string,
    @Ctx() ctx: RequestContext,
  ) {
    return this.idempotency.runOnce({
      namespace: "campus_idem",
      scope: "post_job_posting",
      subject: "campus",
      idempotencyKey,
      logLabel: "Campus",
      subjectLabel: "caller",
      inFlight: () => {
        throw new ConflictException({ code: "REQUEST_IN_PROGRESS" });
      },
      work: () =>
        campusCall(async () => ({
          ...(await this.postings.postForCompany(body, ctx)),
          review_state: "approved" as const,
        })),
    });
  }

  /** A company Campus created with this phone, or `{ company: null }` for any other phone. */
  @Get("companies")
  async findCompany(
    @Query(new CampusZodPipe(CampusCompanyQuerySchema))
    query: z.infer<typeof CampusCompanyQuerySchema>,
  ) {
    return { company: await campusCall(() => this.postings.findCompany(query.phone)) };
  }
}
