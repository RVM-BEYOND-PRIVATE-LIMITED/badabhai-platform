import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * PATH-SCOPED raw-body capture for the Razorpay webhook.
 *
 * WHY THIS EXISTS: the webhook signature is an HMAC over the EXACT BYTES Razorpay sent.
 * By the time NestJS's JSON body parser has run, those bytes are gone — only a parsed
 * object remains, and `JSON.stringify` of that object is a DIFFERENT byte sequence (key
 * order, unicode escaping, number formatting). Verifying against a re-serialized body
 * fails for genuine deliveries, so the raw bytes must be kept before parsing.
 *
 * WHY NOT `NestFactory.create(app, { rawBody: true })`: that is global — it attaches the
 * raw buffer to EVERY request on the API, including the OTP, PIN, and worker-answer routes
 * whose bodies are PII. Retaining a second copy of those bytes for the life of every
 * request is a needless PII-at-rest-in-memory surface. This middleware is mounted at ONE
 * path, so no other route's bytes are ever duplicated.
 *
 * WHY IT DOES NOT BREAK OTHER ROUTES:
 *  - It is mounted with `app.use(RAZORPAY_WEBHOOK_PATH, …)`, so Express only invokes it
 *    for that path. Every other route reaches Nest's parsers untouched.
 *  - `app.use()` called before `app.listen()` registers BEFORE Nest's body parsers, which
 *    are installed during `init()` (see NestApplication.init: `registerParserMiddleware()`
 *    runs inside init, which listen() triggers). So this reads the stream FIRST.
 *  - Having read the stream to completion, the downstream JSON parser short-circuits. The
 *    mechanism in the installed body-parser (2.x, via express 5) is its FIRST guard,
 *    `onFinished.isFinished(req)`, which is true once `req.complete === true` and
 *    `req.readable === false` — exactly the state a fully-drained request is in. It calls
 *    `next()` without touching the stream and without overwriting `req.body`. No global
 *    parser option is changed, and no other route is affected.
 *    (`_body = true` is also set below: that is body-parser 1.x's equivalent flag, kept as
 *    cheap forward/backward insurance. It is NOT the mechanism today — see the assertion
 *    in razorpay-raw-body.middleware.test.ts, which drives a REAL Nest app + real parsers
 *    rather than trusting either flag.)
 *
 * SIZE BOUNDED + FAIL CLOSED: a body over {@link MAX_WEBHOOK_BODY_BYTES} is refused with a
 * 413 and never buffered further, so an unauthenticated public route cannot be used to
 * exhaust memory. Nothing here logs: the body may contain provider-side contact/card
 * metadata and must never reach a log sink (CLAUDE.md §2 #2).
 */

/** The one path whose raw bytes are captured. Mounted in main.ts; matched by the controller. */
export const RAZORPAY_WEBHOOK_PATH = "/payments/razorpay/webhook";

/**
 * Hard cap on the captured webhook body. Razorpay payment payloads are a few KB; 64 KiB is
 * generous headroom while keeping an unauthenticated public endpoint cheap to serve.
 */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

/** A request that has been through this middleware. `rawBody` is the verification input. */
export interface RawBodyRequest extends IncomingMessage {
  /** The exact bytes received. Present ONLY on the webhook path. */
  rawBody?: Buffer;
  /** The parsed body, or `{}` when the payload was not valid JSON (never throws here). */
  body?: unknown;
  /** body-parser's "already read" flag — set so the downstream JSON parser skips this request. */
  _body?: boolean;
}

/**
 * Parse JSON without throwing. A malformed payload becomes `{}`; the controller then finds
 * no known event type and no-ops. Parsing deliberately happens AFTER capture and BEFORE
 * verification is irrelevant — the controller verifies the RAW bytes, not this object, so a
 * parse result can never influence whether a request is trusted.
 */
function parseJsonOrEmpty(raw: Buffer): unknown {
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    return {};
  }
}

/**
 * Express-style middleware. Reads the request stream into a bounded Buffer, exposes it as
 * `req.rawBody`, parses a convenience `req.body`, and marks the body as already-read.
 */
export function razorpayRawBodyMiddleware(
  req: RawBodyRequest,
  res: ServerResponse,
  next: (err?: unknown) => void,
): void {
  // Defensive: if something upstream already consumed the body we cannot verify, so leave
  // rawBody unset — the controller then rejects (fail closed) rather than trusting a parse.
  if (req._body === true) {
    next();
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let settled = false;

  const finish = (err?: unknown): void => {
    if (settled) return;
    settled = true;
    next(err);
  };

  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_WEBHOOK_BODY_BYTES) {
      // Refuse loudly but WITHOUT detail, and stop buffering immediately. No log line:
      // an unauthenticated caller must not be able to write to our logs at will.
      if (!settled) {
        settled = true;
        res.statusCode = 413;
        res.end();
        req.destroy();
      }
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", () => {
    if (settled) return;
    const raw = Buffer.concat(chunks);
    req.rawBody = raw;
    req.body = parseJsonOrEmpty(raw);
    // body-parser 1.x's "already read" flag. The parser in use today (2.x) instead
    // short-circuits on `onFinished.isFinished(req)`, which the drained stream satisfies —
    // this is belt-and-braces, not the load-bearing mechanism (see the class doc).
    req._body = true;
    finish();
  });

  req.on("error", (err) => finish(err));
}
