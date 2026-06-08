import { z } from "zod";
import { LANGUAGE_CODES, MAX_VOICE_NOTE_SECONDS, CONSENT_PURPOSES } from "@badabhai/types";

/**
 * @badabhai/validators — reusable Zod schemas shared by API DTOs, AI contracts,
 * and tests. Keep these small and composable.
 */

/**
 * E.164 phone number, e.g. "+919876543210".
 * Leading "+", first digit 1-9, total 8-15 digits.
 */
export const e164PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, "Must be a valid E.164 phone number (e.g. +919876543210)");

export function isE164Phone(value: string): boolean {
  return e164PhoneSchema.safeParse(value).success;
}

/** RFC 4122 UUID. */
export const uuidSchema = z.string().uuid();

/** Supported language code (see @badabhai/types LANGUAGE_CODES). */
export const languageCodeSchema = z.enum(LANGUAGE_CODES);

/**
 * Voice note duration in seconds. Must be > 0 and <= 120 (Phase 1 hard limit).
 */
export const voiceDurationSecondsSchema = z
  .number()
  .positive("Duration must be greater than 0")
  .max(MAX_VOICE_NOTE_SECONDS, `Duration must be at most ${MAX_VOICE_NOTE_SECONDS} seconds`);

export function isValidVoiceDuration(seconds: number): boolean {
  return voiceDurationSecondsSchema.safeParse(seconds).success;
}

/** Non-empty (after trim) message string. */
export const nonEmptyMessageSchema = z
  .string()
  .trim()
  .min(1, "Message must not be empty");

/** Default maximum length for free-text fields. */
export const DEFAULT_SAFE_TEXT_MAX = 5000;

/** Safe bounded free text. Defaults to a 5000-char cap. */
export function safeTextSchema(maxLength: number = DEFAULT_SAFE_TEXT_MAX) {
  return z.string().trim().min(1).max(maxLength);
}

/** Consent purposes — must be a non-empty subset of the known purposes. */
export const consentPurposesSchema = z
  .array(z.enum(CONSENT_PURPOSES))
  .min(1, "At least one consent purpose is required")
  .refine((arr) => new Set(arr).size === arr.length, "Consent purposes must be unique");

export type E164Phone = z.infer<typeof e164PhoneSchema>;
export type ConsentPurposes = z.infer<typeof consentPurposesSchema>;
