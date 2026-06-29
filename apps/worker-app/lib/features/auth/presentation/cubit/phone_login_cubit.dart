import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/auth/auth_error_messages.dart';
import '../../../../core/auth/auth_failure.dart';
import '../../domain/auth_session_manager.dart';

enum PhoneLoginStatus { initial, submitting, success, failure }

class PhoneLoginState extends Equatable {
  const PhoneLoginState({
    this.status = PhoneLoginStatus.initial,
    this.phone,
    this.message,
  });

  final PhoneLoginStatus status;

  /// The submitted phone, carried so the screen can pass it to the OTP route.
  final String? phone;
  final String? message;

  bool get isSubmitting => status == PhoneLoginStatus.submitting;

  PhoneLoginState copyWith({
    PhoneLoginStatus? status,
    String? phone,
    String? message,
  }) {
    return PhoneLoginState(
      status: status ?? this.status,
      phone: phone ?? this.phone,
      message: message,
    );
  }

  @override
  List<Object?> get props => <Object?>[status, phone, message];
}

/// Drives the phone-entry screen: a single OTP request through
/// [AuthSessionManager] (so the call carries `X-Device-Id` / `X-Locale` via the
/// interceptor). On an [AuthFailure] (e.g. OTP_RATE_LIMITED) it surfaces the
/// localized copy.
class PhoneLoginCubit extends Cubit<PhoneLoginState> {
  PhoneLoginCubit(this._manager, {String locale = 'hi'})
      : _locale = locale,
        super(const PhoneLoginState());

  final AuthSessionManager _manager;
  final String _locale;

  Future<void> submit(String phoneE164) async {
    if (state.isSubmitting) return;
    emit(state.copyWith(status: PhoneLoginStatus.submitting, phone: phoneE164));
    try {
      await _manager.requestOtp(phoneE164);
      if (isClosed) return;
      emit(state.copyWith(status: PhoneLoginStatus.success, phone: phoneE164));
    } on AuthFailure catch (failure) {
      if (isClosed) return;
      emit(state.copyWith(
        status: PhoneLoginStatus.failure,
        message: authErrorMessage(failure, _locale),
      ));
    }
  }
}
