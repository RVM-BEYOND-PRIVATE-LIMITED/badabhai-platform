import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { RvmStudentApiClient, RvmStudentApiUnavailableError } from "./rvm-student-api.client";

const REF = "3c9e7b21-4f6a-4d8e-b1c2-a3d4e5f60718";
const TOKEN = "badabhai-token-for-rvm-0123456789";
const STUDENT = {
  name: "Test Student",
  phone: "9876543210",
  course: "CNC Programming",
  branch: "Faridabad",
  status: "current_student",
  test_score: null,
};

function client(
  respond: (url: string, init: RequestInit) => Promise<Response> | Response,
  config: Partial<ServerConfig> = {},
) {
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => respond(url, init));
  const full = {
    RVM_STUDENT_API_BASE_URL: "http://127.0.0.1:4000/",
    RVM_STUDENT_API_TOKEN: TOKEN,
    RVM_STUDENT_API_TIMEOUT_MS: 5_000,
    ...config,
  } as ServerConfig;
  return {
    api: new RvmStudentApiClient(full, fetchImpl as unknown as typeof fetch),
    fetchImpl,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function failureOf(promise: Promise<unknown>) {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(RvmStudentApiUnavailableError);
  return err as RvmStudentApiUnavailableError;
}

describe("RvmStudentApiClient.readStudent", () => {
  it("reads the six fields with the token in X-Service-Token, the ref escaped into the path", async () => {
    const { api, fetchImpl } = client(() => json(200, STUDENT));

    await expect(api.readStudent(REF)).resolves.toEqual({ kind: "available", student: STUDENT });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`http://127.0.0.1:4000/internal/campus/students/${REF}`);
    expect((init.headers as Record<string, string>)["x-service-token"]).toBe(TOKEN);
  });

  it("answers not_available only for RVM's own refusal body", async () => {
    const { api } = client(() => json(404, { code: "NOT_AVAILABLE" }));
    await expect(api.readStudent(REF)).resolves.toEqual({ kind: "not_available" });
  });

  it("treats a bare 404 as RVM being unreachable, never as a refusal", async () => {
    // A wrong base URL must not read as "every student withdrew consent".
    const { api } = client(() => new Response("Not Found", { status: 404 }));
    expect((await failureOf(api.readStudent(REF))).failure).toBe("http_status");
  });

  it("fails closed on a reply with a key beyond the agreed six", async () => {
    const { api } = client(() => json(200, { ...STUDENT, fee_status: "paid" }));
    expect((await failureOf(api.readStudent(REF))).failure).toBe("contract");
  });

  it("fails closed on a phone that is not ten digits starting 6 to 9", async () => {
    const { api } = client(() => json(200, { ...STUDENT, phone: "+919876543210" }));
    expect((await failureOf(api.readStudent(REF))).failure).toBe("contract");
  });

  it("fails closed on a status RVM does not send", async () => {
    const { api } = client(() => json(200, { ...STUDENT, status: "dropout" }));
    expect((await failureOf(api.readStudent(REF))).failure).toBe("contract");
  });

  it("calls a 5xx unavailable and keeps the body out of the error", async () => {
    const { api } = client(() => json(503, { name: "Test Student", phone: "9876543210" }));
    const err = await failureOf(api.readStudent(REF));
    expect(err.failure).toBe("http_status");
    expect(err.message).not.toContain("9876543210");
    expect(err.message).not.toContain("Test Student");
  });

  it("distinguishes a timeout from a network failure", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const slow = client(() => Promise.reject(timeout));
    expect((await failureOf(slow.api.readStudent(REF))).failure).toBe("timeout");

    const down = client(() => Promise.reject(new TypeError("fetch failed")));
    expect((await failureOf(down.api.readStudent(REF))).failure).toBe("network");
  });

  it("FAILS CLOSED, without calling out, when the base URL or token is not configured", async () => {
    const noUrl = client(() => json(200, STUDENT), { RVM_STUDENT_API_BASE_URL: undefined });
    expect((await failureOf(noUrl.api.readStudent(REF))).failure).toBe("not_configured");
    expect(noUrl.fetchImpl).not.toHaveBeenCalled();

    const noToken = client(() => json(200, STUDENT), { RVM_STUDENT_API_TOKEN: undefined });
    expect((await failureOf(noToken.api.readStudent(REF))).failure).toBe("not_configured");
  });
});
