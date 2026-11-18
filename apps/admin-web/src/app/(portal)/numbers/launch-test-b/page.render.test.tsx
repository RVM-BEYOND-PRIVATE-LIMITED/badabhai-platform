import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => {
  class RequestError extends Error {
    status: number;
    constructor(status: number) {
      super("request failed");
      this.name = "AdminRequestError";
      this.status = status;
    }
  }
  return { RequestError, gate: [] as string[], report: null as unknown };
});

vi.mock("../../../../lib/auth", () => ({
  requireCapability: async (capability: string) => {
    h.gate.push(capability);
    return { adminId: "a-1", role: "ops_admin", capabilities: [capability] };
  },
}));
vi.mock("../../../../lib/admin-http", () => ({
  isAdminRequestError: (err: unknown) => err instanceof h.RequestError,
  isAdminUnauthorized: () => false,
}));
vi.mock("../../../../lib/numbers", () => ({
  getContactsPerHire: async () => {
    if (h.report instanceof Error) throw h.report;
    return h.report;
  },
}));

const { default: LaunchTestBPage } = await import("./page");

const PAYER = "8a110000-0001-4a00-8000-000000000001";
const POSTING = "2f110000-0001-4a00-8000-000000000001";
const WORKER = "1e110000-0001-4a00-8000-000000000001";

function report() {
  return {
    limit: 50,
    hires: [
      {
        hire_id: "3a110000-0001-4a00-8000-000000000001",
        payer_id: PAYER,
        posting_kind: "company_posting",
        job_posting_id: POSTING,
        worker_id: WORKER,
        confirmed_at: "2026-11-01T00:00:00.000000Z",
        contacts: [
          {
            unlock_id: "4b110000-0001-4a00-8000-000000000001",
            worker_id: WORKER,
            granted_at: "2026-10-30T00:00:00.000000Z",
            outcome: {
              outcome: "hired",
              answered_by: "company",
              answered_at: "2026-11-01T00:00:00.000000Z",
            },
          },
          {
            unlock_id: "4b110000-0001-4a00-8000-000000000002",
            worker_id: null,
            granted_at: "2026-10-29T00:00:00.000000Z",
            outcome: null,
          },
        ],
        contacts_reason: null,
      },
      {
        hire_id: "3a110000-0001-4a00-8000-000000000002",
        payer_id: PAYER,
        posting_kind: "agency_job",
        job_posting_id: null,
        worker_id: WORKER,
        confirmed_at: "2026-11-02T00:00:00.000000Z",
        contacts: null,
        contacts_reason: "agency_job",
      },
    ],
    totals: {
      hires_listed: 2,
      hires_counted: 1,
      contacts_opened: 2,
      contacts_per_hire: { numerator: 2, denominator: 1 },
    },
  };
}

const render = async () =>
  renderToStaticMarkup(await LaunchTestBPage());

beforeEach(() => {
  h.gate.length = 0;
  h.report = report();
});

describe("launch test B", () => {
  it("gates on read_business_numbers", async () => {
    await render();
    expect(h.gate).toEqual(["read_business_numbers"]);
  });

  it("shows the hired contacts, their outcomes and the divided mean", async () => {
    const out = await render();
    expect(out).toContain("Contacts per hire");
    expect(out).toContain("2 contacts over 1 hires");
    expect(out).toContain("Hired");
    expect(out).toContain("No outcome yet");
    expect(out).toContain("worker erased");
  });

  it("shows why a hire has no contact count", async () => {
    const out = await render();
    expect(out).toContain("agency job");
  });

  it("0/0 reads as no hire yet, never as 0", async () => {
    h.report = {
      limit: 50,
      hires: [],
      totals: {
        hires_listed: 0,
        hires_counted: 0,
        contacts_opened: 0,
        contacts_per_hire: { numerator: 0, denominator: 0 },
      },
    };
    const out = await render();
    expect(out).toContain("no hire yet");
    expect(out).toContain("No confirmed hire yet");
  });

  it("a switch-off 404 reads as Not switched on yet", async () => {
    h.report = new h.RequestError(404);
    const out = await render();
    expect(out).toContain("Not switched on yet");
  });

  it("a missing migration 503 reads as Try again later", async () => {
    h.report = new h.RequestError(503);
    const out = await render();
    expect(out).toContain("Try again later");
  });
});
