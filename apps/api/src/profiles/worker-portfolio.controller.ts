import { Body, Controller, Get, Header, HttpCode, Post, Put, UseGuards } from "@nestjs/common";

import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ConsentGuard } from "../auth/consent.guard";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import {
  PortfolioUploadUrlSchema,
  SetMyPortfolioSchema,
  type MyPortfolioResponse,
  type PortfolioUploadUrlDto,
  type SetMyPortfolioDto,
} from "./worker-portfolio.dto";
import { WorkerPortfolioService } from "./worker-portfolio.service";

/**
 * The worker's portfolio — work samples (ADR-0042 D9 / Layer A (e), migration 0113).
 *
 * Worker id from `@CurrentWorker`, never the body or the path. PUT replaces the whole list, so
 * reorder/delete need no separate routes (the qualifications precedent).
 */
@Controller("workers")
export class WorkerPortfolioController {
  constructor(private readonly portfolio: WorkerPortfolioService) {}

  /** Mint a signed upload for one photo/video. 503 while the bucket is dormant. */
  @Post("me/portfolio/upload-url")
  @HttpCode(201)
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  async createUploadUrl(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(PortfolioUploadUrlSchema)) dto: PortfolioUploadUrlDto,
  ): Promise<{ upload_url: string; storage_key: string; expires_in: number }> {
    return this.portfolio.createUploadUrl(worker.id, dto);
  }

  /** The caller's samples, media as short-lived signed URLs. `no-store`: URLs are credentials. */
  @Get("me/portfolio")
  @Header("Cache-Control", "no-store")
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  async getMyPortfolio(@CurrentWorker() worker: AuthenticatedWorker): Promise<MyPortfolioResponse> {
    return this.portfolio.getForWorker(worker.id);
  }

  @Put("me/portfolio")
  @HttpCode(200)
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  async setMyPortfolio(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(SetMyPortfolioSchema)) dto: SetMyPortfolioDto,
    @Ctx() ctx: RequestContext,
  ): Promise<{ ok: true; item_count: number }> {
    const result = await this.portfolio.replaceForWorker(worker.id, dto, ctx);
    return { ok: true, item_count: result.item_count };
  }
}
