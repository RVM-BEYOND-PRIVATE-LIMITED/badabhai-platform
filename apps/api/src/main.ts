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
  assertMessagingConfig,
  assertPayerAuthConfig,
  assertAdminAuthConfig,
  isUsingDevAdminJwtDefault,
  resolveCorsOrigins,
} from "@badabhai/config";
import { AppModule } from "./app.module";
import { StructuredLogger } from "./common/logging/structured-logger";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";

async function bootstrap(): Promise<void> {
  const config = loadServerConfig();
  assertPiiCryptoConfig(config); // fail closed if PII secrets are dev defaults outside dev/test
  assertAuthConfig(config); // fail closed on dev JWT secret / console SMS / half-set Fast2SMS outside dev/test
  assertPaymentsConfig(config); // fail closed if real payments enabled without a provider key (ADR-0010 F-6)
  assertMessagingConfig(config); // fail closed if real WhatsApp enabled without Meta credentials (ADR-0020)
  assertPayerAuthConfig(config); // fail closed on a half-configured payer login method / dev JWT (ADR-0019 B)
  assertAdminAuthConfig(config); // fail closed on a dev/shared admin JWT or half-set MFA/TOTP (ADR-0025 ADMIN-1)
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
  if (isUsingDevAdminJwtDefault(config)) {
    new Logger("Bootstrap").warn(
      "Using INSECURE default ADMIN JWT secret (local dev only). Set ADMIN_JWT_SECRET.",
    );
  }

  const app = await NestFactory.create(AppModule, {
    logger: new StructuredLogger("api"),
  });

  app.useGlobalFilters(new AllExceptionsFilter());
  // Env-scoped CORS allow-list (no `*`): permissive in dev, explicit
  // CORS_ALLOWED_ORIGINS allow-list outside dev, deny-all if unset (fail closed).
  app.enableCors({ origin: resolveCorsOrigins(config) });
  app.enableShutdownHooks(); // ensures DatabaseModule.onModuleDestroy runs

  await app.listen(config.API_PORT);
  new Logger("Bootstrap").log(`API listening on http://localhost:${config.API_PORT}`);
}

void bootstrap();
