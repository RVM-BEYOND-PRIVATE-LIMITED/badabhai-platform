/// Auth boundary for the phone + OTP login flow. Implementations throw a
/// [Failure] (mapped from transport errors) on failure.
abstract interface class AuthRepository {
  /// Requests an OTP for [phoneE164]. Fire-and-forget — the API delivers the
  /// code (or, in console/mock mode, returns it for dev).
  Future<void> requestOtp(String phoneE164);

  /// Verifies [otp] for [phoneE164]. On success the worker + bearer token are
  /// written into the session; callers route purely off completion (no return
  /// value — the verify-result DTO is a data-layer concern).
  Future<void> verifyOtp({
    required String phoneE164,
    required String otp,
  });
}
