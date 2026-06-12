import { Global, Module } from "@nestjs/common";
import { PdfRenderer } from "./pdf-renderer.service";

/**
 * Shared WeasyPrint HTML→PDF core (ADR-0007). Global so the resume renderer and
 * the interview-kit renderer both inject the SAME security-critical implementation.
 */
@Global()
@Module({
  providers: [PdfRenderer],
  exports: [PdfRenderer],
})
export class PdfModule {}
