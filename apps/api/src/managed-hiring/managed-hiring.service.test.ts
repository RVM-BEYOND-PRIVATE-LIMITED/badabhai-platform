/**
 * #2751 items 4 to 13 — ManagedHiringService on in-memory fakes: the switch and payment gates, the
 * agency refusal, the tier and price, the checkout (one open order per job, handed back when
 * unpaid), the activation on capture, the sweep (met / extended / closed not met), the tracker's
 * rules (consent, RVM-applied, open clock, met during the extension) and the callback request.
 */
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { ManagedHiringInterestRow, ManagedHiringOrderRow, PaymentOrder } from "@badabhai/db";
import { DEFAULT_CATALOG } from "@badabhai/pricing";
import type { ManagedHiringOrderStatus, VacancyBand } from "@badabhai/types";

import { PaidOrderSettlers } from "../unlocks/paid-order-settlers";
import { ManagedHiringService } from "./managed-hiring.service";
import type { ManagedHiringJobRow, NewManagedHiringOrder } from "./managed-hiring.repository";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const WORKER = "44444444-4444-4444-8444-444444444444";
const ADMIN = "55555555-5555-4555-8555-555555555555";
const CTX = { correlationId: "66666666-6666-4666-8666-666666666666", requestId: "req-1" };

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

class FakeRepo {
  jobs = new Map<string, ManagedHiringJobRow & { payerId: string }>();
  orders = new Map<string, ManagedHiringOrderRow>();
  interest: ManagedHiringInterestRow[] = [];
  callbacks: {
    id: string;
    jobPostingId: string;
    payerId: string;
    vacancyBand: VacancyBand;
    reason: "above_largest_tier";
    isTest: boolean;
    requestedBy: string;
    createdAt: Date;
  }[] = [];
  audits: { action: string; metadata: Record<string, unknown> }[] = [];
  role: "employer" | "agent" = "employer";
  reachable = true;
  rvm = false;
  applied = false;

  withTransaction<T>(work: (tx: never) => Promise<T>): Promise<T> {
    return work({} as never);
  }
  async companyFacts() {
    return { role: this.role, isTest: false };
  }
  async findOwnJob(tenant: string, id: string) {
    const j = this.jobs.get(id);
    return j && j.payerId === tenant ? j : undefined;
  }
  async findOpenOrderForJob(jobId: string) {
    return [...this.orders.values()].find(
      (o) => o.jobPostingId === jobId && ["created", "active", "extended"].includes(o.status),
    );
  }
  async insertOrderWithinTx(_tx: unknown, o: NewManagedHiringOrder) {
    if (await this.findOpenOrderForJob(o.jobPostingId)) return undefined;
    const row: ManagedHiringOrderRow = {
      ...o,
      id: uuid(),
      status: "created",
      startedAt: null,
      dueAt: null,
      extendedUntil: null,
      extendedAt: null,
      endedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.orders.set(row.id, row);
    return row;
  }
  async findOrderByPaymentOrder(paymentOrderId: string) {
    return [...this.orders.values()].find((o) => o.paymentOrderId === paymentOrderId);
  }
  async findOrderForTenant(tenant: string, id: string) {
    const o = this.orders.get(id);
    return o && o.payerId === tenant
      ? { ...o, confirmedCount: await this.countInterest(id) }
      : undefined;
  }
  async listOrdersForTenant(tenant: string) {
    return Promise.all(
      [...this.orders.values()]
        .filter((o) => o.payerId === tenant)
        .map(async (o) => ({ ...o, confirmedCount: await this.countInterest(o.id) })),
    );
  }
  async getOrder(id: string) {
    const o = this.orders.get(id);
    return o ? { ...o, confirmedCount: await this.countInterest(id) } : undefined;
  }
  async lockOrder(_tx: unknown, id: string) {
    return this.orders.get(id);
  }
  async activateWithinTx(
    _tx: unknown,
    id: string,
    c: { startedAt: Date; dueAt: Date; extendedUntil: Date },
  ) {
    const o = this.orders.get(id);
    if (!o || o.status !== "created") return undefined;
    const next = { ...o, status: "active" as const, ...c };
    this.orders.set(id, next);
    return next;
  }
  async moveWithinTx(
    _tx: unknown,
    id: string,
    from: ManagedHiringOrderStatus,
    to: "extended" | "met" | "closed_unmet",
    at: Date,
  ) {
    const o = this.orders.get(id);
    if (!o || o.status !== from) return undefined;
    const next = {
      ...o,
      status: to,
      ...(to === "extended" ? { extendedAt: at } : { endedAt: at }),
    };
    this.orders.set(id, next);
    return next;
  }
  async dueOrderIds(_limit: number, now: Date) {
    return [...this.orders.values()]
      .filter(
        (o) =>
          (o.status === "active" && o.dueAt !== null && o.dueAt <= now) ||
          (o.status === "extended" && o.extendedUntil !== null && o.extendedUntil <= now),
      )
      .map((o) => o.id);
  }
  async countInterest(orderId: string) {
    return this.interest.filter((i) => i.orderId === orderId).length;
  }
  async listInterest(orderId: string) {
    return this.interest.filter((i) => i.orderId === orderId);
  }
  async insertInterestWithinTx(
    _tx: unknown,
    r: { orderId: string; payerId: string; workerId: string; confirmedBy: string; note: string },
  ) {
    if (this.interest.some((i) => i.orderId === r.orderId && i.workerId === r.workerId))
      return undefined;
    const row = { ...r, id: uuid(), confirmedAt: new Date() };
    this.interest.push(row);
    return row;
  }
  async deleteInterestWithinTx(_tx: unknown, orderId: string, workerId: string) {
    const at = this.interest.findIndex((i) => i.orderId === orderId && i.workerId === workerId);
    if (at < 0) return undefined;
    return this.interest.splice(at, 1)[0];
  }
  async isWorkerReachable() {
    return this.reachable;
  }
  async isRvmStudent() {
    return this.rvm;
  }
  async hasAppliedTo() {
    return this.applied;
  }
  async findCallbackForJob(jobId: string) {
    return this.callbacks.find((c) => c.jobPostingId === jobId);
  }
  async insertCallbackWithinTx(
    _tx: unknown,
    r: Omit<FakeRepo["callbacks"][number], "id" | "createdAt">,
  ) {
    if (this.callbacks.some((c) => c.jobPostingId === r.jobPostingId)) return undefined;
    const row = { ...r, id: uuid(), createdAt: new Date() };
    this.callbacks.push(row);
    return row;
  }
  async audit(_tx: unknown, e: { action: string; metadata: Record<string, unknown> }) {
    this.audits.push(e);
  }
}

function setup(
  opts: { rollout?: "on" | "off" | "unavailable"; real?: boolean; anywhere?: boolean } = {},
) {
  const repo = new FakeRepo();
  repo.jobs.set(JOB, {
    id: JOB,
    payerId: TENANT,
    status: "open",
    hiddenAt: null,
    vacancyBand: "2-5",
    minExperienceYears: null,
    roleKind: "cnc_turner",
    tradeLevel: null,
  });
  const events: {
    event_name: string;
    payload: Record<string, unknown>;
    idempotencyKey?: string;
  }[] = [];
  const mails: { kind: string; to: string }[] = [];
  const payments = new Map<string, PaymentOrder>();
  const created: string[] = [];
  const checkout = {
    realPaymentsLive: opts.real ?? true,
    async create(
      _t: string,
      input: { line: { totalPaise: number } },
      withinTx: (tx: never, p: PaymentOrder) => Promise<ManagedHiringOrderRow>,
    ) {
      const payment = {
        id: uuid(),
        providerOrderId: `order_${seq}`,
        status: "created",
        productKind: "managed_hiring",
        totalPaise: input.line.totalPaise,
      } as unknown as PaymentOrder;
      payments.set(payment.id, payment);
      created.push(payment.id);
      const result = await withinTx({} as never, payment);
      return {
        handoff: {
          orderRowId: payment.id,
          providerOrderId: payment.providerOrderId,
          keyId: "rzp_test",
          amountInr: input.line.totalPaise / 100,
          amountPaise: input.line.totalPaise,
          currency: "INR",
          price: input.line,
        },
        result,
      };
    },
    handoffFor(p: PaymentOrder) {
      return {
        orderRowId: p.id,
        providerOrderId: p.providerOrderId,
        keyId: "rzp_test",
        amountInr: 4720,
        amountPaise: 472_000,
        currency: "INR",
        price: {
          taxablePaise: 400_000,
          gstPaise: 72_000,
          roundOffPaise: 0,
          totalPaise: 472_000,
          gstRateBps: 1800,
        },
      };
    },
    async findOrderById(id: string) {
      return payments.get(id);
    },
  };
  const settlers = new PaidOrderSettlers();
  const consents = {
    findLatestByWorker: vi.fn(async () => ({ revokedAt: null, purposes: ["employer_sharing"] })),
  };
  const svc = new ManagedHiringService(
    repo as never,
    {
      stateFor: async () => opts.rollout ?? "on",
      isLiveForServiceCaller: () => opts.anywhere ?? (opts.rollout ?? "on") === "on",
    } as never,
    { resolve: async () => ({ actorPayerId: ACTOR, tenantKey: TENANT }) } as never,
    {
      getActiveCatalog: async () => ({ catalog: DEFAULT_CATALOG, revision: 0, source: "default" }),
    } as never,
    checkout as never,
    settlers,
    consents as never,
    {
      emit: async (e: (typeof events)[number]) => {
        events.push(e);
      },
    } as never,
    {
      notify: async (to: string, _o: string, n: { kind: string }) => {
        mails.push({ kind: n.kind, to });
      },
    } as never,
  );
  svc.onModuleInit();
  return { svc, repo, events, mails, payments, created, settlers, consents };
}

async function paidOrder(env: ReturnType<typeof setup>) {
  const checkout = await env.svc.createOrder(ACTOR, { jobPostingId: JOB }, CTX);
  const order = env.repo.orders.get(checkout.order_id)!;
  const payment = env.payments.get(order.paymentOrderId)!;
  const settler = env.settlers.forKind("managed_hiring")!;
  const plan = await settler.prepare(payment);
  await settler.settleWithinTx({} as never, payment, plan, CTX);
  await settler.afterCommit?.(payment, CTX);
  return env.repo.orders.get(order.id)!;
}

describe("the gates", () => {
  it("off for the company: the neutral 404, nothing read", async () => {
    const { svc } = setup({ rollout: "off" });
    await expect(svc.quote(ACTOR, JOB)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.createOrder(ACTOR, { jobPostingId: JOB }, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("a pilot list that cannot be read: 503, never an order", async () => {
    const { svc } = setup({ rollout: "unavailable" });
    await expect(svc.assertOpenFor(ACTOR)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("real payments off: not offered at all (no mock order for a free service)", async () => {
    const { svc } = setup({ real: false });
    await expect(svc.quote(ACTOR, JOB)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("an agency or contractor account: 403 agency_account (B4C-19)", async () => {
    const env = setup();
    env.repo.role = "agent";
    await expect(env.svc.quote(ACTOR, JOB)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(env.svc.createOrder(ACTOR, { jobPostingId: JOB }, CTX)).rejects.toMatchObject({
      response: { reason: "agency_account" },
    });
  });

  it("another company's job or an unknown one: 404; a job not live: 409 job_not_open", async () => {
    const env = setup();
    await expect(
      env.svc.quote(ACTOR, "77777777-7777-4777-8777-777777777777"),
    ).rejects.toBeInstanceOf(NotFoundException);
    env.repo.jobs.set(JOB, { ...env.repo.jobs.get(JOB)!, status: "draft" });
    await expect(env.svc.quote(ACTOR, JOB)).rejects.toMatchObject({
      response: { reason: "job_not_open" },
    });
  });
});

describe("the quote: the server picks the tier and the price", () => {
  const priceFor = async (over: Partial<ManagedHiringJobRow>) => {
    const env = setup();
    env.repo.jobs.set(JOB, { ...env.repo.jobs.get(JOB)!, ...over });
    return env.svc.quote(ACTOR, JOB);
  };

  it("1 to 5 vacancies, fresher to mid: Standard, ₹4,000 + GST = ₹4,720 (B2-31)", async () => {
    const q = await priceFor({ vacancyBand: "2-5" });
    expect(q).toMatchObject({
      offer: "order",
      tier: "standard",
      price: { price_inr: 4000, taxable_paise: 400_000, gst_paise: 72_000, total_paise: 472_000 },
      target_count: 5,
      working_days: 7,
      extension_days: 30,
      open_order: null,
    });
  });

  it("6 to 10 vacancies, or a 3+ year job: Large, ₹9,440 (B2-33)", async () => {
    expect(await priceFor({ vacancyBand: "6-10" })).toMatchObject({
      tier: "large",
      price: { total_paise: 944_000 },
    });
    expect(await priceFor({ minExperienceYears: 4 })).toMatchObject({
      tier: "large",
      price: { total_paise: 944_000 },
    });
  });

  it("11+ vacancies: a callback offer, no price (B7-05)", async () => {
    const q = await priceFor({ vacancyBand: "11-25" });
    expect(q).toEqual({
      job_posting_id: JOB,
      offer: "callback",
      vacancy_band: "11-25",
      terms: expect.stringContaining("does not promise a hire"),
      callback_request_id: null,
    });
  });
});

describe("the checkout", () => {
  it("creates one unpaid order with its event; the handoff charges the GST total", async () => {
    const env = setup();
    const checkout = await env.svc.createOrder(
      ACTOR,
      { jobPostingId: JOB, expectedPriceInr: 4000 },
      CTX,
    );
    expect(checkout).toMatchObject({
      amount: 472_000,
      amount_inr: 4720,
      currency: "INR",
      key_id: "rzp_test",
    });
    const order = env.repo.orders.get(checkout.order_id)!;
    expect(order).toMatchObject({
      status: "created",
      tier: "standard",
      priceInr: 4000,
      targetCount: 5,
      createdBy: ACTOR,
      payerId: TENANT,
    });
    expect(env.events.map((e) => e.event_name)).toEqual(["managed_hiring.order_created"]);
    expect(env.events[0]!.payload).toMatchObject({
      tier: "standard",
      price_inr: 4000,
      total_paise: 472_000,
    });
  });

  it("a confirmed price that is not the list price: 409 price_mismatch, nothing created", async () => {
    const env = setup();
    await expect(
      env.svc.createOrder(ACTOR, { jobPostingId: JOB, expectedPriceInr: 3999 }, CTX),
    ).rejects.toMatchObject({
      response: { reason: "price_mismatch" },
    });
    expect(env.created).toHaveLength(0);
  });

  it("a job above the largest tier gets no checkout: 409 above_largest_tier", async () => {
    const env = setup();
    env.repo.jobs.set(JOB, { ...env.repo.jobs.get(JOB)!, vacancyBand: "25+" });
    await expect(env.svc.createOrder(ACTOR, { jobPostingId: JOB }, CTX)).rejects.toMatchObject({
      response: { reason: "above_largest_tier" },
    });
    expect(env.created).toHaveLength(0);
  });

  it("an unpaid order is handed back (no second provider order); a running one is 409 order_open", async () => {
    const env = setup();
    const first = await env.svc.createOrder(ACTOR, { jobPostingId: JOB }, CTX);
    const again = await env.svc.createOrder(ACTOR, { jobPostingId: JOB }, CTX);
    expect(again.order_id).toBe(first.order_id);
    expect(env.created).toHaveLength(1);
    const env2 = setup();
    await paidOrder(env2);
    await expect(env2.svc.createOrder(ACTOR, { jobPostingId: JOB }, CTX)).rejects.toMatchObject({
      response: { reason: "order_open" },
    });
  });
});

describe("a failed payment attempt", () => {
  it("leaves the unpaid order payable: the same checkout is handed back, and shown on the order", async () => {
    const env = setup();
    const first = await env.svc.createOrder(ACTOR, { jobPostingId: JOB }, CTX);
    const order = env.repo.orders.get(first.order_id)!;
    const payment = env.payments.get(order.paymentOrderId)!;
    env.payments.set(payment.id, { ...payment, status: "failed" } as PaymentOrder);
    const again = await env.svc.createOrder(ACTOR, { jobPostingId: JOB }, CTX);
    expect(again.order_id).toBe(first.order_id);
    expect(env.created).toHaveLength(1);
    expect((await env.svc.getOrder(ACTOR, first.order_id)).checkout).not.toBeNull();
  });
});

describe("activation on payment capture (the settler)", () => {
  it("the order starts only on capture: active, clock stamped, one event, the company emailed", async () => {
    const env = setup();
    const order = await paidOrder(env);
    expect(order.status).toBe("active");
    expect(order.startedAt).toBeInstanceOf(Date);
    expect(order.dueAt!.getTime()).toBeGreaterThan(order.startedAt!.getTime());
    expect(order.extendedUntil!.getTime()).toBeGreaterThanOrEqual(order.dueAt!.getTime());
    expect(env.events.map((e) => e.event_name)).toEqual([
      "managed_hiring.order_created",
      "managed_hiring.order_activated",
    ]);
    expect(env.mails).toEqual([{ kind: "activated", to: ACTOR }]);
  });

  it("a replayed capture changes nothing (the order is no longer created)", async () => {
    const env = setup();
    const order = await paidOrder(env);
    const payment = env.payments.get(order.paymentOrderId)!;
    const settler = env.settlers.forKind("managed_hiring")!;
    await settler.settleWithinTx({} as never, payment, await settler.prepare(payment), CTX);
    expect(env.repo.orders.get(order.id)).toEqual(order);
    expect(
      env.events.filter((e) => e.event_name === "managed_hiring.order_activated"),
    ).toHaveLength(1);
  });

  it("a payment with no Managed Hiring order is refused before the claim (the webhook retries)", async () => {
    const env = setup();
    const settler = env.settlers.forKind("managed_hiring")!;
    await expect(settler.prepare({ id: uuid() } as PaymentOrder)).rejects.toThrow(
      /no managed hiring order/,
    );
  });
});

describe("the sweep (the clock)", () => {
  const after = (d: Date | null) => new Date(d!.getTime() + 1000);

  async function withWorkers(n: number) {
    const env = setup();
    const order = await paidOrder(env);
    for (let i = 0; i < n; i += 1) {
      env.repo.interest.push({
        id: uuid(),
        orderId: order.id,
        payerId: TENANT,
        workerId: uuid(),
        confirmedBy: ADMIN,
        confirmedAt: new Date(),
        note: "confirmed on call",
      });
    }
    env.events.length = 0;
    env.mails.length = 0;
    return { env, order };
  }

  it("nothing while the switch is off everywhere", async () => {
    const env = setup({ anywhere: false });
    expect(await env.svc.sweepDue(10)).toEqual({ skipped: true, due: 0, moved: 0, failed: 0 });
  });

  it("not yet due: nothing moves", async () => {
    const { env } = await withWorkers(0);
    expect(await env.svc.sweepDue(10, new Date())).toMatchObject({ due: 0, moved: 0 });
  });

  it("5 confirmed at the deadline: met (B2-32), the company told", async () => {
    const { env, order } = await withWorkers(5);
    await env.svc.sweepDue(10, after(order.dueAt));
    expect(env.repo.orders.get(order.id)!.status).toBe("met");
    expect(env.events[0]).toMatchObject({
      event_name: "managed_hiring.order_met",
      payload: { confirmed_count: 5, met_at: "deadline" },
    });
    expect(env.mails).toEqual([{ kind: "met", to: ACTOR }]);
  });

  it("4 confirmed at the deadline: extended at no charge, to no later than day 30 (B4B-35)", async () => {
    const { env, order } = await withWorkers(4);
    await env.svc.sweepDue(10, after(order.dueAt));
    const extended = env.repo.orders.get(order.id)!;
    expect(extended.status).toBe("extended");
    expect(extended.extendedUntil).toEqual(order.extendedUntil);
    expect(env.events[0]).toMatchObject({
      event_name: "managed_hiring.order_extended",
      payload: { confirmed_count: 4, target_count: 5 },
    });
    expect(env.mails).toEqual([{ kind: "extended", to: ACTOR }]);
  });

  it("still below target at the extension's end: closed not met, the admin alert event, no refund", async () => {
    const { env, order } = await withWorkers(3);
    await env.svc.sweepDue(10, after(order.dueAt));
    env.events.length = 0;
    await env.svc.sweepDue(10, after(order.extendedUntil));
    expect(env.repo.orders.get(order.id)!.status).toBe("closed_unmet");
    expect(env.events.map((e) => e.event_name)).toEqual(["managed_hiring.order_closed_unmet"]);
  });
});

describe("the tracker", () => {
  const NOTE = "Called him, he is interested and can come Monday";

  it("adds a phone-confirmed worker: the event (no note), the audit row (with the note)", async () => {
    const env = setup();
    const order = await paidOrder(env);
    env.events.length = 0;
    const view = await env.svc.addInterest(ADMIN, order.id, WORKER, NOTE, CTX);
    expect(view.confirmed_count).toBe(1);
    expect(view.workers[0]).toMatchObject({ worker_id: WORKER, confirmed_by: ADMIN, note: NOTE });
    expect(env.events).toHaveLength(1);
    expect(env.events[0]).toMatchObject({
      event_name: "managed_hiring.interest_added",
      payload: { worker_id: WORKER, confirmed_count: 1 },
    });
    expect(JSON.stringify(env.events[0]!.payload)).not.toContain(NOTE);
    expect(env.repo.audits[0]).toMatchObject({
      action: "managed_hiring_interest_added",
      metadata: { note: NOTE },
    });
  });

  it("refuses: twice on one order, no consent, deleted or suspended, an RVM student who did not apply", async () => {
    const env = setup();
    const order = await paidOrder(env);
    await env.svc.addInterest(ADMIN, order.id, WORKER, NOTE, CTX);
    await expect(env.svc.addInterest(ADMIN, order.id, WORKER, NOTE, CTX)).rejects.toMatchObject({
      response: { reason: "already_on_tracker" },
    });

    const other = uuid();
    env.consents.findLatestByWorker.mockResolvedValueOnce({
      revokedAt: null,
      purposes: ["profiling"],
    });
    await expect(env.svc.addInterest(ADMIN, order.id, other, NOTE, CTX)).rejects.toMatchObject({
      response: { reason: "no_sharing_consent" },
    });

    env.repo.reachable = false;
    await expect(env.svc.addInterest(ADMIN, order.id, other, NOTE, CTX)).rejects.toMatchObject({
      response: { reason: "worker_unavailable" },
    });
    env.repo.reachable = true;

    env.repo.rvm = true;
    await expect(env.svc.addInterest(ADMIN, order.id, other, NOTE, CTX)).rejects.toMatchObject({
      response: { reason: "rvm_student_not_applied" },
    });
    env.repo.applied = true;
    await expect(env.svc.addInterest(ADMIN, order.id, other, NOTE, CTX)).resolves.toMatchObject({
      confirmed_count: 2,
    });
  });

  it("an unpaid or ended order's tracker is closed: 409 order_not_open", async () => {
    const env = setup();
    const checkout = await env.svc.createOrder(ACTOR, { jobPostingId: JOB }, CTX);
    await expect(
      env.svc.addInterest(ADMIN, checkout.order_id, WORKER, NOTE, CTX),
    ).rejects.toMatchObject({ response: { reason: "order_not_open" } });
  });

  it("during the free extension, the confirmation that reaches the target marks the order met at once", async () => {
    const env = setup();
    const order = await paidOrder(env);
    for (let i = 0; i < 4; i += 1) await env.svc.addInterest(ADMIN, order.id, uuid(), NOTE, CTX);
    await env.svc.sweepDue(10, new Date(order.dueAt!.getTime() + 1));
    expect(env.repo.orders.get(order.id)!.status).toBe("extended");
    env.mails.length = 0;
    const view = await env.svc.addInterest(ADMIN, order.id, uuid(), NOTE, CTX);
    expect(view.status).toBe("met");
    expect(env.events.at(-1)).toMatchObject({
      event_name: "managed_hiring.order_met",
      payload: { met_at: "extension", confirmed_count: 5 },
    });
    expect(env.mails).toEqual([{ kind: "met", to: ACTOR }]);
  });

  it("before the deadline the 5th confirmation leaves the order open (met at the deadline)", async () => {
    const env = setup();
    const order = await paidOrder(env);
    for (let i = 0; i < 5; i += 1) await env.svc.addInterest(ADMIN, order.id, uuid(), NOTE, CTX);
    expect(env.repo.orders.get(order.id)!.status).toBe("active");
  });

  it("removes a worker with a reason on the audit row; an unknown one is 404", async () => {
    const env = setup();
    const order = await paidOrder(env);
    await env.svc.addInterest(ADMIN, order.id, WORKER, NOTE, CTX);
    const view = await env.svc.removeInterest(
      ADMIN,
      order.id,
      WORKER,
      "Added by mistake, wrong person",
      CTX,
    );
    expect(view.confirmed_count).toBe(0);
    expect(env.events.at(-1)).toMatchObject({
      event_name: "managed_hiring.interest_removed",
      payload: { confirmed_count: 0 },
    });
    expect(env.repo.audits.at(-1)).toMatchObject({
      action: "managed_hiring_interest_removed",
      metadata: { reason_text: "Added by mistake, wrong person" },
    });
    await expect(
      env.svc.removeInterest(ADMIN, order.id, WORKER, "Added by mistake, wrong person", CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("the company reads the count and the list, never the note or the staff member", async () => {
    const env = setup();
    const order = await paidOrder(env);
    await env.svc.addInterest(ADMIN, order.id, WORKER, NOTE, CTX);
    const view = await env.svc.getOrder(ACTOR, order.id);
    expect(view).toMatchObject({ status: "active", confirmed_count: 1, target_count: 5 });
    expect(view.workers).toEqual([{ worker_id: WORKER, confirmed_at: expect.any(String) }]);
    expect(JSON.stringify(view)).not.toContain(NOTE);
    expect(JSON.stringify(view)).not.toContain(ADMIN);
  });
});

describe("the callback request (jobs above the largest tier)", () => {
  it("is stored once per job with an admin-alert event; asking again alerts nobody", async () => {
    const env = setup();
    env.repo.jobs.set(JOB, { ...env.repo.jobs.get(JOB)!, vacancyBand: "11-25" });
    const first = await env.svc.requestCallback(ACTOR, JOB, CTX);
    const again = await env.svc.requestCallback(ACTOR, JOB, CTX);
    expect(first.created).toBe(true);
    expect(again).toEqual({ ...first, created: false });
    expect(env.events.map((e) => e.event_name)).toEqual(["managed_hiring.callback_requested"]);
  });

  it("a job a tier covers needs no call: 409 tier_available", async () => {
    const env = setup();
    await expect(env.svc.requestCallback(ACTOR, JOB, CTX)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
