import 'dart:math';

/// Mints a PII-free idempotency key for one payer write intent.
///
/// The value is 128 random bits rendered as lowercase hex. It carries no payer,
/// worker, unlock or device identifier, so it is safe to put on the wire and in
/// the server's idempotency log. Callers keep the SAME key for every retry of
/// one intent; a different intent mints a new one.
String newIdempotencyKey({Random? random}) {
  final Random source = random ?? Random.secure();
  final StringBuffer out = StringBuffer();
  for (int i = 0; i < 16; i++) {
    out.write(source.nextInt(256).toRadixString(16).padLeft(2, '0'));
  }
  return out.toString();
}
