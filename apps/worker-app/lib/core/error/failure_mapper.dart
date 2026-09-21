import 'dart:async';
import 'dart:io';

import 'package:http/http.dart' as http;

import '../api/api_models.dart';
import 'failure.dart';

/// Maps any thrown transport/error object into a user-safe [Failure].
///
/// PRIVACY: this NEVER forwards [ApiException.message] (or any server body) into
/// the resulting [Failure.message] — server responses can carry detail/PII, so
/// the UI copy stays generic. Repositories call this in their `catch` and throw
/// the result; BLoCs catch [Failure] and emit the matching state.
Failure mapError(Object error) {
  if (error is Failure) return error;

  if (error is ApiException) {
    return switch (error.statusCode) {
      // #1013 — a 400 is the server's CONSIDERED answer about this request, not a
      // blip. Left as a ServerFailure it rendered "Server error (400). Thodi der
      // baad try karein.", which sends the worker away to retry something that
      // cannot ever succeed. It gets its own type so the copy can ask them to
      // change what they sent instead.
      400 => const InvalidRequestFailure(),
      401 => const UnauthorizedFailure(),
      403 => const ConsentRequiredFailure(),
      429 => const RateLimitedFailure(),
      // #1480 — THE CODE IS ALREADY ON THE OBJECT; IT WAS JUST NEVER PRINTED.
      //
      // `ServerFailure` has carried `statusCode` since it was written, and its default
      // message throws it away. So a worker reporting "Something went wrong" gave us nothing
      // to act on, and neither did the screenshot — the one number that would have told us
      // whether to look at the service, at Redis, or at his token was in the app the whole
      // time. Composed HERE rather than in the constructor because a `const` default cannot
      // interpolate a field; same reason, and the same shape, as the 400 case above.
      //
      // HINGLISH, matching `RateLimitedFailure` below it rather than the English default it
      // replaces — this is a string a worker reads on his own phone.
      _ => ServerFailure(
        error.statusCode,
        'Kuch takneeki dikkat hai (${error.statusCode}). Thodi der baad koshish karein.',
      ),
    };
  }

  if (error is ProfileExtractionTimeout) {
    return ProfileTimeoutFailure(error.aiJobId);
  }

  if (error is SocketException ||
      error is TimeoutException ||
      error is http.ClientException) {
    return const NetworkFailure();
  }

  return const UnknownFailure();
}
