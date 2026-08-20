import { describe, expect, it } from "vitest";
import {
  DEVICE_ID_HEADER,
  DEVICE_ID_MAX_LENGTH,
  DEVICE_ID_MIN_LENGTH,
  senderOf,
  type SenderSource,
} from "./request-sender";

/** A request carrying whichever of the two identifiers the case is about. */
const req = (opts: { deviceId?: string; ip?: string } = {}): SenderSource => ({
  ip: opts.ip,
  header: (name: string) => (name === DEVICE_ID_HEADER ? opts.deviceId : undefined),
});

/** What the worker app actually sends — a persisted UUID (`device_id.dart`). */
const UUID = "3f7c1b9a-0d4e-4c62-9a11-77b2c5e8d013";

describe("senderOf — who is asking (#1035)", () => {
  it("prefers the device the client named", () => {
    expect(senderOf(req({ deviceId: UUID, ip: "1.2.3.4" }))).toEqual({
      kind: "device",
      value: UUID,
    });
  });

  it("THE BUG: one address, two handsets, two senders", () => {
    // Keyed on the address these two collapsed into one bucket, which is how a factory wifi
    // or a carrier CGNAT pool locked its own workers out — and why changing your phone number
    // did nothing, because the number was never the key.
    const a = senderOf(req({ deviceId: "device-aaa1", ip: "203.0.113.7" }));
    const b = senderOf(req({ deviceId: "device-bbb2", ip: "203.0.113.7" }));
    expect(a).not.toEqual(b);
    expect([a.kind, b.kind]).toEqual(["device", "device"]);
  });

  it("falls back to the address when no header is sent — an older client, a browser, curl", () => {
    expect(senderOf(req({ ip: "1.2.3.4" }))).toEqual({ kind: "ip", value: "1.2.3.4" });
  });

  it('falls back to "unknown" when express could not determine an address either', () => {
    // One bucket shared by every such caller: the strict reading, and it cannot uncap anybody.
    expect(senderOf(req())).toEqual({ kind: "ip", value: "unknown" });
  });

  it("a value too SHORT to identify a handset is not one", () => {
    // "absent/short" is the issue's own wording. A caller sending a couple of characters is
    // not naming a device, and honouring it would hand them a private allowance.
    expect(senderOf(req({ deviceId: "abc", ip: "1.2.3.4" }))).toEqual({
      kind: "ip",
      value: "1.2.3.4",
    });
    expect(senderOf(req({ deviceId: "a".repeat(DEVICE_ID_MIN_LENGTH - 1), ip: "1.2.3.4" })).kind)
      .toBe("ip");
    expect(senderOf(req({ deviceId: "a".repeat(DEVICE_ID_MIN_LENGTH), ip: "1.2.3.4" })).kind)
      .toBe("device");
  });

  it("a value too LONG is rejected — this is an unauthenticated header on the front door", () => {
    // Node accepts a ~16KB header block. Without the bound the caller chooses how much work
    // the limiter's HMAC does, on a route that runs before any authentication.
    expect(senderOf(req({ deviceId: "a".repeat(DEVICE_ID_MAX_LENGTH), ip: "1.2.3.4" })).kind)
      .toBe("device");
    expect(senderOf(req({ deviceId: "a".repeat(DEVICE_ID_MAX_LENGTH + 1), ip: "1.2.3.4" })).kind)
      .toBe("ip");
    expect(senderOf(req({ deviceId: "a".repeat(16_384), ip: "1.2.3.4" })).kind).toBe("ip");
  });

  it("trims, so whitespace padding is neither a distinct device nor an accepted short one", () => {
    expect(senderOf(req({ deviceId: `  ${UUID}  `, ip: "1.2.3.4" }))).toEqual({
      kind: "device",
      value: UUID,
    });
    // Whitespace alone is not an identifier — it trims to empty and falls back.
    expect(senderOf(req({ deviceId: "          ", ip: "1.2.3.4" }))).toEqual({
      kind: "ip",
      value: "1.2.3.4",
    });
  });

  it("an empty header value falls back rather than keying a bucket on the empty string", () => {
    expect(senderOf(req({ deviceId: "", ip: "1.2.3.4" }))).toEqual({ kind: "ip", value: "1.2.3.4" });
  });

  it("the accepted band MATCHES DeviceInfoSchema.device_id — one identifier, one width", () => {
    // The same id arrives in the /auth/otp/verify body as `device_info.device_id`
    // (`z.string().min(8).max(256)`). Two widths for one identifier is a bug waiting to happen.
    expect(DEVICE_ID_MIN_LENGTH).toBe(8);
    expect(DEVICE_ID_MAX_LENGTH).toBe(256);
  });
});
