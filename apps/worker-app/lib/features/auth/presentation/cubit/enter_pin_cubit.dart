import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/auth/auth_error_messages.dart';
import '../../../../core/auth/auth_failure.dart';
import '../../../../core/auth/biometric_service.dart';
import '../../domain/auth_session_manager.dart';

enum EnterPinStatus { idle, submitting, done, failure }

class EnterPinState extends Equatable {
  const EnterPinState({
    this.status = EnterPinStatus.idle,
    this.message,
    this.suggestForgot = false,
    this.biometricEnabled = false,
    this.biometricInFlight = false,
    this.biometricResult,
  });

  final EnterPinStatus status;
  final String? message;

  /// True once the worker has soft-failed enough times (≥3) that the screen
  /// should emphasize the "PIN bhool gaye?" link. Purely client-side — the
  /// backend gives one NEUTRAL 401 per failure with no attempts/lockout.
  final bool suggestForgot;

  /// #2451 — offer the biometric CTA. False for a worker who never opted in, in
  /// which case this screen is exactly the PIN-only flow it was before.
  final bool biometricEnabled;

  /// True while the OS prompt and/or the post-success refresh is in flight. The
  /// keypad is swapped for the loader, so a double tap cannot stack prompts.
  final bool biometricInFlight;

  /// Set when the last biometric attempt did not unlock, so the screen can show
  /// one short neutral hint and leave the PIN keypad untouched. Cleared on the
  /// next PIN or biometric attempt.
  final BiometricUnlockResult? biometricResult;

  bool get isSubmitting => status == EnterPinStatus.submitting;

  EnterPinState copyWith({
    EnterPinStatus? status,
    String? message,
    bool? suggestForgot,
    bool? biometricEnabled,
    bool? biometricInFlight,
    BiometricUnlockResult? biometricResult,
    bool clearMessage = false,
    bool clearBiometricResult = false,
  }) {
    return EnterPinState(
      status: status ?? this.status,
      message: clearMessage ? null : (message ?? this.message),
      suggestForgot: suggestForgot ?? this.suggestForgot,
      biometricEnabled: biometricEnabled ?? this.biometricEnabled,
      biometricInFlight: biometricInFlight ?? this.biometricInFlight,
      biometricResult:
          clearBiometricResult ? null : (biometricResult ?? this.biometricResult),
    );
  }

  @override
  List<Object?> get props => <Object?>[
        status,
        message,
        suggestForgot,
        biometricEnabled,
        biometricInFlight,
        biometricResult,
      ];
}

/// Drives enter-PIN (unlock). Holds NO PIN: [unlock] receives the assembled PIN,
/// forwards it to [AuthSessionManager.unlockWithPin], and drops it.
///
/// The real backend returns one NEUTRAL 401 on every PIN failure (no oracle, no
/// attempts-left, no retry-after), so there is NO countdown / lockout UI: every
/// failure surfaces the same neutral copy. A client-side soft-fail counter flips
/// [EnterPinState.suggestForgot] after [_forgotThreshold] tries so the screen can
/// nudge toward the forgot-PIN flow. On success the manager authenticates and the
/// router opens the shell.
class EnterPinCubit extends Cubit<EnterPinState> {
  EnterPinCubit(
    this._manager, {
    String locale = 'hi',
    bool biometricEnabled = false,
  })  : _locale = locale,
        super(EnterPinState(biometricEnabled: biometricEnabled));

  final AuthSessionManager _manager;
  final String _locale;

  /// After this many client-side soft fails, suggest forgot-PIN.
  static const int _forgotThreshold = 3;

  int _failCount = 0;

  Future<void> unlock(String pin) async {
    if (state.isSubmitting || state.biometricInFlight) return;
    emit(state.copyWith(
      status: EnterPinStatus.submitting,
      biometricInFlight: false,
      clearMessage: true,
      clearBiometricResult: true,
    ));
    try {
      await _manager.unlockWithPin(pin);
      if (isClosed) return;
      emit(state.copyWith(status: EnterPinStatus.done));
    } on AuthFailure catch (failure) {
      if (isClosed) return;
      // Account deleted server-side (410 WORKER_ACCOUNT_DELETED): the app-root
      // AccountDeletedSignal already shows the ONE non-dismissible dialog and
      // hard-logs-out. Do NOT also raise this screen's local "PIN sahi nahi"
      // dialog — two stacked dialogs meant the first OK dismissed the wrong one
      // and did not log out (the worker had to tap OK twice). Just leave the
      // submitting state (do not count it as a PIN fail); the global flow drives
      // the exit to login.
      if (failure.isAccountDeleted) {
        emit(state.copyWith(status: EnterPinStatus.idle));
        return;
      }
      _failCount++;
      emit(state.copyWith(
        status: EnterPinStatus.failure,
        message: authErrorMessage(failure, _locale),
        suggestForgot: _failCount >= _forgotThreshold,
      ));
    } catch (_) {
      // #367 — catching ONLY AuthFailure left a hole that locks the worker out
      // of their own app. `submitting` is exited nowhere but this try/catch, and
      // `isSubmitting` blocks re-entry, so anything else thrown here (a
      // PlatformException from the Keystore-backed secure store is the realistic
      // one) left the cubit stuck in `submitting` FOREVER: a dead spinner, and
      // every retry tap swallowed by the guard. Unlike a wrong PIN this is not
      // the worker's fault, so it does NOT count toward _failCount / the
      // forgot-PIN nudge — it just has to be recoverable.
      if (isClosed) return;
      emit(state.copyWith(
        status: EnterPinStatus.failure,
        message: authErrorMessage(
            const AuthFailure(AuthErrorCode.unknown), _locale),
        suggestForgot: state.suggestForgot,
      ));
    }
  }

  /// #2451 — the biometric entry point for this screen.
  ///
  /// The manager owns the security decision (local gate → persisted refresh
  /// token → the SAME refresh path as the PIN). This cubit only maps its result
  /// to UI state: success ends in [EnterPinStatus.done] and the ROUTER owns
  /// navigation exactly as it does after a PIN success, so there is never a
  /// second post-unlock navigation owner. A cancel/failure returns to the PIN
  /// keypad with one neutral hint and does NOT count as a PIN attempt.
  Future<void> biometricUnlock() async {
    if (!state.biometricEnabled ||
        state.isSubmitting ||
        state.biometricInFlight) {
      return;
    }
    emit(state.copyWith(
      biometricInFlight: true,
      clearBiometricResult: true,
    ));
    BiometricUnlockResult result;
    try {
      result = await _manager.unlockWithBiometric();
    } catch (_) {
      result = BiometricUnlockResult.failed;
    }
    if (isClosed) return;
    switch (result) {
      case BiometricUnlockResult.success:
      case BiometricUnlockResult.reauthRequired:
        emit(state.copyWith(
          status: EnterPinStatus.done,
          biometricInFlight: false,
          biometricResult: result,
        ));
      case BiometricUnlockResult.unavailable:
      case BiometricUnlockResult.notEnrolled:
        // The biometric disappeared since enrollment (or is no longer usable):
        // the manager already turned the preference off. Drop the CTA and go
        // back to the PIN-only screen.
        emit(state.copyWith(
          biometricEnabled: false,
          biometricInFlight: false,
          biometricResult: result,
        ));
      case BiometricUnlockResult.notEnabled:
        emit(state.copyWith(
          biometricEnabled: false,
          biometricInFlight: false,
          biometricResult: result,
        ));
      case BiometricUnlockResult.cancelled:
      case BiometricUnlockResult.failed:
      case BiometricUnlockResult.serverUnavailable:
        // The local identity is still valid (or the prompt failed); the PIN
        // keypad stays the fallback and the preference is untouched.
        emit(state.copyWith(
          biometricInFlight: false,
          biometricResult: result,
        ));
    }
  }
}
