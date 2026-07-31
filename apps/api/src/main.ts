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
  assertPushConfig,
  assertPayerAuthConfig,
  assertMemberInvitesConfig,
  assertAdminAuthConfig,
  isUsingDevAdminJwtDefault,
  resolveCorsOrigins,
} from "@badabhai/config";
import { AppModule } from "./app.module";
import { StructuredLogger } from "./common/logging/structured-logger";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { loadRootEnv } from "./config/root-env";
import {
  RAZORPAY_WEBHOOK_PATH,
  razorpayRawBodyMiddleware,
} from "./unlocks/razorpay-raw-body.middleware";

async function bootstrap(): Promise<void> {
  const rootEnv = loadRootEnv();
  const config = loadServerConfig();
  assertPiiCryptoConfig(config); // fail closed if PII secrets are dev defaults outside dev/test
  assertAuthConfig(config); // fail closed on dev JWT secret / console SMS / half-set Fast2SMS outside dev/test
  assertPaymentsConfig(config); // fail closed if real payments enabled without a provider key (ADR-0010 F-6)
  assertMessagingConfig(config); // fail closed if real WhatsApp enabled without Meta credentials (ADR-0020)
  assertPushConfig(config); // fail closed if real push enabled without an FCM credential (ADR-0034)
  assertPayerAuthConfig(config); // fail closed on a half-configured payer login method / dev JWT (ADR-0019 B)
  assertMemberInvitesConfig(config); // fail closed if real invite email enabled without email creds / accept URL (ADR-0027 B5.4)
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
  if (rootEnv.loaded > 0) {
    new Logger("Bootstrap").log(`Loaded ${rootEnv.loaded} env vars from repo root .env`);
  }

  const app = await NestFactory.create(AppModule, {
    logger: new StructuredLogger("api"),
  });

  // ── Razorpay webhook RAW BODY (real-payments stream) ──────────────────────────────
  // The webhook signature is an HMAC over the EXACT bytes Razorpay sent, so those bytes
  // must be captured BEFORE the JSON parser turns them into an object (a re-serialized
  // body is a different byte sequence and would never verify).
  //
  // SCOPED TO ONE PATH, by construction:
  //  - `app.use(path, mw)` means Express only invokes it for `/payments/razorpay/webhook`.
  //    Every other route reaches Nest's parsers exactly as before — no global parser option
  //    is changed, and no other route's bytes are duplicated in memory.
  //  - Registering here (before `listen()`) puts it AHEAD of Nest's body parsers, which are
  //    installed inside `NestApplication.init()` — so it reads the stream first and then
  //    marks the body already-read for the downstream parser.
  //
  // The deliberately-not-taken alternative is `NestFactory.create(…, { rawBody: true })`,
  // which would retain a raw copy of EVERY request body — including the OTP / PIN /
  // worker-answer routes, whose bodies are PII (CLAUDE.md §2 #2).
  app.use(RAZORPAY_WEBHOOK_PATH, razorpayRawBodyMiddleware);

  // TD25 — trust exactly the configured number of reverse-proxy hops when deriving
  // req.ip from X-Forwarded-For (feeds every per-IP rate cap). A hop COUNT, never a
  // blanket `true` (spoofable XFF = rotatable rate-limit identity). Default 0 keeps
  // the fail-safe socket-peer behavior until the deploy edge is known.
  if (config.TRUST_PROXY_HOP_COUNT > 0) {
    const express = app.getHttpAdapter().getInstance() as {
      set: (setting: string, value: number) => void;
    };
    express.set("trust proxy", config.TRUST_PROXY_HOP_COUNT);
  }

  app.useGlobalFilters(new AllExceptionsFilter());
  // Env-scoped CORS allow-list (no `*`): permissive in dev, explicit
  // CORS_ALLOWED_ORIGINS allow-list outside dev, deny-all if unset (fail closed).
  app.enableCors({ origin: resolveCorsOrigins(config) });
  app.enableShutdownHooks(); // ensures DatabaseModule.onModuleDestroy runs

  await app.listen(config.API_PORT);
  new Logger("Bootstrap").log(`API listening on http://localhost:${config.API_PORT}`);
}

void bootstrap();
