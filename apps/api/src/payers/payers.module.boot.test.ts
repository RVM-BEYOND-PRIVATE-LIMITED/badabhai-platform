import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import ts from "typescript";
import { AppModule } from "../app.module";
import { AppConfigModule, SERVER_CONFIG } from "../config/config.module";
import { DatabaseModule } from "../database/database.module";
import { PayersModule } from "./payers.module";
import { PayerOrgsRepository } from "./payer-orgs.repository";
import { PayerTenantScopeService } from "./payer-tenant-scope.service";

/**
 * ADR-0053 — DI WIRING for the payer tenant resolver, over the REAL module graph.
 *
 * `PayerTenantScopeService` is injected by two GUARDS (`PayerAuthGuard`, `PayerOrgRoleGuard`).
 * Nest instantiates a guard in the module of the controller that mounts it and resolves the
 * guard's constructor from THAT module's scope — so every module mounting either guard must see
 * the resolver through an import of `PayersModule`, or the app refuses to boot. Typecheck, lint
 * and every unit test stay green when that edge is missing (memory: "Nest module-graph boot
 * gap"); only the e2e job, which starts the app, would notice.
 *
 * This is not a `Test.createTestingModule` boot: this repo's vitest does not emit
 * `design:paramtypes`, so such a boot resolves every constructor argument as `undefined` and
 * passes regardless. Instead it reads WHO injects the resolver from the source (TypeScript
 * syntax tree, no regex), then walks every module reachable from `AppModule` and checks each one
 * that provides or mounts such a class can resolve it.
 */

const SRC = join(__dirname, "..");

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")
      ? [full]
      : [];
  });
}

/** Classes whose constructor takes a parameter typed `PayerTenantScopeService`. */
function injectorsOfResolver(): Set<string> {
  const names = new Set<string>();
  for (const file of tsFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("PayerTenantScopeService")) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name) {
        const ctor = node.members.find(ts.isConstructorDeclaration);
        const injects = ctor?.parameters.some(
          (p) =>
            p.type !== undefined &&
            ts.isTypeReferenceNode(p.type) &&
            p.type.typeName.getText(sf) === "PayerTenantScopeService",
        );
        if (injects) names.add(node.name.text);
      }
      node.forEachChild(visit);
    };
    visit(sf);
  }
  return names;
}

const meta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

/** `forwardRef()` → its target; a dynamic module → its class; else the entry itself. */
function resolveImport(entry: unknown): unknown {
  const ref = entry as { forwardRef?: () => unknown; module?: unknown } | null | undefined;
  if (ref && typeof ref.forwardRef === "function") return ref.forwardRef();
  if (ref && ref.module !== undefined) return ref.module;
  return entry;
}

const nameOf = (x: unknown): string =>
  typeof x === "function" ? x.name : String((x as { provide?: unknown })?.provide ?? x);

function reachableModules(root: unknown): unknown[] {
  const seen = new Set<unknown>();
  const queue = [root];
  while (queue.length > 0) {
    const mod = queue.shift();
    if (mod === undefined || mod === null || seen.has(mod)) continue;
    seen.add(mod);
    queue.push(...meta("imports", mod).map(resolveImport));
  }
  return [...seen];
}

/** Every class a module would construct: its providers, plus each controller's guards. */
function constructedBy(mod: unknown): string[] {
  const providers = meta("providers", mod).map(nameOf);
  const guards = meta("controllers", mod).flatMap((ctrl) => {
    const proto = (ctrl as { prototype: Record<string, unknown> }).prototype;
    const methods = Object.getOwnPropertyNames(proto).map((k) => proto[k]);
    return [ctrl, ...methods].flatMap((target) => meta(GUARDS_METADATA, target).map(nameOf));
  });
  return [...providers, ...guards];
}

/** Does `mod` see PayersModule's exports — PayersModule itself, a direct import, or a re-export? */
function seesPayersModule(mod: unknown): boolean {
  if (mod === PayersModule) return true;
  return meta("imports", mod)
    .map(resolveImport)
    .some((imp) => imp === PayersModule || meta("exports", imp).includes(PayersModule));
}

describe("PayersModule — the tenant resolver is wired wherever it is injected (ADR-0053)", () => {
  const injectors = injectorsOfResolver();

  it("finds the resolver's injectors in source (a guard against a vacuous scan)", () => {
    expect([...injectors].sort()).toEqual([
      // PAY-DB-01 P2a: the services whose payer paths resolve the tenant key.
      // P2d (ORG_TENANCY_PLAN §3.4): the agency KYC, payout and referred-worker services.
      "AgencyKycService",
      "AgencyPayoutService",
      "AgencyService",
      "AgencyWorkersService",
      "JobPostingChatService",
      "JobPostingsService",
      "PayerAccountService",
      "PayerApplicantInboxService",
      "PayerApplicantStagesService",
      "PayerApplicantsService",
      "PayerAuthGuard",
      "PayerAuthService",
      "PayerOrgRoleGuard",
      // PAY-DB-01 P2c: plans, boosts, capacity and coupons, and the payer posting seam.
      "PayerPostingPlansService",
      "PostingPlansService",
    ]);
  });

  it("PayersModule provides AND exports the resolver, and provides its repository", () => {
    expect(meta("providers", PayersModule)).toContain(PayerTenantScopeService);
    expect(meta("exports", PayersModule)).toContain(PayerTenantScopeService);
    expect(meta("providers", PayersModule)).toContain(PayerOrgsRepository);
    // The repository's DATABASE comes from DatabaseModule; the resolver's SERVER_CONFIG from the
    // @Global AppConfigModule.
    expect(meta("imports", PayersModule)).toContain(DatabaseModule);
    expect(Reflect.getMetadata("__module:global__", AppConfigModule)).toBe(true);
    expect(meta("exports", AppConfigModule)).toContain(SERVER_CONFIG);
  });

  it("every module that constructs an injector of the resolver can resolve it", () => {
    const modules = reachableModules(AppModule);
    expect(modules.length).toBeGreaterThan(20);
    const consumers = modules.filter((mod) => constructedBy(mod).some((c) => injectors.has(c)));
    // Not vacuous: the guards are mounted across many modules.
    expect(consumers.length).toBeGreaterThan(5);
    const unwired = consumers.filter((mod) => !seesPayersModule(mod)).map(nameOf);
    expect(unwired, "import PayersModule where a payer guard or service is used").toEqual([]);
  });
});
