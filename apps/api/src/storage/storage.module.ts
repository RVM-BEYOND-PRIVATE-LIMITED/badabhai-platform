import { Module } from "@nestjs/common";
import { StorageService } from "./storage.service";

/**
 * Supabase Storage access (resume PDFs). Service-role, backend-only. Exported so
 * the resume render processor + controller can inject it.
 */
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
