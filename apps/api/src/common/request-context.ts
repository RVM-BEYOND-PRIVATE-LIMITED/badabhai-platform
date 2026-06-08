import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";

/** Per-request tracing identifiers attached by RequestIdMiddleware. */
export interface RequestContext {
  requestId: string;
  correlationId: string;
}

/**
 * Controller param decorator that surfaces the request/correlation ids so they
 * can be threaded into events for tracing.
 *
 *   @Post() create(@Ctx() ctx: RequestContext) { ... }
 */
export const Ctx = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestContext => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return {
    requestId: req.requestId ?? "unknown",
    correlationId: req.correlationId ?? "unknown",
  };
});
