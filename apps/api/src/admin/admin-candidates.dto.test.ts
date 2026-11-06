import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import {
  AdminCandidateSearchSchema,
  CANDIDATE_SEARCH_SORTS,
} from "./admin-candidates.dto";
import { AdminCandidatesService } from "./admin-candidates.service";
import type { AdminCandidateSearchDto } from "./admin-candidates.dto";
import type { RequestContext } from "../common/request-context";
import type { AuthenticatedAdmin } from "./admin-auth.guard";

const CTX: RequestContext = { requestId: "req-1", correlationId: "cor-1" };
const ADMIN = { id: "aaaaaaaa-0000-4000-8000-000000000001", role: "support", sid: "s" } as AuthenticatedAdmin;

describe("AdminCandidateSearchSchema (boundary: strict, bounded, defaulted)", () => {
  it("defaults sort/dir/page/page_size", () => {
    expect(AdminCandidateSearchSchema.parse({})).toMatchObject({
      sort: "last_active_at",
      dir: "desc",
      page: 1,
      page_size: 50,
    });
  });

  it("accepts only 25/50/100 page sizes", () => {
    for (const page_size of [25, 50, 100]) {
      expect(AdminCandidateSearchSchema.parse({ page_size }).page_size).toBe(page_size);
    }
    expect(() => AdminCandidateSearchSchema.parse({ page_size: 20 })).toThrow();
    expect(() => AdminCandidateSearchSchema.parse({ page_size: 200 })).toThrow();
  });

  it("accepts every listed sort column, rejects the rest", () => {
    for (const sort of CANDIDATE_SEARCH_SORTS) {
      expect(AdminCandidateSearchSchema.parse({ sort }).sort).toBe(sort);
    }
    expect(() => AdminCandidateSearchSchema.parse({ sort: "name" })).toThrow();
    expect(() => AdminCandidateSearchSchema.parse({ sort: "phone_hash" })).toThrow();
  });

  it("rejects unknown keys (a typo'd filter must 400, never silently unfilter)", () => {
    expect(() => AdminCandidateSearchSchema.parse({ bogus: 1 })).toThrow();
    expect(() => AdminCandidateSearchSchema.parse({ filters: { bogus: 1 } })).toThrow();
    expect(() => AdminCandidateSearchSchema.parse({ q: "x".repeat(201) })).toThrow();
  });

  it("bounds filter arrays and ranges", () => {
    expect(() =>
      AdminCandidateSearchSchema.parse({ filters: { status: Array(11).fill("active") } }),
    ).toThrow();
    expect(() =>
      AdminCandidateSearchSchema.parse({ filters: { min_experience_years: 61 } }),
    ).toThrow();
    expect(() =>
      AdminCandidateSearchSchema.parse({ filters: { form_level: ["easy", "nope"] } }),
    ).toThrow();
  });
});

describe("the search term NEVER reaches a log line (ADR-0062 §3.6)", () => {
  it("no console output on any path carries the term", async () => {
    const sink: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const spies = methods.map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        sink.push(args.map(String).join(" "));
      }),
    );
    try {
      const search = vi.fn(async () => ({
        rows: [],
        total: 0,
        identityMatches: 0,
        byStatus: [],
        byTrade: [],
        byCity: [],
        byProfileStatus: [],
      }));
      // Breach path logs (without PII) + happy path with names.
      const svc = new AdminCandidatesService(
        { search } as never,
        { resolve: vi.fn(async () => new Map()) } as never,
        { consume: vi.fn(async () => ({ ok: false as const, window: "hour" as const })) } as never,
        { hashPhone: (p: string) => `hash(${p})` } as never,
        { termTokens: () => ({ hashes: ["t"], kid: "k" }) } as never,
        { emit: vi.fn(async () => undefined) } as never,
      );
      const dto = { sort: "last_active_at", dir: "desc", page: 1, page_size: 25 } as AdminCandidateSearchDto;
      await expect(
        svc.search(ADMIN, { ...dto, q: "Uncommontermx Zzz" }, CTX),
      ).rejects.toThrow(/Too many searches/);
      const ok = new AdminCandidatesService(
        { search } as never,
        { resolve: vi.fn(async () => new Map()) } as never,
        { consume: vi.fn(async () => ({ ok: true as const })) } as never,
        { hashPhone: (p: string) => `hash(${p})` } as never,
        { termTokens: () => ({ hashes: ["t"], kid: "k" }) } as never,
        { emit: vi.fn(async () => undefined) } as never,
      );
      await ok.search(ADMIN, { ...dto, q: "Uncommontermx Zzz" }, CTX);
      await ok.search(ADMIN, { ...dto, q: "9876543210" }, CTX);
      const logged = sink.join("\n");
      expect(logged).not.toContain("Uncommontermx");
      expect(logged).not.toContain("9876543210");
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
