import { z } from "zod";

/**
 * The relay's wire contract + the CLOSED opening-template set (E0, `docs/agent/phases/E0_BUILD.md`
 * item 3; `docs/decisions/E0_RELAY_DECISION_2026-09.md` §B, signed 2026-09-07).
 *
 * ── WHY A TEMPLATE CATALOGUE LIVES IN CODE ────────────────────────────────────────────────
 *
 * The §B ruling: the payer's FIRST message is a structured message from a closed set — "a
 * template id plus a closed parameter set in the body column, so a leak in the opening
 * message is a compile error rather than a review miss" — and free text opens only after the
 * worker has replied. A catalogue the payer's UI could drift from would defeat that, so the
 * server owns it and `GET /payer/relay/templates` serves it.
 *
 * ── WHAT THE RULING DOES *NOT* SETTLE (do not read this file as closing it) ───────────────
 *
 * INTENT. "mera number profile pe hai", a number split across two messages, "WhatsApp pe naam
 * se search karo" — shape does not address any of it, and after the worker replies the thread
 * is free text by design. This catalogue reduces the opening surface. It prevents nothing.
 *
 * COPY. The three entries below are the examples named in the signed ruling, rendered in the
 * platform's Hinglish voice. ACCEPTED AS SHIPPED by the owner on 2026-09-21 (issue #1624) —
 * this is the reviewed set, not a placeholder; a later copy change is an owner edit to this
 * catalogue, never a client-side override.
 */

/** Max free-text length. Long enough for a real question, short enough to bound a row. */
export const RELAY_MESSAGE_TEXT_MAX = 1000;

export const RELAY_OPENING_TEMPLATE_IDS = ["availability", "visit_day", "rate"] as const;
export type RelayOpeningTemplateId = (typeof RELAY_OPENING_TEMPLATE_IDS)[number];

export const RELAY_VISIT_DAYS = ["today", "tomorrow", "this_week", "next_week"] as const;
export type RelayVisitDay = (typeof RELAY_VISIT_DAYS)[number];

const DAY_LABELS: Readonly<Record<RelayVisitDay, string>> = {
  today: "aaj",
  tomorrow: "kal",
  this_week: "is hafte",
  next_week: "agle hafte",
};

interface OpeningTemplate {
  /** Hinglish, platform voice. `{param}` slots are filled from `param_labels`. */
  readonly copy: string;
  /** The CLOSED value set per parameter — a value outside it is rejected at send time. */
  readonly params: Readonly<Record<string, readonly string[]>>;
  /** Display labels for the closed values (what the worker reads). */
  readonly param_labels: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Parameters that must be present for the template to render. */
  readonly required: readonly string[];
}

export const RELAY_OPENING_TEMPLATES: Readonly<Record<RelayOpeningTemplateId, OpeningTemplate>> =
  {
    availability: {
      copy: "Aap kaam ke liye available hain?",
      params: {},
      param_labels: {},
      required: [],
    },
    visit_day: {
      copy: "Aap {day} aa sakte hain?",
      params: { day: RELAY_VISIT_DAYS },
      param_labels: { day: DAY_LABELS },
      required: ["day"],
    },
    rate: {
      copy: "Aapka expected rate kya hai?",
      params: {},
      param_labels: {},
      required: [],
    },
  };

/**
 * Render a stored template row for reading. `null` for an id outside the closed set — the
 * service validates on WRITE, so an unknown id on read is a data-integrity fault and the
 * caller skips it rather than showing a raw id.
 */
export function renderOpeningTemplate(
  templateId: string,
  params: Readonly<Record<string, string>>,
): string | null {
  if (!Object.prototype.hasOwnProperty.call(RELAY_OPENING_TEMPLATES, templateId)) return null;
  const template = RELAY_OPENING_TEMPLATES[templateId as RelayOpeningTemplateId];
  return template.copy.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined) return "";
    return template.param_labels[key]?.[value] ?? value;
  });
}

/** The payer's opening template + its closed parameter vocabulary, as the FE needs it. */
export interface RelayTemplateWire {
  template_id: RelayOpeningTemplateId;
  copy: string;
  params: { name: string; options: { value: string; label: string }[] }[];
}

export const RELAY_TEMPLATE_WIRE: readonly RelayTemplateWire[] = RELAY_OPENING_TEMPLATE_IDS.map(
  (id) => {
    const template = RELAY_OPENING_TEMPLATES[id];
    return {
      template_id: id,
      copy: template.copy,
      params: Object.entries(template.params).map(([name, values]) => ({
        name,
        options: values.map((value) => ({ value, label: template.param_labels[name]?.[value] ?? value })),
      })),
    };
  },
);

/**
 * The payer's handle. Shape-checked only — `relay_<unlockId>_<randomUUID>`, minted by
 * `UnlockService.wireInAppRelay`. Resolution is the real gate; this bounds the input.
 */
export const RelayHandleSchema = z
  .string()
  .max(128)
  .regex(/^relay_[0-9a-f-]{36}_[0-9a-f-]{36}$/i, "not a relay handle");

const TemplateSendSchema = z.object({
  kind: z.literal("template"),
  template_id: z.enum(RELAY_OPENING_TEMPLATE_IDS),
  params: z.record(z.string(), z.string()).default({}),
});

const TextSendSchema = z.object({
  kind: z.literal("text"),
  text: z.string().trim().min(1).max(RELAY_MESSAGE_TEXT_MAX),
});

/**
 * The payer's send body — a discriminated union so `kind:"template"` can never carry free
 * text and `kind:"text"` can never carry a template. The `superRefine` closes the parameter
 * vocabulary against the catalogue (zod 3 forbids effects inside a discriminated union, so
 * this rides the UNION).
 */
export const PayerRelaySendSchema = z
  .discriminatedUnion("kind", [TemplateSendSchema, TextSendSchema])
  .superRefine((value, ctx) => {
    if (value.kind !== "template") return;
    const template = RELAY_OPENING_TEMPLATES[value.template_id];
    for (const [key, paramValue] of Object.entries(value.params)) {
      const allowed = template.params[key];
      if (allowed === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["params", key],
          message: `unknown parameter for ${value.template_id}`,
        });
      } else if (!allowed.includes(paramValue)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["params", key],
          message: `value is not in the closed set for ${key}`,
        });
      }
    }
    for (const required of template.required) {
      if (value.params[required] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["params", required],
          message: `${required} is required for ${value.template_id}`,
        });
      }
    }
  });
export type PayerRelaySendDto = z.infer<typeof PayerRelaySendSchema>;

/** The worker's reply: free text, by design (§B — the worker's reply is the affirmative act). */
export const WorkerRelayReplySchema = z.object({
  text: z.string().trim().min(1).max(RELAY_MESSAGE_TEXT_MAX),
});
export type WorkerRelayReplyDto = z.infer<typeof WorkerRelayReplySchema>;

/** One message on the wire. `text` is RENDERED server-side; the body column is never exposed. */
export interface RelayMessageWire {
  message_id: string;
  direction: "payer_to_worker" | "worker_to_payer";
  text: string;
  created_at: string;
  read_at: string | null;
}

/** A worker's thread summary — no counterparty identity, ever (its own owner ruling). */
export interface RelayThreadWire {
  unlock_id: string;
  last_message_at: string;
  unread_count: number;
}
