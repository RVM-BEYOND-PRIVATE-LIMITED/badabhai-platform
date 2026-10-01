import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

/**
 * The edit page KEYS its form on the posting's saved revision (`updated_at`). The form seeds its
 * state once from `initial`; without the key, a page re-rendered with a newer copy of the posting
 * (a refresh after a save, a concurrent edit) would keep the old values — and the old `initial`
 * that drives the `clear` diff. With it, a new revision remounts a fresh form.
 */

const getPostingDetail = vi.fn();
vi.mock("../../../../../lib/payer-api", () => ({
  getPostingDetail: (id: string) => getPostingDetail(id),
  listMatchSkills: async () => [],
}));
vi.mock("../../../../../lib/auth", () => ({ requirePayer: async () => ({ payerId: "p" }) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("next/link", () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));
const EditPostingFormStub = vi.fn(() => null);
vi.mock("./edit-posting-form", () => ({ EditPostingForm: EditPostingFormStub }));

const { default: EditPostingPage } = await import("./page");

const ID = "11111111-1111-4111-8111-111111111111";

function detail(updatedAt: string) {
  return {
    summary: {
      id: ID,
      roleTitle: "CNC Turner",
      locationLabel: null,
      vacancyBand: "2-5",
      status: "draft",
      applicantCount: 0,
      createdAt: "2026-09-28T10:00:00.000Z",
    },
    card: {
      role_title: "CNC Turner",
      role_kind: "cnc_turner",
      city: "Pune",
      area: null,
      pay_min: null,
      pay_max: null,
      pay_type: null,
      min_experience_years: null,
      max_experience_years: null,
      shift: null,
      needed_by: null,
      requirements: [],
      benefits: [],
    },
    description: null,
    skills: [],
    matchSkillIds: [],
    untickedRelatedIds: [],
    updatedAt,
  };
}

async function formElement(updatedAt: string) {
  getPostingDetail.mockResolvedValueOnce(detail(updatedAt));
  const el = (await EditPostingPage({ params: Promise.resolve({ id: ID }) })) as ReactElement;
  expect(el.type).toBe(EditPostingFormStub);
  return el as ReactElement<{ lead: ReactNode; status: string }>;
}

describe("EditPostingPage — the form is keyed on the saved revision", () => {
  it("passes `updated_at` as the form's key — a newer revision is a NEW form", async () => {
    const first = await formElement("2026-09-29T10:00:00.000Z");
    const second = await formElement("2026-09-29T10:05:00.000Z");
    expect(first.key).toBe("2026-09-29T10:00:00.000Z");
    expect(second.key).toBe("2026-09-29T10:05:00.000Z");
    expect(first.key).not.toBe(second.key);
  });

  it("the page head leads the form column, and its copy no longer claims 'the worker's card'", async () => {
    const el = await formElement("2026-09-29T10:00:00.000Z");
    const text = JSON.stringify(el.props.lead);
    expect(text).toContain("Edit posting");
    expect(text).toContain("The card preview updates as you edit.");
    expect(text).not.toContain("worker’s card as you edit");
    expect(text).not.toContain("worker&rsquo;s card as you edit");
  });
});
