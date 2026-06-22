import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import {
  loadServerConfig,
  assertPiiCryptoConfig,
  isUsingDevPiiDefaults,
  assertAuthConfig,
  isUsingDevJwtDefault,
  assertPaymentsConfig,
  assertPayerAuthConfig,
  assertCorsConfig,
  corsOptions,
} from "@badabhai/config";
import { AppModule } from "./app.module";
import { StructuredLogger } from "./common/logging/structured-logger";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";

async function bootstrap(): Promise<void> {
  const config = loadServerConfig();
  assertPiiCryptoConfig(config); // fail closed if PII secrets are dev defaults outside dev/test
  assertAuthConfig(config); // fail closed on dev JWT secret / console SMS / half-set Fast2SMS outside dev/test
  assertPaymentsConfig(config); // fail closed if real payments enabled without a provider key (ADR-0010 F-6)
  assertPayerAuthConfig(config); // fail closed on a half-configured payer login method / dev JWT (ADR-0019 B)
  assertCorsConfig(config); // fail closed if the CORS allow-list is empty outside dev/test (TD30)
  if (isUsingDevPiiDefaults(config)) {
    new Logger("Bootstrap").warn(
      "Using INSECURE default PII secrets (local dev only). Set PII_HASH_PEPPER + PII_ENCRYPTION_KEY.",
    );
  }
  if (isUsingDevJwtDefault(config)) {
    new Logger("Bootstrap").warn(
      "Using INSECURE default JWT secret (local dev only). Set JWT_SECRET.",
    );
  }

  const app = await NestFactory.create(AppModule, {
    logger: new StructuredLogger("api"),
  });

  app.useGlobalFilters(new AllExceptionsFilter());
  // TD30: env-driven origin allow-list (fail-closed outside dev/test via assertCorsConfig
  // above). Reflects any origin ONLY in an explicit development/test env; staging/prod use
  // the exact CORS_ALLOWED_ORIGINS list. credentials:false (Bearer-header auth, not cookies);
  // exposedHeaders carries x-session-token so apps/payer-web (separate origin) can read the
  // rolling payer-session refresh.
  app.enableCors(corsOptions(config));
  app.enableShutdownHooks(); // ensures DatabaseModule.onModuleDestroy runs

  await app.listen(config.API_PORT);
  new Logger("Bootstrap").log(`API listening on http://localhost:${config.API_PORT}`);
}

void bootstrap();
