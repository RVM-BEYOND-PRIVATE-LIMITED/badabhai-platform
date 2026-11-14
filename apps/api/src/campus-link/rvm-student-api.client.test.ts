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
    // A redirect is an error, never followed: the token would ride along to wherever it points.
    expect(init.redirect).toBe("error");
  });

  it("refuses a ref that is not a uuid before anything leaves the process", async () => {
    const { api, fetchImpl } = client(() => json(200, STUDENT));
    await expect(api.readStudent("..")).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed on a reply far larger than six short fields", async () => {
    const { api } = client(() => json(200, { ...STUDENT, name: "x".repeat(20_000) }));
    expect((await failureOf(api.readStudent(REF))).failure).toBe("contract");
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

describe("RvmStudentApiClient.readConsentRequest (#2752 item 10)", () => {
  const REQUEST = "consent-req-000456";
  const COMPANY = "7D3F2A10-5B8E-4C1D-9A6F-0E2B4C6D8F10";

  it("reads the company and each student's answer, lower-casing both refs", async () => {
    const { api, fetchImpl } = client(() =>
      json(200, {
        request_id: REQUEST,
        company: { ref: COMPANY, name: "Sharma Precision Works" },
        students: [{ student_ref: REF.toUpperCase(), state: "yes", text_version: "v1" }],
      }),
    );

    const lookup = await api.readConsentRequest(REQUEST);

    expect(fetchImpl.mock.calls[0]![0]).toBe(
      `http://127.0.0.1:4000/internal/campus/consent-requests/${REQUEST}`,
    );
    expect(lookup).toEqual({
      kind: "found",
      companyRef: COMPANY.toLowerCase(),
      answers: new Map([[REF, "yes"]]),
    });
  });

  it("reads a reply that names no company as binding none", async () => {
    const { api } = client(() => json(200, { request_id: REQUEST, students: [] }));
    await expect(api.readConsentRequest(REQUEST)).resolves.toMatchObject({ companyRef: null });
  });

  it("treats RVM's NOT_AVAILABLE as a refusal and a bare 404 as an outage", async () => {
    const refused = client(() => json(404, { code: "NOT_AVAILABLE" }));
    await expect(refused.api.readConsentRequest(REQUEST)).resolves.toEqual({
      kind: "not_available",
    });
    const bare = client(() => json(404, {}));
    expect((await failureOf(bare.api.readConsentRequest(REQUEST))).failure).toBe("http_status");
  });

  it("refuses a reply for another request, or with an unknown state, as off-contract", async () => {
    const other = client(() => json(200, { request_id: "consent-req-999999", students: [] }));
    expect((await failureOf(other.api.readConsentRequest(REQUEST))).failure).toBe("contract");
    const odd = client(() =>
      json(200, { request_id: REQUEST, students: [{ student_ref: REF, state: "maybe" }] }),
    );
    expect((await failureOf(odd.api.readConsentRequest(REQUEST))).failure).toBe("contract");
  });

  it("refuses a reply that lists one student twice as off-contract, never the last answer", async () => {
    const twice = client(() =>
      json(200, {
        request_id: REQUEST,
        company: { ref: COMPANY },
        students: [
          { student_ref: REF, state: "no" },
          { student_ref: REF.toUpperCase(), state: "yes" },
        ],
      }),
    );
    expect((await failureOf(twice.api.readConsentRequest(REQUEST))).failure).toBe("contract");
  });

  it("refuses a request id that is not a code before anything leaves the process", async () => {
    const { api, fetchImpl } = client(() => json(200, {}));
    await expect(api.readConsentRequest("../students")).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
