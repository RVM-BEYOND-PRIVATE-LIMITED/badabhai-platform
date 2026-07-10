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

/// HTTP 401 on an OTP-check step (e.g. account-delete confirm) — the code the
/// worker typed is wrong/expired. DISTINCT from [UnauthorizedFailure]: the
/// session is fine; only the OTP was wrong, so the copy says "OTP sahi nahi",
/// never "log in again".
class OtpInvalidFailure extends Failure {
  const OtpInvalidFailure([super.message = 'OTP sahi nahi. Dobara daalein.']);
}

/// HTTP 429 — too many requests. The per-IP hourly cap on the download routes
/// (interview-kit + resume PDF, 20/hr) and any other rate-limited endpoint. The
/// copy asks the worker to wait and retry rather than blaming the network.
class RateLimitedFailure extends Failure {
  const RateLimitedFailure([super.message = 'Bahut requests. Thodi der baad dobara koshish karein.']);
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

/// The worker has no profile yet (has not completed profiling), so there is
/// nothing to build a resume from. Distinct from a network/server failure so the
/// UI can guide the worker to finish their profile instead of blaming the net.
class ProfileIncompleteFailure extends Failure {
  const ProfileIncompleteFailure(
      [super.message = 'Pehle apna profile poora karein.']);
}

/// The voice-note pipeline cannot complete right now: the server said voice
/// uploads are not enabled (503 on `/voice/upload-url`), the recording could
/// not be captured, or the transcript is not ready. Honest copy tells the
/// worker what to do instead of dead-ending or blaming the net.
class VoiceUnavailableFailure extends Failure {
  const VoiceUnavailableFailure([
    super.message = 'Voice note abhi available nahi hai. Type karke bhejein.',
  ]);
}

/// The worker declined (or the OS blocked) the microphone permission, so
/// recording cannot start. DISTINCT from [VoiceUnavailableFailure]: voice works
/// — the phone just needs mic access — so the copy points at settings, not at
/// the feature.
class MicPermissionFailure extends Failure {
  const MicPermissionFailure([
    super.message =
        'Mic ki permission nahi mili. Phone settings mein mic allow karein, '
        'ya type karke bhejein.',
  ]);
}

/// Anything not otherwise classified.
class UnknownFailure extends Failure {
  const UnknownFailure([super.message = 'Something went wrong. Please try again.']);
}
