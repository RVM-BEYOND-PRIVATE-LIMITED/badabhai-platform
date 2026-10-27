import 'dart:async';

import 'package:flutter/services.dart';
import 'package:local_auth/local_auth.dart';

/// Whether this device can present a biometric prompt at all.
enum BiometricAvailability {
  /// Biometric hardware is present AND at least one biometric is enrolled.
  available,

  /// The hardware/OS cannot present a biometric prompt (no sensor, plugin not
  /// available, permission missing, or the hosting Activity is not usable).
  unavailable,

  /// The device has biometric hardware but the worker has not enrolled a face
  /// or fingerprint (or removed it after enrolling).
  notEnrolled,
}

/// The outcome of a biometric unlock attempt.
///
/// Deliberately split from [BiometricAvailability] so the UI can tell "the
/// worker cancelled" (fall back quietly, keep the preference) from "biometrics
/// disappeared" (fall back AND turn the preference off).
enum BiometricUnlockResult {
  success,
  cancelled,
  failed,
  unavailable,
  notEnrolled,

  /// The preference is off or no service is wired — the caller should show the
  /// ordinary PIN flow and nothing else.
  notEnabled,

  /// The session could not be restored; the manager has already dropped it and
  /// the router will send the worker to phone login.
  reauthRequired,

  /// The OS confirmed the worker but the server could not be reached (transport
  /// failure / 5xx). The session is still valid: keep the preference, stay
  /// locked and let the PIN keypad be the fallback. NEVER a reason to log out.
  serverUnavailable,
}

/// The single seam over the OS biometric prompt.
///
/// Abstracted so unit/widget tests can fake success, cancel, unavailability and
/// enrollment removal WITHOUT the platform channel (which throws under
/// `flutter test`). The real implementation is [LocalAuthBiometricService].
///
/// This interface NEVER exposes biometric data — only booleans/enums. Nothing
/// here is persisted or logged (CLAUDE.md §2 / ADR-0047).
abstract interface class BiometricService {
  /// Whether a biometric prompt can be shown right now.
  Future<BiometricAvailability> availability();

  /// Present the OS prompt. [reason] is the localized reason string the OS
  /// shows (it must be non-empty).
  ///
  /// `biometricOnly: true` is set by the implementation so the device passcode
  /// can never unlock BadaBhai.
  Future<BiometricUnlockResult> authenticate({required String reason});
}

/// The real implementation, wrapping `local_auth`.
class LocalAuthBiometricService implements BiometricService {
  LocalAuthBiometricService([
    LocalAuthentication? auth,
    this.authenticateTimeout = const Duration(seconds: 60),
  ]) : _auth = auth ?? LocalAuthentication();

  final LocalAuthentication _auth;

  /// #2458 — a hung platform channel must not leave the worker trapped behind
  /// the biometric loader with the PIN keypad hidden. Unlike [availability]
  /// this is deliberately generous: a worker may genuinely take a while at the
  /// OS prompt. On timeout we report [BiometricUnlockResult.failed] and KEEP
  /// the preference, so the PIN keypad becomes the fallback again.
  final Duration authenticateTimeout;

  /// A device/probe call that never answers must NOT wedge set-PIN or a
  /// cold-start unlock. On a real handset these calls are immediate; this is a
  /// backstop for a broken plugin/OEM channel, and it is also what keeps
  /// `flutter test` (where the platform channel never answers) from hanging.
  static const Duration _availabilityTimeout = Duration(seconds: 2);

  @override
  Future<BiometricAvailability> availability() async {
    try {
      return await _probeAvailability().timeout(_availabilityTimeout);
    } on TimeoutException {
      return BiometricAvailability.unavailable;
    } on PlatformException {
      return BiometricAvailability.unavailable;
    } on MissingPluginException {
      return BiometricAvailability.unavailable;
    }
  }

  Future<BiometricAvailability> _probeAvailability() async {
    if (!await _auth.isDeviceSupported()) {
      return BiometricAvailability.unavailable;
    }
    if (!await _auth.canCheckBiometrics) {
      return BiometricAvailability.unavailable;
    }
    final List<BiometricType> enrolled = await _auth.getAvailableBiometrics();
    if (enrolled.isEmpty) return BiometricAvailability.notEnrolled;
    return BiometricAvailability.available;
  }

  @override
  Future<BiometricUnlockResult> authenticate({required String reason}) async {
    final BiometricAvailability available = await availability();
    switch (available) {
      case BiometricAvailability.unavailable:
        return BiometricUnlockResult.unavailable;
      case BiometricAvailability.notEnrolled:
        return BiometricUnlockResult.notEnrolled;
      case BiometricAvailability.available:
        break;
    }

    try {
      final bool ok = await _auth
          .authenticate(
            localizedReason: reason,
            options: const AuthenticationOptions(
              // SECURITY: the OS device passcode must NOT open BadaBhai. Only an
              // enrolled face/fingerprint may pass this local gate.
              biometricOnly: true,
              // Keep the prompt alive across a short background/foreground hop
              // (e.g. the worker checks a notification); cancelling there would
              // be a false negative that sends them back to the PIN.
              stickyAuth: true,
              useErrorDialogs: true,
            ),
          )
          .timeout(authenticateTimeout);
      return ok ? BiometricUnlockResult.success : BiometricUnlockResult.cancelled;
    } on TimeoutException {
      // The prompt never answered (broken OEM channel / wedged plugin). Keep the
      // preference: this says nothing about the enrolled biometric, and the PIN
      // is the fallback.
      return BiometricUnlockResult.failed;
    } on PlatformException catch (error) {
      switch (error.code) {
        case 'UserCancelled':
        case 'SystemCanceled':
          return BiometricUnlockResult.cancelled;
        case 'NotAvailable':
        case 'BiometricNotAvailable':
        case 'no_activity':
        case 'no_fragment_activity':
        case 'PasscodeNotSet':
          return BiometricUnlockResult.unavailable;
        case 'NotEnrolled':
          return BiometricUnlockResult.notEnrolled;
        case 'LockedOut':
        case 'PermanentlyLockedOut':
          // A lockout is not a reason to erase the worker's preference — it is
          // exactly the case the PIN fallback exists for. The preference stays
          // until the worker turns it off or the biometric is removed.
          return BiometricUnlockResult.failed;
        case 'auth_in_progress':
        default:
          return BiometricUnlockResult.failed;
      }
    } on MissingPluginException {
      return BiometricUnlockResult.unavailable;
    }
  }
}
