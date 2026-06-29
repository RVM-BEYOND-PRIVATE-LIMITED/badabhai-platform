import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/auth/auth_error_messages.dart';
import '../../../../core/auth/auth_failure.dart';
import '../../domain/auth_session_manager.dart';

enum EnterPinStatus { idle, submitting, done, invalid, locked, failure }

class EnterPinState extends Equatable {
  const EnterPinState({
    this.status = EnterPinStatus.idle,
    this.message,
    this.lockedUntilSeconds,
  });

  final EnterPinStatus status;
  final String? message;

  /// When [status] is [EnterPinStatus.locked], the countdown (seconds) before
  /// entry is allowed again — drives the disabled keypad + countdown copy.
  final int? lockedUntilSeconds;

  bool get isSubmitting => status == EnterPinStatus.submitting;
  bool get isLocked => status == EnterPinStatus.locked;

  EnterPinState copyWith({
    EnterPinStatus? status,
    String? message,
    int? lockedUntilSeconds,
  }) =>
      EnterPinState(
        status: status ?? this.status,
        message: message,
        lockedUntilSeconds: lockedUntilSeconds,
      );

  @override
  List<Object?> get props => <Object?>[status, message, lockedUntilSeconds];
}

/// Drives enter-PIN (unlock). Holds NO PIN: [unlock] receives the assembled PIN,
/// forwards it to [AuthSessionManager.unlockWithPin], and drops it.
///
/// On [AuthErrorCode.pinInvalid] it surfaces attempts-left copy; on
/// [AuthErrorCode.pinLocked] it surfaces a countdown + flags the keypad disabled.
/// On success the manager authenticates and the router opens the shell.
class EnterPinCubit extends Cubit<EnterPinState> {
  EnterPinCubit(this._manager, {String locale = 'hi'})
      : _locale = locale,
        super(const EnterPinState());

  final AuthSessionManager _manager;
  final String _locale;

  Future<void> unlock(String pin) async {
    if (state.isSubmitting || state.isLocked) return;
    emit(const EnterPinState(status: EnterPinStatus.submitting));
    try {
      await _manager.unlockWithPin(pin);
      if (isClosed) return;
      emit(const EnterPinState(status: EnterPinStatus.done));
    } on AuthFailure catch (failure) {
      if (isClosed) return;
      emit(_mapFailure(failure));
    }
  }

  EnterPinState _mapFailure(AuthFailure failure) {
    final String message = authErrorMessage(failure, _locale);
    switch (failure.code) {
      case AuthErrorCode.pinLocked:
        return EnterPinState(
          status: EnterPinStatus.locked,
          message: message,
          lockedUntilSeconds: failure.retryAfter?.inSeconds,
        );
      case AuthErrorCode.pinInvalid:
        return EnterPinState(status: EnterPinStatus.invalid, message: message);
      default:
        return EnterPinState(status: EnterPinStatus.failure, message: message);
    }
  }
}
