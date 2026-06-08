import { describe, it, expect } from "vitest";
import { z } from "zod";
import { BadRequestException } from "@nestjs/common";
import { ZodValidationPipe } from "./zod-validation.pipe";

const schema = z.object({ name: z.string().min(1) });

describe("ZodValidationPipe", () => {
  it("returns parsed data when valid", () => {
    const pipe = new ZodValidationPipe(schema);
    expect(pipe.transform({ name: "vmc-operator" })).toEqual({ name: "vmc-operator" });
  });

  it("throws BadRequestException when invalid", () => {
    const pipe = new ZodValidationPipe(schema);
    expect(() => pipe.transform({ name: "" })).toThrow(BadRequestException);
  });
});
