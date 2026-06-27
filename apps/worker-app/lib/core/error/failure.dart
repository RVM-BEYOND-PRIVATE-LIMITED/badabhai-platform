import 'package:equatable/equatable.dart';

/// The single, user-safe error type the presentation layer reacts to.
///
/// A sealed [Equatable] hierarchy so BLoCs can switch over it and states that
/// embed a [Failure] get value equality. [message] is ALWAYS a generic, PII-free
/// UI string — server message bodies are deliberately dropped by the mapper
/// (see [mapError]) so no server detail or PII can leak through it.
sealed class Failure extends Equatable {
  const Failure(this.message);

  final String message;

  @override
  List<Object?> get props => <Object?>[message];
}

/// Could not reach the server — connection refused/timed out, host unreachable,
/// or the device is offline. All of these surface here; the copy says "can't
/// reach the server" rather than "no internet" because, at this layer, the two
/// are indistinguishable (a refused localhost is the most common dev case) and
/// blaming the worker's connection would be misleading.
class NetworkFailure extends Failure {
  const NetworkFailure([super.message = 'Can\'t reach the server. Please try again.']);
}

/// A non-2xx response that is not one of the specialised cases below.
class ServerFailure extends Failure {
  const ServerFailure(
    this.statusCode, [
    String message = 'Something went wrong. Please try again.',
  ]) : super(message);

  final int statusCode;

  @override
  List<Object?> get props => <Object?>[message, statusCode];
}

/// HTTP 401 — the session is gone; the worker must log in again.
class UnauthorizedFailure extends Failure {
  const UnauthorizedFailure([super.message = 'Please log in again.']);
}

/// HTTP 403 — the consent gate. The one distinct signal the swipe flow keys on
/// to route the worker back to the consent screen.
class ConsentRequiredFailure extends Failure {
  const ConsentRequiredFailure([super.message = 'Please accept consent to continue.']);
}

/// The async profile-extraction job did not finish within the client's budget.
class ProfileTimeoutFailure extends Failure {
  const ProfileTimeoutFailure(
    this.aiJobId, [
    String message = 'This is taking longer than usual. Please try again.',
  ]) : super(message);

  final String aiJobId;

  @override
  List<Object?> get props => <Object?>[message, aiJobId];
}

/// Anything not otherwise classified.
class UnknownFailure extends Failure {
  const UnknownFailure([super.message = 'Something went wrong. Please try again.']);
}
