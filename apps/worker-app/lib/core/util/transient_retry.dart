import '../error/failure.dart';

/// Is [error] worth trying again?
///
/// TRUE only for a 5xx. The server did not answer the question — it fell over on
/// the way, and it did so FAST. That is exactly the failure that passes on its
/// own, and exactly why "Server error (500), thodi der baad" followed by a
/// successful second tap was the whole download experience.
///
/// Everything else is deliberately NOT retried:
///
///  - 4xx is the server's CONSIDERED answer (400/401/403/404). Retrying just
///    fails again, slower.
///  - 429 is a rate limit. Retrying is how you stay rate-limited.
///  - A TIMEOUT is already a long bounded wait (kPdfDownloadTimeout is 60s).
///    Retrying it would make the worker wait 3 MINUTES before hearing anything —
///    worse than the bug this fixes.
///  - A transport failure (no internet) is honest and instant. Retrying it for
///    30s before admitting the connection is down helps nobody; the worker can
///    see their own signal bar.
///
/// So: ride out the blip the app can actually fix, and tell the truth fast about
/// everything else.
bool isTransientFailure(Object error) =>
    error is ServerFailure && error.statusCode >= 500;

/// Total attempts for a retryable operation (1 try + 2 retries).
///
/// Small on purpose: this rides out a blip, it does not hammer a server that is
/// genuinely down. Past this the worker gets the honest failure.
const int kTransientRetryAttempts = 3;

/// Base backoff, growing linearly (400ms, 800ms) — long enough for a blip to
/// clear, short enough that the worker does not notice a pause on a tap.
const Duration kTransientRetryBackoff = Duration(milliseconds: 400);

/// Runs [operation], retrying only [isTransientFailure] errors with a bounded
/// backoff.
///
/// Use ONLY for idempotent work — a GET, or a mint that is safe to repeat.
/// Anything else rethrows immediately, so the worker still gets the honest
/// reason rather than a slow spinner.
Future<T> retryTransient<T>(
  Future<T> Function() operation, {
  int attempts = kTransientRetryAttempts,
  Duration backoff = kTransientRetryBackoff,
}) async {
  for (int attempt = 0;; attempt++) {
    try {
      return await operation();
    } catch (error) {
      final bool lastAttempt = attempt >= attempts - 1;
      if (lastAttempt || !isTransientFailure(error)) rethrow;
      await Future<void>.delayed(backoff * (attempt + 1));
    }
  }
}
