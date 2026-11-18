import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import {
  GUARDS_METADATA,
  HEADERS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { CURRENT_CONSENT_VERSION, EMPLOYER_CONTACT_NOTICE_VERSIONS } from "@badabhai/types";

import { ALLOW_SUSPENDED_KEY } from "../auth/worker-auth.guard";
import { ConsentController } from "./consent.controller";
import { ConsentService } from "./consent.service";

/**
 * #2753 item 13 — `GET /consent/notice`: the notice version and link from the API, so the worker
 * app (#2748) stops hard-coding them. Its shape, its guard (worker-authed, no ConsentGuard: the
 * reader may not have consented yet) and `no-store`.
 */

function service(noticeUrl?: string): ConsentService {
  const config = (noticeUrl === undefined ? {} : { CONSENT_NOTICE_URL: noticeUrl }) as ServerConfig;
  // The notice reads no worker, no row and no event: every other dependency is a bare object,
  // so a call into any of them would throw here.
  return new ConsentService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    config,
  );
}

describe("ConsentService.notice", () => {
  it("serves the current version, the employer-sharing versions and a null link while unset", () => {
    expect(service().notice()).toEqual({
      version: CURRENT_CONSENT_VERSION,
      employer_contact_versions: [...EMPLOYER_CONTACT_NOTICE_VERSIONS],
      notice_url: null,
    });
  });

  it("serves CONSENT_NOTICE_URL when it is set", () => {
    expect(service("https://example.com/privacy").notice().notice_url).toBe(
      "https://example.com/privacy",
    );
  });

  it("hands out a copy: a caller cannot change the shared constant", () => {
    const first = service().notice();
    first.employer_contact_versions.push("1999-01-01");
    expect(EMPLOYER_CONTACT_NOTICE_VERSIONS).not.toContain("1999-01-01");
    expect(service().notice().employer_contact_versions).toEqual([
      ...EMPLOYER_CONTACT_NOTICE_VERSIONS,
    ]);
  });

  it("carries exactly the three fields, nothing about the caller", () => {
    expect(Object.keys(service().notice()).sort()).toEqual([
      "employer_contact_versions",
      "notice_url",
      "version",
    ]);
  });
});

describe("ConsentController.notice — GET /consent/notice", () => {
  const handler = ConsentController.prototype.notice as unknown as object;

  it("delegates to the service", () => {
    const body = { version: "v", employer_contact_versions: [], notice_url: null };
    const consent = { notice: vi.fn(() => body) };
    const controller = new ConsentController(consent as unknown as ConsentService);
    expect(controller.notice()).toBe(body);
    expect(consent.notice).toHaveBeenCalledTimes(1);
  });

  it("is GET notice under /consent", () => {
    expect(Reflect.getMetadata(PATH_METADATA, ConsentController)).toBe("consent");
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe("notice");
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
  });

  it("is worker-authed only: WorkerAuthGuard, no ConsentGuard, suspension not exempted", () => {
    const guards = (Reflect.getMetadata(GUARDS_METADATA, handler) as { name: string }[]).map(
      (g) => g.name,
    );
    expect(guards).toEqual(["WorkerAuthGuard"]);
    expect(Reflect.getMetadata(ALLOW_SUSPENDED_KEY, handler)).toBeUndefined();
  });

  it("is never cached: Cache-Control no-store", () => {
    expect(Reflect.getMetadata(HEADERS_METADATA, handler)).toEqual([
      { name: "Cache-Control", value: "no-store" },
    ]);
  });
});
