import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { loadServerConfig, assertPiiCryptoConfig, isUsingDevPiiDefaults } from "@badabhai/config";
import { AppModule } from "./app.module";
import { StructuredLogger } from "./common/logging/structured-logger";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";

async function bootstrap(): Promise<void> {
  const config = loadServerConfig();
  assertPiiCryptoConfig(config); // fail closed if PII secrets are dev defaults outside dev/test
  if (isUsingDevPiiDefaults(config)) {
    new Logger("Bootstrap").warn(
      "Using INSECURE default PII secrets (local dev only). Set PII_HASH_PEPPER + PII_ENCRYPTION_KEY.",
    );
  }

  const app = await NestFactory.create(AppModule, {
    logger: new StructuredLogger("api"),
  });

  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableCors(); // TODO: lock down origins per environment before production
  app.enableShutdownHooks(); // ensures DatabaseModule.onModuleDestroy runs

  await app.listen(config.API_PORT);
  new Logger("Bootstrap").log(`API listening on http://localhost:${config.API_PORT}`);
}

void bootstrap();
