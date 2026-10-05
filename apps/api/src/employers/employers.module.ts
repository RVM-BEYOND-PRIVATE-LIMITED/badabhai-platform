import { Module } from "@nestjs/common";
import { EmployerNameIndex } from "./employer-name-index.service";
import { EmployerNameRepository } from "./employer-name.repository";

/**
 * THE EMPLOYER DIRECTORY (TD147(1), WP7). Its own module because the decrypting index cannot
 * live inside `chat-companion/` (that leaf's egress boot test forbids `pii-crypto` — see
 * `employer-name-index.service.ts`). The companion imports this module and injects
 * `EmployerNameIndex`; nothing here imports the chat module or any chat-table writer.
 *
 * `PiiCryptoService` comes from @Global `CryptoModule`, so no import edge is needed for it.
 */
@Module({
  providers: [EmployerNameRepository, EmployerNameIndex],
  exports: [EmployerNameIndex],
})
export class EmployersModule {}
