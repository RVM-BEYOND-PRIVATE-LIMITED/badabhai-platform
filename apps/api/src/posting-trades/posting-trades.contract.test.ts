import "reflect-metadata";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import type { QuestionPack } from "@badabhai/ai-contracts";
import { loadQuestionPackCorpus } from "@badabhai/db";
import {
  JOB_ROLE_DEPARTMENTS,
  JOB_ROLE_DEPARTMENT_BY_KIND,
  type TradeFormKindName,
} from "@badabhai/types";
import { LIVE_POSTING_TRADE_KINDS, TRADE_CATALOGUE } from "@badabhai/taxonomy";
import { AllExceptionsFilter } from "../common/filters/all-exceptions.filter";
import { PayerAuthGuard } from "../payers/payer-auth.guard";
import { toCorpusItem } from "../profiling/corpus-packs.fixture";
import { PackRegistryService } from "../profiling/pack-registry.service";
import { releaseServiceFor } from "../trade-release/trade-release.test-support";
import { TradeReleaseService } from "../trade-release/trade-release.service";
import { PostingTradesController } from "./posting-trades.controller";
import { LEGACY_LIST_TRADE_KINDS, PostingTradesService } from "./posting-trades.service";

/**
 * #3006 / #3054 — the posting-trades CONTRACT over real HTTP: the real controller, the real
 * service and the production exception filter; the packs are the checked-in corpus and the
 * release switch is the real service over an in-memory table. Only PayerAuthGuard is swapped for
 * an allow-all guard while the harness runs (the real guard list is pinned below).
 *
 * Every reply is parsed with the COMPANY WEB'S OWN zod schemas (`apps/payer-web/src/lib/
 * contracts.ts`), so a reply the web cannot read fails here, in the API's build — the gap that
 * let #3038 ship against routes that did not exist (#3054).
 */

type WireSchema = { parse: (value: unknown) => unknown };
let web: {
  postingTradeListWireSchema: WireSchema;
  postingTradeCatalogueWireSchema: WireSchema;
  postingTradeDetailWireSchema: WireSchema;
};

const CORPUS = loadQuestionPackCorpus().packs;
const PACKS = new Map<string, QuestionPack | null>();
function activePack(familyId: string): QuestionPack | null {
  if (!PACKS.has(familyId)) {
    const active = CORPUS.filter((p) => p.family_id === familyId && p.status === "active");
    const record = active.length === 1 ? active[0]! : null;
    PACKS.set(
      familyId,
      record === null
        ? null
        : {
            pack_id: record.pack_id,
            version: record.version,
            family_id: record.family_id,
            locale: record.locale ?? "hi-IN",
            status: "active",
            content_hash: `corpus_${record.pack_id}_${record.version}`,
            items: (record.items as unknown as Array<Record<string, unknown>>).map(toCorpusItem),
          },
    );
  }
  return PACKS.get(familyId)!;
}

/** The switch table the routes read; each case sets it (default: migration 0198's seed). */
let release: TradeReleaseService = releaseServiceFor();
const releaseProxy = {
  isPostingEnabled: (kind: string) => release.isPostingEnabled(kind),
  postingEnabledKinds: () => release.postingEnabledKinds(),
};

/** The real service over the corpus packs and the switchable release table. */
const service = new PostingTradesService(
  { loadForFamily: async (f: string) => activePack(f) } as unknown as PackRegistryService,
  releaseProxy as unknown as TradeReleaseService,
);
// The test transform emits no decorator metadata; name the controller's one dependency.
Reflect.defineMetadata("design:paramtypes", [PostingTradesService], PostingTradesController);

/** Stands in for PayerAuthGuard in the harness; the real one is pinned in "guards" below. */
class AllowGuard {
  canActivate(): boolean {
    return true;
  }
}
const REAL_GUARDS = Reflect.getMetadata(GUARDS_METADATA, PostingTradesController) as unknown[];

@Module({
  controllers: [PostingTradesController],
  providers: [{ provide: PostingTradesService, useFactory: () => service }],
})
class HarnessModule {}

let app: INestApplication;
let base: string;

beforeAll(async () => {
  const contractsPath = join(__dirname, "../../../payer-web/src/lib/contracts.ts");
  web = (await import(pathToFileURL(contractsPath).href)) as typeof web;
  Reflect.defineMetadata(GUARDS_METADATA, [AllowGuard], PostingTradesController);
  app = await NestFactory.create(HarnessModule, { logger: false, abortOnError: false });
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await app?.close();
  Reflect.defineMetadata(GUARDS_METADATA, REAL_GUARDS, PostingTradesController);
});

beforeEach(() => {
  release = releaseServiceFor();
});

async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  return {
    status: res.status,
    body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

const kindsOf = (body: Record<string, unknown>): string[] =>
  (body.trades as Array<{ role_kind: string }>).map((t) => t.role_kind);

describe("guards", () => {
  it("all three routes sit behind PayerAuthGuard (class-level, like the old route)", () => {
    expect(REAL_GUARDS).toEqual([PayerAuthGuard]);
  });
});

describe("GET /payer/posting-trades — the installed apps' route, unchanged", () => {
  it("returns the 16 forms the company web's list schema reads", async () => {
    const { status, body } = await get("/payer/posting-trades");
    expect(status).toBe(200);
    web.postingTradeListWireSchema.parse(body);
    expect(kindsOf(body)).toEqual([...LIVE_POSTING_TRADE_KINDS]);
    expect(LEGACY_LIST_TRADE_KINDS).toEqual(LIVE_POSTING_TRADE_KINDS);
  }, 30_000);

  it("is byte-identical when a 17th trade is switched on (done-when)", async () => {
    const before = await get("/payer/posting-trades");
    release = releaseServiceFor([...LIVE_POSTING_TRADE_KINDS, "gear_cutting_operator"]);
    const after = await get("/payer/posting-trades");
    expect(JSON.stringify(after.body)).toBe(JSON.stringify(before.body));
    // …while the new routes follow the switch.
    expect(kindsOf((await get("/payer/posting-trades/catalogue")).body)).toContain(
      "gear_cutting_operator",
    );
  }, 30_000);

  it("keeps all 16 even when a live trade is switched off, or the table is missing", async () => {
    release = releaseServiceFor(LIVE_POSTING_TRADE_KINDS.filter((k) => k !== "welder"));
    expect(kindsOf((await get("/payer/posting-trades")).body)).toEqual([
      ...LIVE_POSTING_TRADE_KINDS,
    ]);
    release = releaseServiceFor("missing");
    expect(kindsOf((await get("/payer/posting-trades")).body)).toEqual([
      ...LIVE_POSTING_TRADE_KINDS,
    ]);
  }, 30_000);
});

describe("GET /payer/posting-trades/catalogue", () => {
  it("lists the switched-on trades in the web's catalogue shape, department order then pack order", async () => {
    const { status, body } = await get("/payer/posting-trades/catalogue");
    expect(status).toBe(200);
    web.postingTradeCatalogueWireSchema.parse(body);
    const rows = body.trades as Array<{
      role_kind: string;
      role_label: string;
      department: string;
      department_label: string;
      kind: string;
    }>;
    expect(new Set(rows.map((r) => r.role_kind))).toEqual(new Set(LIVE_POSTING_TRADE_KINDS));
    const deptIndex = (id: string) => JOB_ROLE_DEPARTMENTS.findIndex((d) => d.id === id);
    const code = (kind: string) =>
      Number(TRADE_CATALOGUE.find((e) => e.roleKind === kind)!.code.slice(1));
    for (let i = 1; i < rows.length; i++) {
      const [a, b] = [rows[i - 1]!, rows[i]!];
      const order =
        deptIndex(a.department) - deptIndex(b.department) || code(a.role_kind) - code(b.role_kind);
      expect(order, `${a.role_kind} before ${b.role_kind}`).toBeLessThan(0);
    }
    for (const row of rows) {
      const entry = TRADE_CATALOGUE.find((e) => e.roleKind === row.role_kind)!;
      expect(row.department).toBe(JOB_ROLE_DEPARTMENT_BY_KIND[row.role_kind as TradeFormKindName]);
      expect(row.department_label).toBe(JOB_ROLE_DEPARTMENTS[deptIndex(row.department)]!.label);
      expect(row.department_label).toBe(entry.department);
      expect(row.kind).toBe(entry.kind);
      expect(row.role_label.length).toBeGreaterThan(0);
      // Light: no ladder, no questions.
      expect(Object.keys(row).sort()).toEqual(
        ["department", "department_label", "kind", "role_kind", "role_label"].sort(),
      );
    }
  }, 30_000);

  it("names all 60 in the web's shape once every switch is on", async () => {
    release = releaseServiceFor(TRADE_CATALOGUE.map((e) => e.roleKind));
    const { body } = await get("/payer/posting-trades/catalogue");
    web.postingTradeCatalogueWireSchema.parse(body);
    expect(kindsOf(body)).toHaveLength(60);
  }, 30_000);

  it("answers the 0198 seed (the 16) while the table is missing", async () => {
    release = releaseServiceFor("missing");
    const { status, body } = await get("/payer/posting-trades/catalogue");
    expect(status).toBe(200);
    expect(new Set(kindsOf(body))).toEqual(new Set(LIVE_POSTING_TRADE_KINDS));
  }, 30_000);
});

describe("GET /payer/posting-trades/:roleKind", () => {
  it("returns one trade's form with its department, in the web's detail shape", async () => {
    const list = (await get("/payer/posting-trades")).body.trades as Array<Record<string, unknown>>;
    for (const kind of ["cnc_turner", "quality_inspector"]) {
      const { status, body } = await get(`/payer/posting-trades/${kind}`);
      expect(status, kind).toBe(200);
      web.postingTradeDetailWireSchema.parse(body);
      expect(body.department).toBe(JOB_ROLE_DEPARTMENT_BY_KIND[kind as TradeFormKindName]);
      // Same shape as an element of the old reply, plus `department`.
      const { department: _department, ...form } = body;
      expect(form).toEqual(list.find((t) => t.role_kind === kind));
    }
  }, 30_000);

  it("serves a trades-v2 trade only while it is switched on", async () => {
    expect((await get("/payer/posting-trades/gear_cutting_operator")).status).toBe(404);
    release = releaseServiceFor([...LIVE_POSTING_TRADE_KINDS, "gear_cutting_operator"]);
    const { status, body } = await get("/payer/posting-trades/gear_cutting_operator");
    expect(status).toBe(200);
    web.postingTradeDetailWireSchema.parse(body);
    expect(body.department).toBe("machining");
  }, 30_000);

  it("is a 404 for an unknown kind, a malformed one, or a live trade switched off", async () => {
    expect((await get("/payer/posting-trades/not_a_trade")).status).toBe(404);
    expect((await get("/payer/posting-trades/CNC-TURNER")).status).toBe(404);
    expect((await get(`/payer/posting-trades/${"a".repeat(65)}`)).status).toBe(404);
    release = releaseServiceFor(LIVE_POSTING_TRADE_KINDS.filter((k) => k !== "welder"));
    expect((await get("/payer/posting-trades/welder")).status).toBe(404);
  }, 30_000);
});
