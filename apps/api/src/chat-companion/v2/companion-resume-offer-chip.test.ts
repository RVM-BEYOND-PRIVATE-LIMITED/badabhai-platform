import { describe, expect, it } from "vitest";
import { isResumeOfferChip } from "./companion-resume-offer-chip";

/**
 * #2287 — a model follow-up chip that offers to MAKE a résumé, on a screen where the worker already
 * has one: a résumé word AND a make word. Everything else is kept.
 */
describe("isResumeOfferChip", () => {
  it.each([
    "Resume banane mein madad",
    "Resume banayein",
    "Naya resume",
    "CV banao",
    "Make my resume",
    "RESUME BANAO",
    "Résumé banaiye",
    "résumé banwa lo",
    "Resume banwana hai?",
    "Biodata banaye",
    "Create a new CV",
    "Build resume",
    "Nayi CV",
    "resume-banana",
  ])("%j is an offer to make a résumé", (chip) => {
    expect(isResumeOfferChip(chip)).toBe(true);
  });

  it.each([
    "Resume mein skill jodo",
    "Resume download",
    "Résumé download karein",
    "Resume update karo",
    "Naya kaam dhoondho",
    "Banane ka tarika",
    "Welder ki salary",
    "Resume",
    "CV",
    "Kaunsa certificate chahiye",
    "",
    "   ",
    "Banarasi saree",
  ])("%j is NOT an offer to make a résumé", (chip) => {
    expect(isResumeOfferChip(chip)).toBe(false);
  });
});
