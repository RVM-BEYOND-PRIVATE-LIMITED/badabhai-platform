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
      401 => const UnauthorizedFailure(),
      403 => const ConsentRequiredFailure(),
      429 => const RateLimitedFailure(),
      _ => ServerFailure(error.statusCode),
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
