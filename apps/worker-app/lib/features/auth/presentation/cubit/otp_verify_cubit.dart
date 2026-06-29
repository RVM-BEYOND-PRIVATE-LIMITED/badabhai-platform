import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/auth/auth_error_messages.dart';
import '../../../../core/auth/auth_failure.dart';
import '../../domain/auth_session_manager.dart';

enum OtpVerifyStatus { initial, submitting, success, failure }

/// Where the OTP-verify success routes next, derived from the verify flags.
///
///  - [setPin]    — new user or `pin_set=false`: must choose a PIN first.
///  - [authenticated] — returning worker with a PIN: straight into the app.
enum OtpNext { setPin, authenticated }

class OtpVerifyState extends Equatable {
  const OtpVerifyState({
    this.status = OtpVerifyStatus.initial,
    this.message,
    this.next,
  });

  final OtpVerifyStatus status;
  final String? message;

  /// Set on success — the screen routes off this (set-PIN vs straight in).
  final OtpNext? next;

  bool get isSubmitting => status == OtpVerifyStatus.submitting;

  OtpVerifyState copyWith({
    OtpVerifyStatus? status,
    String? message,
    OtpNext? next,
  }) {
    return OtpVerifyState(
      status: status ?? this.status,
      message: message,
      next: next ?? this.next,
    );
  }

  @override
  List<Object?> get props => <Object?>[status, message, next];
}

/// Drives OTP verification through [AuthSessionManager]. On success the manager
/// has persisted tokens + bridged them into the legacy session; this cubit
/// exposes the routing flag (set-PIN vs authenticated) for the screen.
class OtpVerifyCubit extends Cubit<OtpVerifyState> {
  OtpVerifyCubit(this._manager, {String locale = 'hi'})
      : _locale = locale,
        super(const OtpVerifyState());

  final AuthSessionManager _manager;
  final String _locale;

  Future<void> verify({required String phone, required String otp}) async {
    if (state.isSubmitting) return;
    emit(state.copyWith(status: OtpVerifyStatus.submitting));
    try {
      final result = await _manager.verifyOtp(phone, otp);
      if (isClosed) return;
      final OtpNext next = (result.pinSet && !result.isNewUser)
          ? OtpNext.authenticated
          : OtpNext.setPin;
      emit(state.copyWith(status: OtpVerifyStatus.success, next: next));
    } on AuthFailure catch (failure) {
      if (isClosed) return;
      emit(state.copyWith(
        status: OtpVerifyStatus.failure,
        message: authErrorMessage(failure, _locale),
      ));
    }
  }
}
