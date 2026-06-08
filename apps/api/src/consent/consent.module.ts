import { Module } from "@nestjs/common";
import { ConsentController } from "./consent.controller";
import { ConsentService } from "./consent.service";
import { ConsentRepository } from "./consent.repository";

@Module({
  controllers: [ConsentController],
  providers: [ConsentService, ConsentRepository],
})
export class ConsentModule {}
