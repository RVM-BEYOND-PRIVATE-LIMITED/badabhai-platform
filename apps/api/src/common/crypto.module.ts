import { Global, Module } from "@nestjs/common";
import { PiiCryptoService } from "./pii-crypto.service";

/**
 * Global provider for PII crypto (HMAC pepper + AES key from config), so any
 * service can inject PiiCryptoService without re-importing.
 */
@Global()
@Module({
  providers: [PiiCryptoService],
  exports: [PiiCryptoService],
})
export class CryptoModule {}
