import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenException, Logger, NotFoundException } from "@nestjs/common";
import { loadServerConfig } from "@badabhai/config";
import type { DisplayTheme } from "@badabhai/types";

import type { AuthenticatedAdmin } from "../admin/admin-auth.guard";
import type { AuthenticatedWorker } from "../auth/worker-auth.guard";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import type { FeaturePilotSubjectsRepository } from "../feature-rollout/feature-pilot-subjects.repository";
import type { FeaturePilotRepository } from "../feature-rollout/feature-pilot.repository";
import { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import { rolloutCaller } from "../feature-rollout/rollout-caller";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import type { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import { resolverOver } from "../payers/payer-tenant-scope.test-support";
import type { DisplayPrefsRepository } from "./display-prefs.repository";
import { DisplayPrefsService } from "./display-prefs.service";

/**
 * #2819 — DisplayPrefsService over the REAL `FeatureRolloutService` (so `THEME_ROLLOUT` off / pilot
 * / on decides exactly as in production) and the REAL tenancy resolver, with the two pilot lists
 * and the `display_prefs` table in memory. The Postgres twin is `display-prefs.db.test.ts`.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const PAYER = "33333333-3333-4333-8333-333333333333";
/** A company (ANCHOR) with a team member (MEMBER). */
const ANCHOR = "44444444-4444-4444-8444-444444444444";
const MEMBER = "55555555-5555-4555-8555-555555555555";
const OTHER = "99999999-9999-4999-8999-999999999999";
const ctx = { correlationId: "c-2819", requestId: "r-2819" } as RequestContext;

type Mode = "off" | "pilot" | "on";

/** A Postgres-shaped error: drizzle 0.45 puts the SQLSTATE on `err.cause`. */
function pgError(code: string): Error {
  const cause = Object.assign(new Error(`postgres ${code}`), { code });
  return Object.assign(new Error("Failed query: select ... params: ..."), { cause });
}

interface Options {
  mode?: Mode;
  /** `kind:id` → stored theme. */
  rows?: Record<string, string>;
  /** `kind:id` on feature_pilot_subjects; a tenant key on feature_pilot_payers. */
  pilots?: string[];
  tenancy?: "off" | "on";
  resolver?: PayerTenantScopeService;
  /** Every table call throws this. */
  tableError?: Error;
  /** insertTheme loses a first-choice race: this theme was committed concurrently. */
  raceWinner?: DisplayTheme;
}

function harness(opts: Options = {}) {
  const store = new Map<string, string>(Object.entries(opts.rows ?? {}));
  const pilots = new Set(opts.pilots ?? []);
  const TX = { tx: "t2819" };
  const touch = () => {
    if (opts.tableError) throw opts.tableError;
  };
  const repo = {
    withTransaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(TX)),
    findTheme: vi.fn(async (kind: string, id: string) => {
      touch();
      return store.get(`${kind}:${id}`) ?? null;
    }),
    lockTheme: vi.fn(async (kind: string, id: string) => {
      touch();
      return store.get(`${kind}:${id}`) ?? null;
    }),
    insertTheme: vi.fn(async (kind: string, id: string, theme: string) => {
      touch();
      if (opts.raceWinner !== undefined) {
        store.set(`${kind}:${id}`, opts.raceWinner);
        return false;
      }
      if (store.has(`${kind}:${id}`)) return false;
      store.set(`${kind}:${id}`, theme);
      return true;
    }),
    updateTheme: vi.fn(async (kind: string, id: string, theme: string) => {
      touch();
      store.set(`${kind}:${id}`, theme);
    }),
  };
  const config = loadServerConfig({
    NODE_ENV: "test",
    THEME_ROLLOUT: opts.mode ?? "on",
    PAYER_ORG_TENANCY_MODE: opts.tenancy ?? "off",
  });
  const rollout = new FeatureRolloutService(
    config,
    {
      isListed: async (_f: string, tenant: string) => pilots.has(tenant),
    } as unknown as FeaturePilotRepository,
    {
      isListed: async (_f: string, kind: string, id: string) => pilots.has(`${kind}:${id}`),
    } as unknown as FeaturePilotSubjectsRepository,
  );
  const openSpy = vi.spyOn(rollout, "isThemeOpenFor");
  const resolver = opts.resolver ?? resolverOver(config, [{ anchor: ANCHOR, members: [MEMBER] }]);
  const events = { emit: vi.fn(async () => ({})) };
  const svc = new DisplayPrefsService(
    repo as unknown as DisplayPrefsRepository,
    rollout,
    resolver,
    events as unknown as EventsService,
  );
  return { svc, repo, store, events, openSpy, TX };
}

const worker = (id = WORKER): AuthenticatedWorker => ({ id, sid: "sid-2819" });
const admin = (id = ADMIN): AuthenticatedAdmin => ({ id, role: "analyst", sid: "sid-2819" });
const payer = (id = PAYER, role: "employer" | "agent" = "employer"): AuthenticatedPayer => ({
  id,
  sid: "sid-2819",
  role,
});

type Svc = DisplayPrefsService;

/** The three realms, each read and written the way its controller does. */
const REALMS = [
  {
    realm: "worker",
    key: `worker:${WORKER}`,
    pilot: `worker:${WORKER}`,
    read: (s: Svc, id?: string) => s.readForWorker(worker(id), rolloutCaller.worker(worker(id))),
    write: (s: Svc, theme: DisplayTheme, id?: string) =>
      s.writeForWorker(worker(id), rolloutCaller.worker(worker(id)), theme, ctx),
    envelope: {
      actor: { actor_type: "worker", actor_id: WORKER },
      subject: { subject_type: "worker", subject_id: WORKER },
    },
  },
  {
    realm: "payer_user",
    key: `payer_user:${PAYER}`,
    // In tenancy `off` the tenant key is the login itself.
    pilot: PAYER,
    read: (s: Svc, id?: string) => s.readForPayer(payer(id)),
    write: (s: Svc, theme: DisplayTheme, id?: string) => s.writeForPayer(payer(id), theme, ctx),
    envelope: {
      actor: { actor_type: "payer", actor_id: PAYER },
      subject: { subject_type: "payer", subject_id: PAYER },
    },
  },
  {
    realm: "admin",
    key: `admin:${ADMIN}`,
    pilot: `admin:${ADMIN}`,
    read: (s: Svc, id?: string) => s.readForAdmin(admin(id), rolloutCaller.admin(admin(id))),
    write: (s: Svc, theme: DisplayTheme, id?: string) =>
      s.writeForAdmin(admin(id), rolloutCaller.admin(admin(id)), theme, ctx),
    envelope: {
      actor: { actor_type: "admin", actor_id: ADMIN },
      subject: { subject_type: "admin_session", subject_id: ADMIN },
    },
  },
] as const;

beforeEach(() => {
  // The one success line a real change logs; asserted nowhere, so kept out of the test output.
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe.each(REALMS)(
  "DisplayPrefsService — $realm",
  ({ realm, key, pilot, read, write, envelope }) => {
    const subjectId = key.split(":")[1]!;

    describe("switch CLOSED", () => {
      it.each([
        ["off", [] as string[]],
        ["off", [pilot]],
        ["pilot", [] as string[]],
      ] as const)(
        "%s (pilot list %j): GET is light / false and never reads the table",
        async (mode, pilots) => {
          const h = harness({ mode, pilots: [...pilots], rows: { [key]: "dark" } });
          expect(await read(h.svc)).toEqual({ theme: "light", theme_open: false });
          expect(h.repo.findTheme).not.toHaveBeenCalled();
        },
      );

      it.each(["off", "pilot"] as const)(
        "%s: PATCH is a plain 404 that writes and emits nothing",
        async (mode) => {
          const h = harness({ mode, rows: { [key]: "dark" } });
          await expect(write(h.svc, "system")).rejects.toBeInstanceOf(NotFoundException);
          await expect(write(h.svc, "system")).rejects.toThrow(/^Not Found$/);
          expect(h.repo.withTransaction).not.toHaveBeenCalled();
          expect(h.events.emit).not.toHaveBeenCalled();
          // The stored choice waits for the switch to open again.
          expect(h.store.get(key)).toBe("dark");
        },
      );
    });

    describe.each([
      ["on", [] as string[]],
      ["pilot", [pilot]],
    ] as const)("switch OPEN (%s)", (mode, pilots) => {
      const open = (o: Options = {}) => harness({ mode, pilots: [...pilots], ...o });

      it("GET with no row is light / true; a stored choice is served", async () => {
        expect(await read(open().svc)).toEqual({ theme: "light", theme_open: true });
        expect(await read(open({ rows: { [key]: "dark" } }).svc)).toEqual({
          theme: "dark",
          theme_open: true,
        });
      });

      it("GET of a stored value this build does not know is light", async () => {
        expect(await read(open({ rows: { [key]: "high_contrast" } }).svc)).toEqual({
          theme: "light",
          theme_open: true,
        });
      });

      it("PATCH a real change: one row, ONE event in the same transaction, the resulting prefs back", async () => {
        const h = open();
        expect(await write(h.svc, "dark")).toEqual({ theme: "dark", theme_open: true });
        expect(h.store.get(key)).toBe("dark");
        expect(h.events.emit).toHaveBeenCalledTimes(1);
        expect(h.events.emit).toHaveBeenCalledWith({
          event_name: "display_prefs.changed",
          ...envelope,
          payload: { subject_kind: realm, subject_id: subjectId, from: "light", to: "dark" },
          correlationId: "c-2819",
          requestId: "r-2819",
          tx: h.TX,
        });
      });

      it("PATCH a change of a stored choice reports what it replaced", async () => {
        const h = open({ rows: { [key]: "dark" } });
        expect(await write(h.svc, "system")).toEqual({ theme: "system", theme_open: true });
        expect(h.repo.insertTheme).not.toHaveBeenCalled();
        expect(h.repo.updateTheme).toHaveBeenCalledTimes(1);
        expect(h.events.emit).toHaveBeenCalledWith(
          expect.objectContaining({
            payload: expect.objectContaining({ from: "dark", to: "system" }),
          }),
        );
      });

      it.each([
        ["the stored theme again", { [key]: "dark" }, "dark"],
        ["light with no row (no row IS light)", {}, "light"],
      ] as const)("PATCH %s writes nothing and emits nothing", async (_name, rows, theme) => {
        const h = open({ rows: { ...rows } });
        expect(await write(h.svc, theme)).toEqual({ theme, theme_open: true });
        expect(h.repo.insertTheme).not.toHaveBeenCalled();
        expect(h.repo.updateTheme).not.toHaveBeenCalled();
        expect(h.events.emit).not.toHaveBeenCalled();
      });

      it("light → dark → light → dark is three events: no transition key dedupes a real change", async () => {
        const h = open();
        for (const theme of ["dark", "light", "dark", "dark"] as const) await write(h.svc, theme);
        const payloads = h.events.emit.mock.calls.map((call) => (call as unknown[])[0]);
        expect(
          payloads.map((p) => (p as { payload: { from: string; to: string } }).payload),
        ).toEqual([
          { subject_kind: realm, subject_id: subjectId, from: "light", to: "dark" },
          { subject_kind: realm, subject_id: subjectId, from: "dark", to: "light" },
          { subject_kind: realm, subject_id: subjectId, from: "light", to: "dark" },
        ]);
        for (const p of payloads) expect(p).not.toHaveProperty("idempotencyKey");
      });

      it("a lost FIRST-choice race locks the winner's row and decides again", async () => {
        const lost = open({ raceWinner: "system" });
        expect(await write(lost.svc, "dark")).toEqual({ theme: "dark", theme_open: true });
        expect(lost.store.get(key)).toBe("dark");
        expect(lost.events.emit).toHaveBeenCalledWith(
          expect.objectContaining({
            payload: expect.objectContaining({ from: "system", to: "dark" }),
          }),
        );
        // The winner already chose what we asked for: the same no-op as a retry.
        const same = open({ raceWinner: "dark" });
        expect(await write(same.svc, "dark")).toEqual({ theme: "dark", theme_open: true });
        expect(same.events.emit).not.toHaveBeenCalled();
      });

      it("the TOKEN decides the row: another login's row is never read or written", async () => {
        const h = open({ rows: { [key]: "dark", [`${realm}:${OTHER}`]: "system" } });
        expect((await read(h.svc)).theme).toBe("dark");
        await write(h.svc, "light");
        expect(h.store.get(`${realm}:${OTHER}`)).toBe("system");
        for (const call of [...h.repo.findTheme.mock.calls, ...h.repo.lockTheme.mock.calls]) {
          expect(call.slice(0, 2)).toEqual([realm, subjectId]);
        }
      });

      it.each(["42P01", "42703"])(
        "a missing table or column (%s): GET light / false, PATCH 404, ids and SQLSTATE only in the log",
        async (code) => {
          const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
          const h = open({ tableError: pgError(code) });
          expect(await read(h.svc)).toEqual({ theme: "light", theme_open: false });
          await expect(write(h.svc, "dark")).rejects.toBeInstanceOf(NotFoundException);
          expect(h.events.emit).not.toHaveBeenCalled();
          expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
            `display prefs: read failed closed (kind=${realm} id=${subjectId} sqlstate=${code})`,
            `display prefs: write failed closed (kind=${realm} id=${subjectId} sqlstate=${code})`,
          ]);
        },
      );

      it("any OTHER database error propagates: only a missing schema is answered closed", async () => {
        const h = open({ tableError: pgError("57P01") });
        await expect(read(h.svc)).rejects.toThrow(/Failed query/);
        await expect(write(h.svc, "dark")).rejects.toThrow(/Failed query/);
      });

      it("an emit failure rolls the change back with it (the error leaves the transaction)", async () => {
        const h = open();
        h.events.emit.mockRejectedValueOnce(new Error("events insert failed"));
        await expect(write(h.svc, "dark")).rejects.toThrow("events insert failed");
        expect(h.repo.withTransaction).toHaveBeenCalledTimes(1);
      });
    });
  },
);

describe("DisplayPrefsService — the company or agency login", () => {
  it("serves both roles: an agency login gets its own row like an employer", async () => {
    const h = harness({ mode: "on", rows: { [`payer_user:${OTHER}`]: "dark" } });
    expect(await h.svc.readForPayer(payer(OTHER, "agent"))).toEqual({
      theme: "dark",
      theme_open: true,
    });
  });

  it("asks the switch with the TENANT key, but keys the row on the LOGIN (tenancy on, a team member)", async () => {
    const h = harness({ mode: "pilot", pilots: [ANCHOR], tenancy: "on" });
    expect(await h.svc.writeForPayer(payer(MEMBER), "dark", ctx)).toEqual({
      theme: "dark",
      theme_open: true,
    });
    const asked = h.openSpy.mock.calls[0]![0];
    expect(asked).toMatchObject({ kind: "payer", tenantKey: ANCHOR });
    expect(h.store.get(`payer_user:${MEMBER}`)).toBe("dark");
    expect(h.store.has(`payer_user:${ANCHOR}`)).toBe(false);
    // The teammate who never chose is still light: a personal preference, not the company's.
    expect(await h.svc.readForPayer(payer(ANCHOR))).toEqual({ theme: "light", theme_open: true });
  });

  it("with tenancy off a team member is its own tenant: the company's pilot place does not open it", async () => {
    const h = harness({ mode: "pilot", pilots: [ANCHOR], tenancy: "off" });
    expect(await h.svc.readForPayer(payer(MEMBER))).toEqual({ theme: "light", theme_open: false });
  });

  it("a tenancy REFUSAL closes the theme — never a 403 — and adds no log line of ours", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const refusing = {
      resolve: vi.fn(async () => {
        throw new ForbiddenException("Not permitted for this organization");
      }),
    } as unknown as PayerTenantScopeService;
    const h = harness({
      mode: "on",
      resolver: refusing,
      rows: { [`payer_user:${PAYER}`]: "dark" },
    });
    expect(await h.svc.readForPayer(payer())).toEqual({ theme: "light", theme_open: false });
    await expect(h.svc.writeForPayer(payer(), "system", ctx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.repo.findTheme).not.toHaveBeenCalled();
    expect(h.openSpy).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("a tenancy read FAILURE closes the theme and logs the payer id and the SQLSTATE only", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const failing = {
      resolve: vi.fn(async () => {
        throw pgError("08006");
      }),
    } as unknown as PayerTenantScopeService;
    const h = harness({ mode: "on", resolver: failing });
    expect(await h.svc.readForPayer(payer())).toEqual({ theme: "light", theme_open: false });
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      `display prefs: tenancy resolve failed (payer=${PAYER} sqlstate=08006); theme closed`,
    ]);
  });
});

describe("DisplayPrefsService — a caller of the wrong realm answers closed", () => {
  it("an admin caller handed to the worker path opens nothing", async () => {
    const h = harness({ mode: "on" });
    expect(await h.svc.readForWorker(worker(), rolloutCaller.admin(admin()))).toEqual({
      theme: "light",
      theme_open: false,
    });
    await expect(
      h.svc.writeForAdmin(admin(), rolloutCaller.worker(worker()), "dark", ctx),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.openSpy).not.toHaveBeenCalled();
  });
});
