import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "payer.jwt.token";

vi.mock("./auth/session-cookie", () => ({
  readApiToken: vi.fn(async () => TOKEN),
  API_TOKEN_COOKIE_NAME: "bb_payer_token",
  sessionCookieOptions: () => ({}),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  process.env.PAYER_API_URL = "http://api.test";
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("job-description draft seam (#2719/#2720)", () => {
  it("POSTs snake_case spoken_text + labels and maps is_mock", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ description: "Operate CNC machines.", is_mock: false }),
    );
    const { draftJobDescription } = await import("./payer-api");

    await expect(
      draftJobDescription({
        spokenText: "CNC machine chalani hai",
        tradeLabel: "CNC Turner",
        roleLabel: "Senior Operator",
      }),
    ).resolves.toEqual({ description: "Operate CNC machines.", isMock: false });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/payer/job-postings/description/draft");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init.body))).toEqual({
      spoken_text: "CNC machine chalani hai",
      trade_label: "CNC Turner",
      role_label: "Senior Operator",
    });
  });

  it("omits absent labels (the route's schema is optional, never nullable)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ description: null, is_mock: true }));
    const { draftJobDescription } = await import("./payer-api");

    await expect(draftJobDescription({ spokenText: "welding ka kaam" })).resolves.toEqual({
      description: null,
      isMock: true,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ spoken_text: "welding ka kaam" });
  });
});
