import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../domain/auth_repository.dart';

enum OtpVerifyStatus { initial, submitting, success, failure }

class OtpVerifyState extends Equatable {
  const OtpVerifyState({
    this.status = OtpVerifyStatus.initial,
    this.message,
  });

  final OtpVerifyStatus status;
  final String? message;

  bool get isSubmitting => status == OtpVerifyStatus.submitting;

  OtpVerifyState copyWith({OtpVerifyStatus? status, String? message}) {
    return OtpVerifyState(
      status: status ?? this.status,
      message: message ?? this.message,
    );
  }

  @override
  List<Object?> get props => <Object?>[status, message];
}

/// Drives OTP verification. On success the repository has already written the
/// worker + bearer token into the session; the screen reacts by routing to
/// consent.
class OtpVerifyCubit extends Cubit<OtpVerifyState> {
  OtpVerifyCubit(this._repo) : super(const OtpVerifyState());

  final AuthRepository _repo;

  Future<void> verify({required String phone, required String otp}) async {
    if (state.isSubmitting) return;
    emit(state.copyWith(status: OtpVerifyStatus.submitting));
    try {
      await _repo.verifyOtp(phoneE164: phone, otp: otp);
      if (isClosed) return;
      emit(state.copyWith(status: OtpVerifyStatus.success));
    } on Failure catch (failure) {
      if (isClosed) return;
      emit(state.copyWith(
        status: OtpVerifyStatus.failure,
        message: failure.message,
      ));
    }
  }
}
