import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/auth/auth_error_messages.dart';
import '../../../../core/auth/auth_failure.dart';
import '../../domain/auth_session_manager.dart';

enum EnterPinStatus { idle, submitting, done, failure }

class EnterPinState extends Equatable {
  const EnterPinState({
    this.status = EnterPinStatus.idle,
    this.message,
    this.suggestForgot = false,
  });

  final EnterPinStatus status;
  final String? message;

  /// True once the worker has soft-failed enough times (≥3) that the screen
  /// should emphasize the "PIN bhool gaye?" link. Purely client-side — the
  /// backend gives one NEUTRAL 401 per failure with no attempts/lockout.
  final bool suggestForgot;

  bool get isSubmitting => status == EnterPinStatus.submitting;

  @override
  List<Object?> get props => <Object?>[status, message, suggestForgot];
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
  EnterPinCubit(this._manager, {String locale = 'hi'})
      : _locale = locale,
        super(const EnterPinState());

  final AuthSessionManager _manager;
  final String _locale;

  /// After this many client-side soft fails, suggest forgot-PIN.
  static const int _forgotThreshold = 3;

  int _failCount = 0;

  Future<void> unlock(String pin) async {
    if (state.isSubmitting) return;
    emit(EnterPinState(
      status: EnterPinStatus.submitting,
      suggestForgot: state.suggestForgot,
    ));
    try {
      await _manager.unlockWithPin(pin);
      if (isClosed) return;
      emit(const EnterPinState(status: EnterPinStatus.done));
    } on AuthFailure catch (failure) {
      if (isClosed) return;
      _failCount++;
      emit(EnterPinState(
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
      emit(EnterPinState(
        status: EnterPinStatus.failure,
        message: authErrorMessage(
            const AuthFailure(AuthErrorCode.unknown), _locale),
        suggestForgot: state.suggestForgot,
      ));
    }
  }
}
