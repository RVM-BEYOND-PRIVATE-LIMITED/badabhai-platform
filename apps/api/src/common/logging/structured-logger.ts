import type { LoggerService } from "@nestjs/common";

/**
 * Minimal JSON structured logger. Emits one JSON object per line so logs are
 * machine-parseable in any environment. Wired via `app.useLogger(...)` so
 * NestJS's own `Logger` calls route through it too.
 */
export class StructuredLogger implements LoggerService {
  constructor(private readonly service = "api") {}

  private write(level: string, message: unknown, optionalParams: unknown[]): void {
    // Nest passes the logging context as the last optional param.
    const context = optionalParams.length ? optionalParams[optionalParams.length - 1] : undefined;
    const entry: Record<string, unknown> = {
      level,
      time: new Date().toISOString(),
      service: this.service,
      context: typeof context === "string" ? context : undefined,
      message: typeof message === "string" ? message : JSON.stringify(message),
    };
    const line = JSON.stringify(entry);
    if (level === "error" || level === "fatal") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write("info", message, optionalParams);
  }
  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write("error", message, optionalParams);
  }
  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write("warn", message, optionalParams);
  }
  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write("debug", message, optionalParams);
  }
  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write("verbose", message, optionalParams);
  }
  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write("fatal", message, optionalParams);
  }
}
