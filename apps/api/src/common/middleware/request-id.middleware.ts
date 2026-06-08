import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Augment Express's Request with our tracing ids (global Express namespace).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      correlationId: string;
    }
  }
}

/**
 * Assigns a `requestId` (free-form, echoed in the `x-request-id` response header)
 * and a `correlationId` (UUID, used to tie together all events produced while
 * handling one request). Honors inbound `x-request-id` / `x-correlation-id`.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incomingRequestId = req.header("x-request-id");
    const requestId =
      incomingRequestId && incomingRequestId.length <= 128 ? incomingRequestId : randomUUID();

    const incomingCorrelationId = req.header("x-correlation-id");
    const correlationId =
      incomingCorrelationId && UUID_RE.test(incomingCorrelationId)
        ? incomingCorrelationId
        : randomUUID();

    req.requestId = requestId;
    req.correlationId = correlationId;
    res.setHeader("x-request-id", requestId);
    res.setHeader("x-correlation-id", correlationId);
    next();
  }
}
