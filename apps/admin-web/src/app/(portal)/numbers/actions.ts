"use server";

import { z } from "zod";
import { adminFetch } from "../../../lib/admin-http";
import type {
  AdminActionFailure,
  AdminActionSuccess,
} from "../../../lib/admin-action-result";
import { describeNumbersActionError } from "../../../lib/numbers-errors";
import {
  CREDIT_CALL_RESULTS,
  LAUNCH_TEST_CITY_GROUPS,
  LAUNCH_TEST_RESULTS,
  LAUNCH_TEST_TRADE_GROUPS,
  TEST_COMPANY_REASONS,
  type CreditCallResult,
  type LaunchTestCityGroup,
  type LaunchTestResult,
  type LaunchTestTradeGroup,
  type TestCompanyReason,
} from "../../../lib/numbers-vocabulary";

/**
 * Governed writes of the numbers screen (#2884).
 *
 * The two numbers writes and both launch-test writes take the REQUIRED Idempotency-Key header.
 * The key is minted by the client per tap and reused on a retry, so this action never invents one:
 * a retry of the same operator intent must reach the API as the same request.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/;
const E164 = /^\+[1-9]\d{7,14}$/;
const LINK_REF = /^[!-~]{1,300}$/;

const UUID_MESSAGE = "That id is not valid, so nothing was sent to the admin API.";
const KEY_MESSAGE = "A request key is required. Reload the page and try again.";

const testAccountResultSchema = z.object({
  payer_id: z.string(),
  is_test_account: z.boolean(),
  changed: z.boolean(),
});

const loggedCallSchema = z.object({
  call: z.object({
    id: z.string(),
    payer_id: z.string(),
    called_at: z.string(),
    result: z.enum(CREDIT_CALL_RESULTS),
    admin_id: z.string(),
  }),
  created: z.boolean(),
});

const launchFactoryResultSchema = z.object({
  factory: z.object({ id: z.string() }),
  created: z.boolean().optional(),
  changed: z.boolean().optional(),
});

function failure(error: string): AdminActionFailure {
  return { ok: false, error };
}

function success(message: string, changed: boolean): AdminActionSuccess {
  return { ok: true, changed, message };
}

function idempotencyHeaders(key: string): Record<string, string> {
  return { "idempotency-key": key };
}

// ---------------------------------------------------------------------------
// Test companies
// ---------------------------------------------------------------------------

export async function markTestCompanyAction(
  payerId: string,
  reason: TestCompanyReason,
  idempotencyKey: string,
): Promise<AdminActionSuccess | AdminActionFailure> {
  if (!UUID.test(payerId)) return failure(UUID_MESSAGE);
  if (!TEST_COMPANY_REASONS.includes(reason)) return failure("Choose why this is a test company.");
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) return failure(KEY_MESSAGE);
  try {
    const result = await adminFetch(
      `/admin/numbers/test-accounts/${encodeURIComponent(payerId)}`,
      {
        method: "PUT",
        body: { reason },
        headers: idempotencyHeaders(idempotencyKey),
        schema: testAccountResultSchema,
      },
    );
    return success(
      result.changed
        ? "Marked as a test company. It is left out of every company figure."
        : "Already a test company — no change.",
      result.changed,
    );
  } catch (err) {
    return failure(describeNumbersActionError(err));
  }
}

export async function unmarkTestCompanyAction(
  payerId: string,
): Promise<AdminActionSuccess | AdminActionFailure> {
  if (!UUID.test(payerId)) return failure(UUID_MESSAGE);
  try {
    const result = await adminFetch(
      `/admin/numbers/test-accounts/${encodeURIComponent(payerId)}`,
      { method: "DELETE", schema: testAccountResultSchema },
    );
    return success(
      result.changed
        ? "Unmarked. The company counts again."
        : "Not a test company — no change.",
      result.changed,
    );
  } catch (err) {
    return failure(describeNumbersActionError(err));
  }
}

// ---------------------------------------------------------------------------
// Out-of-credits call list
// ---------------------------------------------------------------------------

export async function logCreditCallAction(
  payerId: string,
  result: CreditCallResult,
  idempotencyKey: string,
): Promise<AdminActionSuccess | AdminActionFailure> {
  if (!UUID.test(payerId)) return failure(UUID_MESSAGE);
  if (!CREDIT_CALL_RESULTS.includes(result)) return failure("Choose what the call came to.");
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) return failure(KEY_MESSAGE);
  try {
    const answer = await adminFetch(
      `/admin/numbers/out-of-credits/${encodeURIComponent(payerId)}/calls`,
      {
        method: "POST",
        body: { result },
        headers: idempotencyHeaders(idempotencyKey),
        schema: loggedCallSchema,
      },
    );
    return success(answer.created ? "Call logged." : "That call was already logged.", answer.created);
  } catch (err) {
    return failure(describeNumbersActionError(err));
  }
}

// ---------------------------------------------------------------------------
// Launch test A
// ---------------------------------------------------------------------------

const launchFactoryInputSchema = z
  .object({
    factoryName: z.string().trim().min(1).max(200),
    factoryPhone: z.string().trim().regex(E164).optional(),
    cityGroup: z.enum(LAUNCH_TEST_CITY_GROUPS),
    tradeGroup: z.enum(LAUNCH_TEST_TRADE_GROUPS),
    sentAt: z.string().datetime({ offset: true }),
    workerIds: z.array(z.string().regex(UUID)).min(1).max(5),
    payerId: z.string().regex(UUID).optional(),
    paymentLinkRef: z.string().trim().regex(LINK_REF).optional(),
    linkCreatedAt: z.string().datetime({ offset: true }).optional(),
    idempotencyKey: z.string().regex(IDEMPOTENCY_KEY),
  })
  .refine((value) => new Set(value.workerIds).size === value.workerIds.length, {
    message: "Each worker can be sent once.",
  })
  .refine((value) => value.linkCreatedAt === undefined || value.paymentLinkRef !== undefined, {
    message: "A link time needs a payment link.",
  });

export interface RecordLaunchFactoryInput {
  factoryName: string;
  factoryPhone?: string;
  cityGroup: LaunchTestCityGroup;
  tradeGroup: LaunchTestTradeGroup;
  sentAt: string;
  workerIds: string[];
  payerId?: string;
  paymentLinkRef?: string;
  linkCreatedAt?: string;
  idempotencyKey: string;
}

export async function recordLaunchFactoryAction(
  input: RecordLaunchFactoryInput,
): Promise<AdminActionSuccess | AdminActionFailure> {
  const parsed = launchFactoryInputSchema.safeParse(input);
  if (!parsed.success) {
    return failure(parsed.error.issues[0]?.message ?? "Check the factory details.");
  }
  const { idempotencyKey, ...values } = parsed.data;
  const body: Record<string, unknown> = {
    factory_name: values.factoryName,
    city_group: values.cityGroup,
    trade_group: values.tradeGroup,
    sent_at: values.sentAt,
    worker_ids: values.workerIds,
  };
  if (values.factoryPhone) body.factory_phone = values.factoryPhone;
  if (values.payerId) body.payer_id = values.payerId;
  if (values.paymentLinkRef) body.payment_link_ref = values.paymentLinkRef;
  if (values.linkCreatedAt) body.link_created_at = values.linkCreatedAt;
  try {
    const answer = await adminFetch("/admin/launch-tests/cohort", {
      method: "POST",
      body,
      headers: idempotencyHeaders(idempotencyKey),
      schema: launchFactoryResultSchema,
    });
    return success(
      answer.created === false
        ? "This factory was already recorded — no change."
        : "Factory recorded. Nothing was sent or charged.",
      answer.created !== false,
    );
  } catch (err) {
    return failure(describeNumbersActionError(err));
  }
}

const launchFactoryUpdateSchema = z
  .object({
    paymentLinkRef: z.string().trim().regex(LINK_REF).nullable().optional(),
    linkCreatedAt: z.string().datetime({ offset: true }).nullable().optional(),
    result: z.enum(LAUNCH_TEST_RESULTS).optional(),
    paidAt: z.string().datetime({ offset: true }).nullable().optional(),
    payerId: z.string().regex(UUID).nullable().optional(),
    paymentOrderId: z.string().regex(UUID).nullable().optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "Choose at least one field to update.",
  });

export interface UpdateLaunchFactoryInput {
  paymentLinkRef?: string | null;
  linkCreatedAt?: string | null;
  result?: LaunchTestResult;
  paidAt?: string | null;
  payerId?: string | null;
  paymentOrderId?: string | null;
}

export async function updateLaunchFactoryAction(
  factoryId: string,
  changes: UpdateLaunchFactoryInput,
  idempotencyKey: string,
): Promise<AdminActionSuccess | AdminActionFailure> {
  if (!UUID.test(factoryId)) return failure(UUID_MESSAGE);
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) return failure(KEY_MESSAGE);
  const parsed = launchFactoryUpdateSchema.safeParse(changes);
  if (!parsed.success) {
    return failure(parsed.error.issues[0]?.message ?? "Choose at least one field to update.");
  }
  const value = parsed.data;
  const body: Record<string, unknown> = {};
  if (value.paymentLinkRef !== undefined) body.payment_link_ref = value.paymentLinkRef;
  if (value.linkCreatedAt !== undefined) body.link_created_at = value.linkCreatedAt;
  if (value.result !== undefined) body.result = value.result;
  if (value.paidAt !== undefined) body.paid_at = value.paidAt;
  if (value.payerId !== undefined) body.payer_id = value.payerId;
  if (value.paymentOrderId !== undefined) body.payment_order_id = value.paymentOrderId;
  try {
    const answer = await adminFetch(
      `/admin/launch-tests/cohort/${encodeURIComponent(factoryId)}`,
      {
        method: "PATCH",
        body,
        headers: idempotencyHeaders(idempotencyKey),
        schema: launchFactoryResultSchema,
      },
    );
    return success(answer.changed ? "Factory updated." : "No change — the factory already held that.", answer.changed === true);
  } catch (err) {
    return failure(describeNumbersActionError(err));
  }
}
