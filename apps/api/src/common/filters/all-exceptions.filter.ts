import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import type { Request, Response } from "express";

/**
 * Global exception filter producing a consistent JSON error shape and logging
 * server errors. Never leaks stack traces to clients.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const payload =
      exception instanceof HttpException ? exception.getResponse() : "Internal server error";

    const body = {
      statusCode: status,
      error: typeof payload === "string" ? { message: payload } : payload,
      requestId: req.requestId,
      path: req.url,
      timestamp: new Date().toISOString(),
    };

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const message = exception instanceof Error ? exception.stack : String(exception);
      this.logger.error(`${req.method} ${req.url} -> ${status}: ${message}`);
    }

    res.status(status).json(body);
  }
}
