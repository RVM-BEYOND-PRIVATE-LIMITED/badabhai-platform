import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_BUILD_NUMBER_MAX,
  APP_MESSAGE_KEY_PATTERN,
  APP_RELEASE_FIELDS,
  APP_STORE_URL_MAX,
  APP_STORE_URL_PATTERN,
  BUILD_NUMBER_BLANK,
  BUILD_NUMBER_INVALID,
  LATEST_BELOW_MINIMUM,
  STORE_URL_INVALID,
  STORE_URL_TOO_LONG,
  appReleasePolicyBodySchema,
  fieldErrorsFromIssues,
  formValuesFromPolicy,
  lastChange,
  needsRaiseConfirm,
  orderPolicies,
  policyChanges,
  policyTitle,
  raiseConfirmQuestion,
  saveSuccessMessage,
  validateAppReleaseForm,
  type AppReleaseFormValues,
  type AppReleasePolicy,
} from "./app-release-policy-model";

/**
 * #3058 — the App versions screen's pure rules: the labels (never a raw slug), the validation that
 * mirrors the server's body schema edge for edge, and the one confirm (only on RAISING a minimum).
 */
const policy = (over: Partial<AppReleasePolicy> = {}): AppReleasePolicy => ({
  app: "worker",
  platform: "android",
  min_supported_build: 40,
  latest_build: 45,
  store_url: "https://play.google.com/store/apps/details?id=x",
  message_key: "update_default",
  updated_by: null,
  updated_at: "2026-11-25T04:00:00.000Z",
  ...over,
});

const values = (over: Partial<AppReleaseFormValues> = {}): AppReleaseFormValues => ({
  ...formValuesFromPolicy(policy()),
  ...over,
});

const validate = (over: Partial<AppReleaseFormValues> = {}, row = policy()) =>
  validateAppReleaseForm(row, values(over));

describe("the server's bounds, held to the API's own constants", () => {
  const constants = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "api",
      "src",
      "app-version",
      "app-version.constants.ts",
    ),
    "utf8",
  );

  it("the build ceiling, the link limit and both patterns are the API's", () => {
    expect(constants).toContain("APP_BUILD_NUMBER_MAX = 2_147_483_647;");
    expect(APP_BUILD_NUMBER_MAX).toBe(2_147_483_647);
    expect(constants).toContain(`APP_STORE_URL_MAX = ${APP_STORE_URL_MAX};`);
    expect(constants).toContain(`APP_STORE_URL_PATTERN = ${String(APP_STORE_URL_PATTERN)};`);
    expect(constants).toContain(`APP_MESSAGE_KEY_PATTERN = ${String(APP_MESSAGE_KEY_PATTERN)};`);
  });
});

describe("labels — never a raw slug", () => {
  it("names each card by app and platform; payer is the company app", () => {
    expect(policyTitle({ app: "worker", platform: "android" })).toBe("Worker app Android");
    expect(policyTitle({ app: "worker", platform: "ios" })).toBe("Worker app iOS");
    expect(policyTitle({ app: "payer", platform: "android" })).toBe("Company app Android");
    expect(policyTitle({ app: "payer", platform: "ios" })).toBe("Company app iOS");
  });

  it("orders the four rows worker before company, Android before iOS", () => {
    const rows = [
      policy({ app: "payer", platform: "ios" }),
      policy({ app: "worker", platform: "ios" }),
      policy({ app: "payer", platform: "android" }),
      policy({ app: "worker", platform: "android" }),
    ];
    expect(orderPolicies(rows).map(policyTitle)).toEqual([
      "Worker app Android",
      "Worker app iOS",
      "Company app Android",
      "Company app iOS",
    ]);
  });

  it("has a label and help for the three fields, with the issue's two helpers", () => {
    expect(APP_RELEASE_FIELDS.map((f) => f.label)).toEqual([
      "Minimum build",
      "Latest build",
      "Store link (optional)",
    ]);
    expect(APP_RELEASE_FIELDS[0]!.help).toBe("Builds below this are blocked from writing.");
    expect(APP_RELEASE_FIELDS[1]!.help).toContain("new version available");
  });

  it("a seeded row (no admin) was never changed; a set row names its admin and time", () => {
    expect(lastChange(policy({ updated_by: null }))).toEqual({ kind: "never" });
    expect(lastChange(policy({ updated_by: null, updated_at: null }))).toEqual({ kind: "never" });
    expect(lastChange(policy({ updated_by: "a-1" }))).toEqual({
      kind: "changed",
      by: "a-1",
      at: "2026-11-25T04:00:00.000Z",
    });
  });

  it("says Saved for a change and No change for a save that matched", () => {
    expect(saveSuccessMessage(true)).toBe("Saved");
    expect(saveSuccessMessage(false)).toBe("No change");
  });
});

describe("validateAppReleaseForm — mirrors the server", () => {
  it("builds the whole body, with message_key sent back unchanged", () => {
    const row = policy({ message_key: "update_soon", app: "payer", platform: "ios" });
    const result = validate({ min_supported_build: "50", latest_build: " 52 " }, row);
    expect(result).toEqual({
      ok: true,
      body: {
        app: "payer",
        platform: "ios",
        min_supported_build: 50,
        latest_build: 52,
        store_url: "https://play.google.com/store/apps/details?id=x",
        message_key: "update_soon",
      },
    });
    if (result.ok) {
      expect(Object.keys(result.body).sort()).toEqual([
        "app",
        "latest_build",
        "message_key",
        "min_supported_build",
        "platform",
        "store_url",
      ]);
    }
  });

  it("accepts 0 and the largest integer Postgres holds", () => {
    expect(validate({ min_supported_build: "0", latest_build: "0" }).ok).toBe(true);
    const top = validate({
      min_supported_build: String(APP_BUILD_NUMBER_MAX),
      latest_build: String(APP_BUILD_NUMBER_MAX),
    });
    expect(top.ok).toBe(true);
  });

  it("refuses one past the largest integer", () => {
    const result = validate({ latest_build: "2147483648" });
    expect(result).toEqual({ ok: false, errors: { latest_build: BUILD_NUMBER_INVALID } });
  });

  it("refuses a negative, a decimal, an exponent and a blank, at the field", () => {
    for (const [raw, message] of [
      ["-1", BUILD_NUMBER_INVALID],
      ["1.5", BUILD_NUMBER_INVALID],
      ["1e3", BUILD_NUMBER_INVALID],
      ["+5", BUILD_NUMBER_INVALID],
      ["abc", BUILD_NUMBER_INVALID],
      ["", BUILD_NUMBER_BLANK],
      ["   ", BUILD_NUMBER_BLANK],
    ] as const) {
      const result = validate({ min_supported_build: raw, latest_build: "60" });
      expect(result, raw || "<blank>").toEqual({
        ok: false,
        errors: { min_supported_build: message },
      });
    }
  });

  it("refuses a latest build below the minimum, on the latest field", () => {
    expect(validate({ min_supported_build: "50", latest_build: "49" })).toEqual({
      ok: false,
      errors: { latest_build: LATEST_BELOW_MINIMUM },
    });
    expect(validate({ min_supported_build: "50", latest_build: "50" }).ok).toBe(true);
  });

  it("sends an empty link as null", () => {
    for (const raw of ["", "   "]) {
      const result = validate({ store_url: raw });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.body.store_url).toBeNull();
    }
  });

  it("refuses an http:// link, a bare https://, and a link with a space", () => {
    for (const raw of [
      "http://example.com/app.apk",
      "https://",
      "https://example.com/a b",
      "ftp://x",
    ]) {
      expect(validate({ store_url: raw }), raw).toEqual({
        ok: false,
        errors: { store_url: STORE_URL_INVALID },
      });
    }
  });

  it("takes a 512-character link and refuses 513", () => {
    const prefix = "https://example.com/";
    const at512 = prefix + "a".repeat(APP_STORE_URL_MAX - prefix.length);
    expect(at512).toHaveLength(512);
    expect(validate({ store_url: at512 }).ok).toBe(true);
    expect(validate({ store_url: `${at512}a` })).toEqual({
      ok: false,
      errors: { store_url: STORE_URL_TOO_LONG },
    });
  });

  it("reports every bad field at once", () => {
    const result = validate({ min_supported_build: "-1", latest_build: "", store_url: "http://x" });
    expect(result).toEqual({
      ok: false,
      errors: {
        min_supported_build: BUILD_NUMBER_INVALID,
        latest_build: BUILD_NUMBER_BLANK,
        store_url: STORE_URL_INVALID,
      },
    });
  });
});

describe("the body schema — the server's, field for field", () => {
  const valid = {
    app: "payer",
    platform: "ios",
    min_supported_build: 10,
    latest_build: 12,
    store_url: "https://apps.apple.com/app/id1",
    message_key: "update_default",
  };

  it("takes a full body, and refuses a missing field or an extra one", () => {
    expect(appReleasePolicyBodySchema.safeParse(valid).success).toBe(true);
    const { store_url: _omit, ...missing } = valid;
    expect(appReleasePolicyBodySchema.safeParse(missing).success).toBe(false);
    expect(appReleasePolicyBodySchema.safeParse({ ...valid, admin_id: "x" }).success).toBe(false);
  });

  it("refuses what the server refuses", () => {
    for (const over of [
      { app: "agent" },
      { platform: "web" },
      { min_supported_build: -1 },
      { latest_build: 1.5 },
      { latest_build: "12" },
      { latest_build: 2_147_483_648 },
      { min_supported_build: 13 },
      { store_url: "http://example.com/app.apk" },
      { store_url: `https://example.com/${"a".repeat(600)}` },
      { message_key: "Update Now" },
    ]) {
      expect(
        appReleasePolicyBodySchema.safeParse({ ...valid, ...over }).success,
        JSON.stringify(over).slice(0, 60),
      ).toBe(false);
    }
  });
});

describe("fieldErrorsFromIssues", () => {
  it("places the server's issues on their fields, in this screen's words", () => {
    expect(
      fieldErrorsFromIssues([
        { path: ["latest_build"], message: "latest_build must be at least min_supported_build" },
        { path: ["min_supported_build"], message: "Too small" },
        { path: ["store_url"], message: "Too big: expected string to have <=512 characters" },
      ]),
    ).toEqual({
      latest_build: LATEST_BELOW_MINIMUM,
      min_supported_build: BUILD_NUMBER_INVALID,
      store_url: STORE_URL_TOO_LONG,
    });
    expect(fieldErrorsFromIssues([{ path: ["store_url"], message: "Invalid string" }])).toEqual({
      store_url: STORE_URL_INVALID,
    });
  });

  it("puts anything else on the form", () => {
    expect(fieldErrorsFromIssues([{ path: ["message_key"], message: "Invalid" }])).toEqual({
      form: "That change was refused. Check the values and try again.",
    });
  });
});

describe("the confirm — only when RAISING a minimum", () => {
  const saved = policy({ min_supported_build: 40 });
  const body = (min: number, latest = 60, store_url: string | null = saved.store_url) => ({
    app: saved.app,
    platform: saved.platform,
    min_supported_build: min,
    latest_build: latest,
    store_url,
    message_key: saved.message_key,
  });

  it("asks on a raise, never on a lower or the same minimum", () => {
    expect(needsRaiseConfirm(saved, body(41))).toBe(true);
    expect(needsRaiseConfirm(saved, body(40))).toBe(false);
    expect(needsRaiseConfirm(saved, body(39))).toBe(false);
    expect(needsRaiseConfirm(saved, body(0))).toBe(false);
  });

  it("a latest-only or link-only change asks nothing", () => {
    expect(needsRaiseConfirm(saved, body(40, 99))).toBe(false);
    expect(needsRaiseConfirm(saved, body(40, 45, null))).toBe(false);
  });

  it("asks the issue's question, naming the app and platform in words", () => {
    expect(raiseConfirmQuestion({ app: "worker", platform: "android" }, 50)).toBe(
      "Every worker app on Android older than build 50 will be stopped until it updates. Continue?",
    );
    expect(raiseConfirmQuestion({ app: "payer", platform: "ios" }, 7)).toBe(
      "Every company app on iOS older than build 7 will be stopped until it updates. Continue?",
    );
  });

  it("lists what changes, field by field, and nothing that does not", () => {
    expect(policyChanges(saved, body(50, 45))).toEqual([
      { label: "Minimum build", before: "40", after: "50" },
    ]);
    expect(policyChanges(saved, body(50, 52, null))).toEqual([
      { label: "Minimum build", before: "40", after: "50" },
      { label: "Latest build", before: "45", after: "52" },
      { label: "Store link", before: saved.store_url, after: "None" },
    ]);
  });
});
