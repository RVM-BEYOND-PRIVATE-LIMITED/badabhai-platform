import { describe, expect, it } from "vitest";
import { identityAskIn } from "./edit-identity";

// BUG-IDENTITY-UNSUPPORTED — the deterministic backstop for "mera naam badlo". Narrow on purpose:
// it names the worker's OWN name/number/ID, never a certificate's or an employer's name, and
// never a document the worker may legitimately list as ready.
describe("identityAskIn", () => {
  it.each([
    ["Mera naam badlo", "identity"],
    ["mera pura naam galat hai", "identity"],
    ["apna naam change karna hai", "identity"],
    ["naam badalna hai", "identity"],
    ["my name is wrong", "identity"],
    ["mera naam [PERSON_1] karo", "identity"],
    ["aadhaar number badal do", "identity"],
    ["PAN card number update karo", "identity"],
    ["मेरा नाम बदलो", "identity"],
    ["आधार नंबर बदलो", "identity"],
    ["phone number update karo", "contact"],
    ["mobile no change karna hai", "contact"],
    ["mera number badlo", "contact"],
    ["email badalna hai", "contact"],
    ["phone badlo", "contact"],
    ["फ़ोन नंबर बदलो", "contact"],
    ["फोन बदलना है", "contact"],
  ] as const)("%j → %s", (text, expected) => {
    expect(identityAskIn(text)).toBe(expected);
  });

  it.each([
    "company ka naam badlo",
    "certificate ka naam galat hai",
    "course ka name sahi karo",
    "aadhaar card ready hai",
    "mobile repairing skill add karo",
    "मोबाइल रिपेयरिंग जोड़ो",
    "welding add karo",
    "kuch samajh nahi aaya",
    "number 2 wala certificate hatao",
    "",
  ])("%j → null", (text) => {
    expect(identityAskIn(text)).toBeNull();
  });
});
