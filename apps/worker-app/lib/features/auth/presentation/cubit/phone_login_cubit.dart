import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../domain/auth_repository.dart';

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
      message: message ?? this.message,
    );
  }

  @override
  List<Object?> get props => <Object?>[status, phone, message];
}

/// Drives the phone-entry screen: a single fire-and-forget OTP request.
class PhoneLoginCubit extends Cubit<PhoneLoginState> {
  PhoneLoginCubit(this._repo) : super(const PhoneLoginState());

  final AuthRepository _repo;

  Future<void> submit(String phoneE164) async {
    if (state.isSubmitting) return;
    emit(state.copyWith(status: PhoneLoginStatus.submitting, phone: phoneE164));
    try {
      await _repo.requestOtp(phoneE164);
      if (isClosed) return;
      emit(state.copyWith(status: PhoneLoginStatus.success, phone: phoneE164));
    } on Failure catch (failure) {
      if (isClosed) return;
      emit(state.copyWith(
        status: PhoneLoginStatus.failure,
        message: failure.message,
      ));
    }
  }
}
